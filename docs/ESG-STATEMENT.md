# UMBRAXON KYA-Hub — Environmental, Social, and Governance (ESG) Statement

**Template version:** 2026-05-12 (Strategic Sprint §30 Item 12)
**Last regenerated:** _replace by `scripts/esg-report.js` output footer_
**Hub operator:** UMBRAXON s.r.o.
**Auditor scope:** the KYA-Hub identity service running at
`https://hub.umbraxon.xyz` and all server-side dependencies it owns.

---

This document is the **template** B2B partners (insurers, exchanges,
regulators, larger SaaS customers) request as part of their vendor
onboarding. It is auto-regenerated yearly by
`scripts/esg-report.js` using the historical kWh / network data
collected by Netdata; this Markdown file is checked in to source
control and updated by hand only when policies (not numbers) change.

---

## 1. Operating model summary

UMBRAXON operates a **non-custodial identity service** for autonomous
agents. We never custody user funds outside of micro-payments for
certificate issuance (median payment ≈ 3 000 sats ≈ €1) which clear
within seconds via the Lightning Network. We do not run
proof-of-work mining, do not stake third-party assets, and do not
issue any token. Our on-chain footprint is limited to:

- Tier ELITE: one OP_RETURN-only (`KYA1` / `KYAR`) transaction at
  certificate issuance time, ~250 vbytes, ~2 000 sats fee (varies
  with mempool).
- Phase 5 CRL: one OP_RETURN anchor per CRL epoch (24 h), ~250 vbytes.

Median daily on-chain footprint as of 2026-05-12: **<2 OP_RETURN tx**.

## 2. Environmental (E)

### 2.1 Data-centre energy mix

**Provider:** Hetzner Online GmbH, Falkenstein/Helsinki/Nuremberg DCs
(EU jurisdiction).
**Renewable claim:** 100% renewable electricity sourced for all
Hetzner data centers since 2017 — verified via [Hetzner's official
sustainability page](https://www.hetzner.com/unternehmen/umweltschutz/)
and TÜV-certified renewable-source guarantees of origin.
**Verified by us:** annual document review during Q1 of each calendar
year. Last review: **2026-01-15**. Source PDF archived under
`docs/audits/hetzner-renewable-2026.pdf` (operator-only).

### 2.2 Estimated power consumption

Our infrastructure is **one (1) AX52 dedicated bare-metal server**
(Intel i5-13500, 64 GB RAM, 2× 1TB NVMe). Netdata's eBPF-based power
estimation tracks the platform's continuous draw:

| period         | mean watts | kWh (estimate) | EU electricity CO2 intensity | gCO2-eq |
| -------------- | ---------- | -------------- | ----------------------------- | ------- |
| 1 hour (avg)   | _from_report_ | _from_report_ | 264 gCO2/kWh (2024 EU avg)    | _from_report_ |
| 24 hours       | _from_report_ | _from_report_ | 264 gCO2/kWh                  | _from_report_ |
| 30 days        | _from_report_ | _from_report_ | 264 gCO2/kWh                  | _from_report_ |
| 365 days       | _from_report_ | _from_report_ | 264 gCO2/kWh                  | _from_report_ |

Because Hetzner's electricity is 100% renewable (guarantees of origin
basis), the **operator-attributable scope-2 emissions** for the hub
infrastructure are **0 gCO2-eq** even though the grid-average column
above reads >0 — that column exists only to give partners a worst-case
upper bound.

### 2.3 On-chain footprint per agent

| event                         | vbytes (typical) | fee (mainnet, 2026-05) |
| ----------------------------- | ---------------- | ---------------------- |
| ELITE registration anchor     | ~250             | ~2 000 sats (~€0.50)   |
| Phase 5 CRL anchor (daily)    | ~250             | ~2 000 sats (~€0.50)   |
| BASIC registration            | 0 on-chain       | 0                      |

