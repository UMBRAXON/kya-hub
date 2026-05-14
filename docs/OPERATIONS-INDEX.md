# Operations Index (KYA-Hub)

Single-page navigation for production ops. Start here, then jump into the deeper runbooks.

## Source of truth / roadmap

- `UMBRAXON.md` — main operator doc + infra status + roadmap gates.

## Deploy / rollback

- `docs/DEPLOY-CHECKLIST.md` — safe deploy steps (pre-backup → migrate → restart → verify → rollback).

## Production bootstrap (operator)

- `docs/BOOTSTRAP-CHECKLIST.md` — go-live checklist (keys, payments, sweeps, backups, DR, observability).
- `docs/GO-LIVE-OPERATOR-WALKTHROUGH.md` — step-by-step walkthrough: cold wallet → sweep → observability → follow-ups → CRL GO/DRY_RUN. **Sekcia „Dobíjanie / treasury“** = kde sú SATy (BTCPay vs `kya-anchor` vs Alby) a ako generovať top-up adresu.

## Backups / restore / DR

- `scripts/backup-channel-state.sh` — hourly Lightning channel-state backups (encrypted + HMAC + optional offsite).
- `scripts/backup-database.sh` — daily PostgreSQL backups (encrypted + HMAC + optional offsite).
- `scripts/restore-drill.sh` — quarterly restore drill (downloads latest offsite DB backup and verifies it is restorable).
- `docs/RESTORE-PROCEDURES.md` — full restore playbook (channel state + PostgreSQL).
- `scripts/backup-offsite-smoketest.sh` — low-risk check that `BACKUP_S3_*` creds can PUT/LIST/GET/DELETE a probe.

## Monitoring / alerting

- `docs/NETDATA-ACCESS.md` — access Netdata safely (SSH tunnel only) + what’s monitored.
- `docs/PROMETHEUS-METRICS.md` — `/api/metrics` contract + suggested alert rules + `GET /api/admin/ops-summary` / static ops page.
- `docs/ALERTING-RUNBOOK.md` — paging policy + “first 5 minutes” triage checklist.

## Logging

- `docs/LOGGING.md` — baseline logging strategy (PM2 file logs + `logrotate`, secure defaults) + Bitcoin Core / LND / Docker notes (§4).
- `config/logrotate-btcpay-bitcoin-lnd.example` — optional host `logrotate` template for large `debug.log` paths (edit `PLACEHOLDER_*` before use; see `LOGGING.md` §4).
- `docs/DIAGNOSTIC-CHECKLIST.md` — live API traffic (`nginx` / PM2), self-test `node test-protocol.js`, payment UI pointers, `/api/register/initiate` notes.
- `scripts/diagnostic-tail-api.sh` — `tail -f` helper: nginx access log if readable, else PM2 `kya-hub-out.log`.

## Error tracking (opt-in)

- `docs/SENTRY.md` — how to enable Sentry + security defaults (no PII by default).

## Watchtower (Lightning safety)

- `docs/WATCHTOWER-SETUP.md` — how to configure a watchtower (operator action).
- `docs/WATCHTOWER-MONITORING.md` — optional monitor that alerts if the watchtower signal disappears.

## API contract

- `openapi/openapi.yaml` — OpenAPI spec for public + admin endpoints.

## IDE / LLM assistants (MCP)

- `mcp/README.md` — Model Context Protocol (`stdio`) server: read-only tools over public hub HTTP (health, certs, reputation, tiers, etc.). For Cursor and other MCP hosts; does not replace the Python bot client for registration or signed actions.

- **Simulate bot (MCP + register, log correlation):** [`scripts/demo-bot-mcp-register.py`](scripts/demo-bot-mcp-register.py) — unique `DEMO-xxxxxxxx` name; use `--dry-run` to avoid `POST /api/register/initiate`; requires Node + `python3-nacl` / `pip install pynacl`.

- **Alby invoice lookup (NWC vs UI):** [`scripts/alby-lookup-invoice.js`](scripts/alby-lookup-invoice.js) — `node scripts/alby-lookup-invoice.js <payment_hash>` na stroji s hub `.env` overí `lookupInvoice` cez rovnaké NWC ako `register/initiate`.

## Public bot portal

- `https://bots.umbraxon.xyz/` — Bot Developer Portal (API + integration flow + policy).

## Edge gateway (public ingress)

- `nginx-proxy/README.md` — Nginx “ambassador” proxy setup, TLS, rate limits, Cloudflare notes.

