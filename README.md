# UMBRAXON KYA-Hub

KYA-Hub backend + operator runbooks. This repo is designed for **simple ops**:
PM2-managed services, offsite encrypted backups, Netdata monitoring, and hermetic CI smoke tests.

## Quickstart (dev / local)

```bash
npm ci
npm test
node server.js
```

## Runtime requirements

- **Node.js**: tested with `v20.18.2`. Some transitive deps may warn they expect `>=20.19.0`; upgrading Node is recommended when available.

## Production ops (high-signal entry points)

- **Project doc / source of truth**: `UMBRAXON.md`
- **Deploy**: `docs/DEPLOY-CHECKLIST.md`
- **Restore / DR**: `docs/RESTORE-PROCEDURES.md`
- **Alerting runbook**: `docs/ALERTING-RUNBOOK.md`
- **Logging baseline**: `docs/LOGGING.md`
- **Backups (offsite smoke test)**: `scripts/backup-offsite-smoketest.sh`
- **Watchtower monitoring (opt-in)**: `docs/WATCHTOWER-MONITORING.md`
- **Sentry (opt-in, safe defaults)**: `docs/SENTRY.md`
- **OpenAPI spec**: `openapi/openapi.yaml`

## CI

Local:

```bash
npm run ci:audit
npm run ci:smoke
```

GitHub Actions:
- `.github/workflows/ci.yml` (push/PR)
- `.github/workflows/nightly.yml` (scheduled)

