import { Actor, log } from 'apify';
import {
    normalizeSiren, isValidSiren, fetchSirene, fetchBodacc, buildReport, searchCompanies,
    snapshotOf, diffSnapshots, monitorStoreName,
} from './lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    sirens = [],
    companyNames = [],
    includeBodacc = true,
    maxBodaccNotices = 100,
    onlyRiskAbove = 0,
    monitorMode = false,
    monitorName = 'default',
} = input;

const opts = { log: (m) => log.warning(m) };

// 1. Resolve the list of SIRENs
const targets = new Set();
const invalid = [];
for (const raw of sirens) {
    const s = normalizeSiren(raw);
    if (s && isValidSiren(s)) targets.add(s);
    else invalid.push(raw);
}
for (const name of companyNames) {
    try {
        const [best] = await searchCompanies(name, { ...opts, perPage: 1 });
        if (best?.siren) targets.add(best.siren);
        else invalid.push(name);
    } catch (e) {
        log.warning(`Name lookup failed for "${name}": ${e.message}`);
        invalid.push(name);
    }
    await sleep(200);
}
if (invalid.length) log.warning(`Ignored ${invalid.length} invalid/unknown inputs: ${invalid.slice(0, 20).join(', ')}`);

if (targets.size === 0) {
    await Actor.fail('No valid SIREN/SIRET or resolvable company name in input.');
}

log.info(`Building due-diligence reports for ${targets.size} companies...`);

// Monitoring mode: snapshots persisted in a named key-value store in the user's account
let monitorStore = null;
let snapshots = {};
if (monitorMode) {
    monitorStore = await Actor.openKeyValueStore(monitorStoreName(monitorName));
    snapshots = (await monitorStore.getValue('snapshots')) ?? {};
    log.info(`Monitoring mode: ${Object.keys(snapshots).length} companies already tracked in "${monitorStoreName(monitorName)}".`);
}

let produced = 0;
for (const siren of targets) {
    try {
        const company = await fetchSirene(siren, opts);
        if (!company) {
            log.warning(`SIREN ${siren} not found in the public register.`);
            await Actor.pushData({ siren, error: 'NOT_FOUND' });
            continue;
        }
        const rawNotices = includeBodacc ? await fetchBodacc(siren, { ...opts, limit: maxBodaccNotices }) : [];
        const report = buildReport({ siren, company, rawNotices });
        if (monitorMode) {
            const snap = snapshotOf(report);
            const changes = diffSnapshots(snapshots[siren], snap);
            snapshots[siren] = snap;
            if (changes.length === 0) continue; // unchanged → not output, not charged
            report.changes = changes;
        }
        if (report.risk.score < onlyRiskAbove) continue;

        await Actor.pushData(report);
        produced++;
        // Pay-per-event: one charge per successful report (event configured in Apify Console)
        const res = await Actor.charge({ eventName: 'company-report', count: 1 });
        if (res?.eventChargeLimitReached) {
            log.info('Max charge set by the user reached, stopping.');
            break;
        }
    } catch (e) {
        log.error(`Failed for ${siren}: ${e.message}`);
        await Actor.pushData({ siren, error: e.message });
    }
    await sleep(150); // stay well under the public API rate limit (7 req/s)
}

if (monitorStore) await monitorStore.setValue('snapshots', snapshots);
log.info(`Done. ${produced} reports produced.`);
await Actor.exit();
