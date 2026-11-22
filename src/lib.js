// Pure logic: API calls (with injectable fetch) + report building + risk scoring.
// Data sources (free, official, no API key):
//  - API Recherche d'entreprises (DINUM): https://recherche-entreprises.api.gouv.fr
//  - BODACC (DILA, OpenDataSoft): https://bodacc-datadila.opendatasoft.com

export const SIRENE_API = 'https://recherche-entreprises.api.gouv.fr/search';
export const BODACC_API =
    'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeSiren(raw) {
    if (raw === undefined || raw === null) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 14) return digits.slice(0, 9); // SIRET -> SIREN
    if (digits.length === 9) return digits;
    return null;
}

export function isValidSiren(siren) {
    if (!/^\d{9}$/.test(siren)) return false;
    // Luhn checksum (La Poste SIREN 356000000 is a known exception)
    if (siren === '356000000') return true;
    let sum = 0;
    for (let i = 0; i < 9; i++) {
        let d = Number(siren[8 - i]);
        if (i % 2 === 1) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
    }
    return sum % 10 === 0;
}

export async function fetchJson(url, { fetchImpl = fetch, retries = 4, log = () => {} } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
            if (res.status === 429 || res.status >= 500) {
                lastErr = new Error(`HTTP ${res.status} for ${url}`);
                await sleep(1000 * 2 ** attempt);
                continue;
            }
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                const err = new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
                err.status = res.status;
                throw err;
            }
            return await res.json();
        } catch (e) {
            if (e.status && e.status < 500 && e.status !== 429) throw e;
            lastErr = e;
            log(`Retry ${attempt + 1}/${retries} after error: ${e.message}`);
            await sleep(1000 * 2 ** attempt);
        }
    }
    throw lastErr;
}

export async function searchCompanies(query, opts = {}) {
    const url = `${SIRENE_API}?q=${encodeURIComponent(query)}&per_page=${opts.perPage ?? 5}&page=1`;
    const data = await fetchJson(url, opts);
    return data.results ?? [];
}

export async function fetchSirene(siren, opts = {}) {
    const results = await searchCompanies(siren, { ...opts, perPage: 5 });
    return results.find((r) => r.siren === siren) ?? null;
}

export async function fetchBodacc(siren, { limit = 100, ...opts } = {}) {
    const spaced = `${siren.slice(0, 3)} ${siren.slice(3, 6)} ${siren.slice(6)}`;
    const strategies = [
        `registre="${siren}"`,
        `registre="${spaced}"`,
        `"${siren}"`, // ODSQL full-text search fallback
    ];
    for (const where of strategies) {
        const url = `${BODACC_API}?where=${encodeURIComponent(where)}&order_by=${encodeURIComponent(
            'dateparution desc',
        )}&limit=${Math.min(limit, 100)}`;
        try {
            const data = await fetchJson(url, opts);
            const records = (data.results ?? []).filter((r) => matchesSiren(r, siren));
            if (records.length > 0) return records;
        } catch (e) {
            if (opts.log) opts.log(`BODACC strategy failed (${where}): ${e.message}`);
        }
    }
    return [];
}

function matchesSiren(record, siren) {
    const reg = record.registre;
    const list = Array.isArray(reg) ? reg : reg ? [reg] : [];
    return list.some((v) => String(v).replace(/\D/g, '') === siren);
}

function parseMaybeJson(v) {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try {
        return JSON.parse(v);
    } catch {
        return null;
    }
}

export function simplifyBodacc(record) {
    const jugement = parseMaybeJson(record.jugement);
    return {
        date: record.dateparution ?? null,
        family: record.familleavis_lib ?? record.familleavis ?? null,
        type: record.typeavis_lib ?? record.typeavis ?? null,
        court: record.tribunal ?? null,
        judgment: jugement
            ? {
                  nature: jugement.nature ?? null,
                  date: jugement.date ?? null,
                  details: jugement.complementJugement ?? null,
              }
            : null,
        url: record.url_complete ?? null,
    };
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export function yearsBetween(dateStr, now = new Date()) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    return (now.getTime() - d.getTime()) / YEAR_MS;
}

export function latestFinances(finances) {
    if (!finances || typeof finances !== 'object') return [];
    return Object.entries(finances)
        .map(([year, v]) => ({ year: Number(year), revenue: v?.ca ?? null, netIncome: v?.resultat_net ?? null }))
        .filter((f) => !Number.isNaN(f.year))
        .sort((a, b) => b.year - a.year);
}

/**
 * Risk score 0 (no signal) .. 100 (very high risk). Transparent, rule-based.
 */
