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

## Pricing / economics

- `docs/PRICING-ECONOMICS.md` — tier fees, OPEX model (70 % margin), mempool/anchor costs, ELITE listing TCO, market affordability.

## Sponsor invites (ELITE PoW bypass)

- `docs/SPONSOR-INVITE-DESIGN.md` — invite flow, penalties, env vars, kill switch.
- `migrations/022_sponsor_invites.sql` — schema + `kyahub_app` grants.
- `scripts/test-sponsor-invite-e2e.js` — smoke test (requires `SPONSOR_INVITE_ENABLED=true` + hub on `PORT`).
- Env: `SPONSOR_INVITE_ENABLED`, optional `SPONSOR_AGENT_ALLOWLIST` for staged rollout.

## GitHub promo (integrators)

- `docs/REGISTRATION-QUICKSTART.md` — pin or link from a GitHub issue.
- `.github/ISSUE_TEMPLATE/` + `.github/DISCUSSION_TEMPLATE/` — registration help forms.
- `.github/PINNED_ISSUE_BODY.md` — copy-paste for a pinned welcome issue.
- `scripts/github-promo-verify.sh` — local smoke (templates + `github-scan` dry-run).
- **Manual (once):** Repo **Settings → General → Features → Discussions** → enable; **Topics:** `ai-agents`, `lightning`, `ed25519`, `ky-a`, `m2m`.
- **Release:** tag `v1.1.0` — publish notes from `docs/RELEASE-v1.1.0.md` at https://github.com/UMBRAXON/kya-hub/releases

## Platform integrator API (plug-in layer)

- ADR: `docs/adr/001-platform-integrator-roles.md`
- Roadmap: `docs/PLATFORM-INTEGRATOR-ROADMAP.md`
- Public: `GET /api/v1/agents/{kya_id}`, `GET /api/v1/agents/{kya_id}/status`
- Migration: `023_developer_api_keys.sql`
- Admin keys: `GET/POST /api/admin/developer-keys`, `POST .../:id/revoke` (`X-Admin-Key`)
- Tests: `node test-platform-integrator.js`, `node test-developer-api-keys.js`
- Example: `examples/plugin-gate-v1.js`
- Env: `INTEGRATOR_READ_CACHE_MS`, `RATE_INTEGRATOR_READ_PER_MIN`, `DEVKEY_RATE_*_PER_MIN`
- Webhooks: `024_developer_webhook_outbox.sql`, PM2 `kya-dev-webhook-worker` (`*/1 * * * *`)
- Admin: `GET /api/admin/developer-webhooks/deliveries`, `POST .../process`
- Metric: `kyahub_developer_webhook_outbox{status}`
- LSAT: migration `025_integrator_lsat.sql`, `GET /api/protocol/integrator-lsat-profile`
- **Ready gate (run before partner onboarding):**
  ```bash
  ./scripts/platform-integrator-ready.sh
  ```
  Requires: hub online, `.env` with `ADMIN_API_KEY`, migrations 023–025 applied.
- Live smoke only: `node test-platform-integrator-live.js`
- Example gate: `KYA_HUB_BASE_URL=https://www.umbraxon.xyz node examples/plugin-gate-v1.js UMBRA-000467`

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

## Integrations v1 (discovery, delegation pass, manifest extensions)

- Hub semver **1.1.0** — over `GET /api/health` → `hub_release` (pozri [`docs/PROTOCOL-VERSIONING.md`](PROTOCOL-VERSIONING.md)).
- `docs/FAQ-FOR-BOT-DEVELOPERS.md` — bot developer FAQ (§H covers integrations v1, L402 profile, discovery opt-in, delegation pass).
- `docs/BOOTSTRAP-CHECKLIST.md` §G — migration `020_integrations_discovery.sql` + post-deploy curls.

## IDE / LLM assistants (MCP)

- `mcp/README.md` — Model Context Protocol (`stdio`) server: read-only tools over public hub HTTP (health, certs, reputation, tiers, etc.). For Cursor and other MCP hosts; does not replace the Python bot client for registration or signed actions.

- **Simulate bot (MCP + register, log correlation):** [`scripts/demo-bot-mcp-register.py`](scripts/demo-bot-mcp-register.py) — unique `DEMO-xxxxxxxx` name; use `--dry-run` to avoid `POST /api/register/initiate`; requires Node + `python3-nacl` / `pip install pynacl`.

- **Alby invoice lookup (NWC vs UI):** [`scripts/alby-lookup-invoice.js`](scripts/alby-lookup-invoice.js) — `node scripts/alby-lookup-invoice.js <payment_hash>` na stroji s hub `.env` overí `lookupInvoice` cez rovnaké NWC ako `register/initiate`.

## Public bot portal

- `https://www.umbraxon.xyz/bots/` — Bot Developer Portal (API + integration flow + policy); `https://bots.umbraxon.xyz/` is a **301 alias** to the same content.

## Edge gateway (public ingress)

- `nginx-proxy/README.md` — Nginx “ambassador” proxy setup, TLS, rate limits, Cloudflare notes.

