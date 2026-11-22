# French Company Due Diligence & Risk Score (SIREN / SIRET)

Get a **complete due-diligence report for any French company in one call**: legal identity, directors, financials, official labels, **BODACC legal notices (insolvency, receivership, liquidation)** and a **transparent risk score from 0 to 100**.

Built only on **official French open data** (no scraping of protected websites, no proxies, no login), so it's fast, cheap and reliable.

## Why use it?

Existing tools give you *one* raw source. This Actor merges them and does the analysis for you:

| You get | Source |
|---|---|
| Name, legal form, NAF code, creation date, status (active/closed), headcount range, headquarters address + GPS | SIRENE via API Recherche d'entreprises |
| Directors (people and companies) | RNE via API Recherche d'entreprises |
| Revenue & net income by year (when published) | API Recherche d'entreprises |
| Labels: RGE, Qualiopi, ESS, organic, collective agreements | API Recherche d'entreprises |
| Insolvency proceedings, liquidations, struck-off, modifications, accounts filings | BODACC |
| **Risk score + human-readable reasons** | Computed by this Actor |

## Use cases

- **KYC / supplier onboarding**: check a supplier or client before signing.
- **Credit & collections**: spot receiverships and liquidations before chasing an invoice.
- **Portfolio monitoring**: schedule a weekly run on your client list with `onlyRiskAbove: 25` and only get alerts.
- **Sales prospecting**: enrich a lead list with size, age, directors and financial health.
- **AI agents**: one clean JSON object per company, ideal for LLM tools and MCP.

## Input

```json
{
  "sirens": ["552032534", "542 051 180", "55203253400646"],
  "companyNames": ["Doctolib"],
  "includeBodacc": true,
  "onlyRiskAbove": 0
}
```

SIRET numbers are accepted (the SIREN is extracted). Invalid numbers are skipped and **not charged**.

## Output (simplified)

```json
{
  "siren": "552032534",
  "name": "DANONE",
  "status": "ACTIVE",
  "createdOn": "1955-01-01",
  "nafCode": "70.10Z",
  "directors": [{ "type": "person", "name": "…", "role": "Directeur général" }],
  "finances": [{ "year": 2024, "revenue": 0, "netIncome": 0 }],
  "labels": { "rge": false, "qualiopi": false },
  "bodacc": { "totalNotices": 42, "collectiveProcedures": [], "latest": [ … ] },
  "risk": {
    "score": 0,
    "level": "LOW",
    "signals": []
  }
}
```

## How the risk score works

Points are added for each signal found (capped at 100): closed company (100), liquidation in the last 5 years (70), receivership (45), safeguard (30), struck-off notice (30), conciliation (20), company younger than 1 year (20) or 3 years (10), ≥3 modifications in 12 months (10), net loss (10), revenue drop > 30 % (10), outdated or missing accounts (5–10).

**LOW** < 25 ≤ **MEDIUM** < 60 ≤ **HIGH**. Every point is explained in `risk.signals`, so you stay in control.

## Pricing

Pay per event: you only pay for **successful company reports**. Companies not found, invalid inputs and reports filtered out by `onlyRiskAbove` are free.

## Notes

- Data comes from public registers and may lag the official publication by a few days.
- The risk score is an automated indicator, not financial or legal advice.
- Personal data of directors is published by the French State as open data. Use it in compliance with GDPR.