Even adopting the most conservative academic estimates for the global
Bitcoin network (Cambridge CCAF 2024: ~150 TWh/yr ÷ 350 M annual tx ≈
0.4 kWh/tx attributed at the network level), our per-issuance share is
**well below the energy cost of a single Visa transaction**
(0.13 kWh/tx per Visa's 2023 sustainability report), because:

1. A single OP_RETURN block-inclusion is not a network-level event;
   we are sharing one block of throughput with thousands of other
   transactions.
2. The pro-rata-fee allocation method (the only methodology that ties
   energy to *user demand*, not block production) puts our share at
   our fee ratio of the block — at ~2 000 sats in a typical 12 M sats
   block, that's 0.017%.

### 2.4 Carbon offsets

We do **not** purchase third-party carbon offsets at this time. We
keep that option open for a future calendar-year change but consider
the Hetzner-renewable baseline sufficient.

## 3. Social (S)

### 3.1 User protections

- **GDPR Article 15 (right of access):**
  `POST /api/agent/:kya_id/data-export` — Subject Access Request,
  signed by the agent's Ed25519 key, returns a one-time download URL
  with a 1h expiry. Documented in `docs/DATA-EXPORT-API.md`. Audit
  trail in the `data_exports` SQL table.
- **GDPR Article 17 (right to erasure):**
  `POST /api/agent/:kya_id/retire` (agent self-service) and
  `POST /api/admin/agent/:kya_id/purge` (admin GDPR-grade hard delete)
  remove or pseudonymise the agent's row, the cert, all reputation
  events, and the heartbeat log. Audit trail preserved via the CRL
  ledger (which records the existence of the revocation without
  retaining PII).
- **Voluntary retirement:** any agent can stop participating at any
  time by calling `/api/agent/:kya_id/retire`. No exit fee.

### 3.2 AML / counter-terrorism financing safeguards

- **Volumetric limits:** documented in `docs/AML-VOLUMETRIC-LIMITS.md`
  — per-agent 24h sats cap, global hourly registration cap, global
  daily anchor-spend cap. All three editable by admin endpoint with
  a `change_reason` audit field (regulator-defensible).
- **Sybil resistance:** PoW puzzle at registration time, pubkey
  blacklist after voluntary retire / admin purge, manufacturer-attested
  onboarding for industrial deployers.
- **Suspicious activity reporting:** Telegram alerts to the operator
  on every threshold breach (deduplicated).

### 3.3 Open source and transparency

- The hub is closed-source today but the **certificate verification
  path is fully open**: any client can fetch
  `/api/cert/:serial`, `/api/protocol/manifest-schema`, and
  `/api/protocol/versions` and verify a cert against the hub's
  published Ed25519 pubkey without trusting any centralized service.
- CRL is anchored on-chain quarterly (Phase 5) — partners can verify
  revocations via the Merkle proof embedded in the CRL JSON.

## 4. Governance (G)

### 4.1 Key custody

- Hub Ed25519 signing keys (BASIC, ELITE, ROOT) are at-rest-encrypted
  with PBKDF2 + AES-256-GCM (passphrase in environment, never on
  disk in plaintext, never in source control, never logged — see
  `lib/logger.js` redaction policy under §30 Item 7).
- Multi-sig ELITE certs: 2-of-2 threshold across two independent
  signing roles (Phase 5b).
- Periodic key-rotation procedure in `docs/HUB-KEY-ROTATION.md`.

### 4.2 Backup and disaster recovery

- Lightning channel state: hourly off-Hetzner encrypted backups (§30
  Item 1), AES-256-CBC + HMAC-SHA256 integrity. Restore procedure in
  `docs/RESTORE-PROCEDURES.md`.
- PostgreSQL: daily 02:00 UTC encrypted backups (§30 Item 2).
- DAC8 accounting export: daily 01:00 UTC encrypted archive (§30
  Item 11).
- Retention: 30 days hot, 365 days cold.
- Backups themselves audited by the `backup_log` SQL table.

### 4.3 Operational controls

- **Circuit breakers**: BTCPay + Alby upstream resilience plus a
  cert-issuance internal breaker that flips to MAINTENANCE_HALT at 8%
  failure rate (returns 503 to clients) — `docs/CERT-BREAKER.md`.
- **Bitcoin fork detector** (§30 Item 5): every 10 min, 3-source
  consensus check (local bitcoind + mempool.space + blockstream.info).
  Auto-pauses anchor worker if `FORK_DETECTOR_AUTOPAUSE=true`.
- **Lightning liquidity monitor** (§30 Item 6): every 15 min,
  Telegram alerts on inbound depletion.
- **Prometheus metrics + p99 alerts** (§30 Item 10):
  `kyahub_request_duration_seconds{route="/api/pay"}` histogram with
  alertmanager rules for >500 ms p99 over 5 min.
- **PM2 process supervision** for every component;
  Netdata system-level monitoring.

### 4.4 Incident response

- Telegram bot integration in `lib/notifications.js` with deduplication
  keys for every alert source.
- Operator on-call rotation managed externally (not in this repo).
- Post-mortem template in `docs/POST-MORTEM-TEMPLATE.md` (TODO if not
  yet present — falls back to the operator's preferred incident
  management tool).

### 4.5 Audit log immutability

Every state mutation that affects an agent (cert issuance, revocation,
retire, purge, score change) lives in append-only tables (`action_log`,
`reputation_events`, `cert_signing_log`, `revocation_events`,
`anchor_audit`, `data_exports`, `backup_log`). Old rows are archived
to `*_archive` tables, never deleted. The CRL is additionally
anchored on-chain.

---

## Annex A — Methodology

**Power consumption** is sourced from Netdata's
`system.cpu_freq_scaling`, `system.power`, and platform-specific eBPF
hooks. Daily averages are stored in the Netdata historical store
under `/var/lib/netdata/` with 1-year retention.

**CO2-equivalent emissions** use the [European Environment Agency
2024 EU-27 grid intensity figure of **264 gCO2-eq/kWh**](https://www.eea.europa.eu/en/analysis/indicators/greenhouse-gas-emission-intensity-of-1).
Because Hetzner's electricity is 100% renewable per their TÜV-audited
guarantees of origin, the *operator-attributable* scope-2 figure is
0 gCO2-eq; the grid-average figure is shown only as worst case.

**Bitcoin per-transaction energy** uses the Cambridge Centre for
Alternative Finance methodology (CCAF Bitcoin Electricity Consumption
Index) for the network-wide total, and the **pro-rata-fee allocation**
methodology for attributing a per-transaction share — i.e. transaction's
share of the energy = (transaction fee) / (total fees in the block) ×
(energy attributable to that block).

---

## Annex B — How to regenerate the numeric placeholders

The `_from_report_` placeholders are filled by:

```bash
node scripts/esg-report.js --period 30d \
    --out docs/ESG-STATEMENT.generated.md
```

`scripts/esg-report.js` queries Netdata (`http://127.0.0.1:19999/api/v1/data`)
for the requested window, fills the table, and writes a sibling
`ESG-STATEMENT.generated.md`. The hand-maintained template above is
never overwritten — generated reports get a `.generated.md` suffix.

When B2B partners ask for a fresh statement, run the script and email
them both files. The hand-maintained template explains the *policies*;
the generated report supplies the *numbers*.

---

_Document maintained by UMBRAXON s.r.o.  
Contact: ops@umbraxon.xyz (replace with operator's preferred channel)._