export function computeRisk({ company, notices, now = new Date() }) {
    const signals = [];
    const add = (points, code, message) => signals.push({ points, code, message });

    if (company.etat_administratif === 'C') {
        add(100, 'CLOSED', `Entreprise cessée${company.date_fermeture ? ` le ${company.date_fermeture}` : ''}`);
    }

    const collective = notices.filter((n) => /proc[ée]dures? collectives?/i.test(n.family ?? ''));
    const recentCollective = collective.filter((n) => (yearsBetween(n.date, now) ?? 99) <= 5);
    for (const n of recentCollective) {
        const nature = `${n.judgment?.nature ?? ''} ${n.type ?? ''}`.toLowerCase();
        if (nature.includes('liquidation')) add(70, 'LIQUIDATION', `Liquidation judiciaire publiée au BODACC le ${n.date}`);
        else if (nature.includes('redressement')) add(45, 'RECEIVERSHIP', `Redressement judiciaire publié le ${n.date}`);
        else if (nature.includes('sauvegarde')) add(30, 'SAFEGUARD', `Procédure de sauvegarde publiée le ${n.date}`);
        else if (/cl[ôo]ture/.test(nature)) add(10, 'PROCEDURE_CLOSED', `Clôture de procédure publiée le ${n.date}`);
        else add(25, 'COLLECTIVE_PROCEDURE', `Procédure collective publiée le ${n.date}`);
    }
    const conciliation = notices.filter((n) => /conciliation|r[ée]tablissement/i.test(n.family ?? ''));
    if (conciliation.some((n) => (yearsBetween(n.date, now) ?? 99) <= 3)) {
        add(20, 'CONCILIATION', 'Procédure de conciliation ou de rétablissement professionnel récente');
    }

    const radiation = notices.find((n) => /radiation/i.test(n.family ?? ''));
    if (radiation && company.etat_administratif !== 'C') add(30, 'STRUCK_OFF', `Avis de radiation publié le ${radiation.date}`);

    const age = yearsBetween(company.date_creation, now);
    if (age !== null && age < 1) add(20, 'VERY_YOUNG', `Entreprise créée il y a moins d'un an (${company.date_creation})`);
    else if (age !== null && age < 3) add(10, 'YOUNG', `Entreprise créée il y a moins de 3 ans (${company.date_creation})`);

    const modifs12m = notices.filter(
        (n) => /modifications?/i.test(n.family ?? '') && (yearsBetween(n.date, now) ?? 99) <= 1,
    ).length;
    if (modifs12m >= 3) add(10, 'FREQUENT_CHANGES', `${modifs12m} modifications publiées au BODACC sur 12 mois`);

    const fin = latestFinances(company.finances);
    if (fin.length > 0) {
        const last = fin[0];
        if (last.netIncome !== null && last.netIncome < 0) add(10, 'NET_LOSS', `Résultat net négatif en ${last.year}`);
        if (fin.length > 1 && last.revenue && fin[1].revenue && last.revenue < fin[1].revenue * 0.7) {
            add(10, 'REVENUE_DROP', `Chiffre d'affaires en baisse de plus de 30 % (${fin[1].year} → ${last.year})`);
        }
        if ((yearsBetween(`${last.year}-12-31`, now) ?? 0) > 3) add(5, 'OLD_ACCOUNTS', `Derniers comptes publics datant de ${last.year}`);
    }

    const accountsFiled = notices.filter((n) => /d[ée]p[ôo]ts? des comptes/i.test(n.family ?? ''));
    const isCompanyForm = company.nature_juridique && !String(company.nature_juridique).startsWith('1');
    if (isCompanyForm && age !== null && age > 3 && accountsFiled.length === 0 && fin.length === 0) {
        add(10, 'NO_ACCOUNTS', 'Aucun dépôt de comptes visible (BODACC ni données financières)');
    }

    const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
    const level = score >= 60 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW';
    return { score, level, signals };
}

export function buildReport({ siren, company, rawNotices, now = new Date() }) {
    const notices = rawNotices.map(simplifyBodacc).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const siege = company.siege ?? {};
    const comp = company.complements ?? {};
    const finances = latestFinances(company.finances);
    const risk = computeRisk({ company, notices, now });

    return {
        siren,
        name: company.nom_complet ?? company.nom_raison_sociale ?? null,
        status: company.etat_administratif === 'C' ? 'CLOSED' : 'ACTIVE',
        closedOn: company.date_fermeture ?? null,
        createdOn: company.date_creation ?? null,
        ageYears: (() => {
            const a = yearsBetween(company.date_creation, now);
            return a === null ? null : Math.round(a * 10) / 10;
        })(),
        legalForm: company.nature_juridique ?? null,
        category: company.categorie_entreprise ?? null,
        nafCode: company.activite_principale ?? null,
        activitySection: company.section_activite_principale ?? null,
        headcountRange: company.tranche_effectif_salarie ?? null,
        establishments: {
            total: company.nombre_etablissements ?? null,
            open: company.nombre_etablissements_ouverts ?? null,
        },
        headquarters: {
            siret: siege.siret ?? null,
            address: siege.adresse ?? null,
            postalCode: siege.code_postal ?? null,
            city: siege.libelle_commune ?? null,
            latitude: siege.latitude ? Number(siege.latitude) : null,
            longitude: siege.longitude ? Number(siege.longitude) : null,
        },
        directors: (company.dirigeants ?? []).map((d) =>
            d.type_dirigeant === 'personne morale'
                ? { type: 'company', name: d.denomination ?? null, siren: d.siren ?? null, role: d.qualite ?? null }
                : {
                      type: 'person',
                      name: [d.prenoms, d.nom].filter(Boolean).join(' ') || null,
                      role: d.qualite ?? null,
                  },
        ),
        finances,
        labels: {
            rge: comp.est_rge ?? null,
            qualiopi: comp.est_qualiopi ?? null,
            ess: comp.est_ess ?? null,
            organic: comp.est_bio ?? null,
            soleTrader: comp.est_entrepreneur_individuel ?? null,
            publicService: comp.est_service_public ?? null,
            collectiveAgreements: comp.liste_idcc ?? [],
        },
        bodacc: {
            totalNotices: notices.length,
            collectiveProcedures: notices.filter((n) => /proc[ée]dures? collectives?/i.test(n.family ?? '')),
            latest: notices.slice(0, 10),
        },
        risk,
        sources: ['API Recherche d’entreprises (DINUM)', 'BODACC (DILA)'],
        generatedAt: now.toISOString(),
    };
}
