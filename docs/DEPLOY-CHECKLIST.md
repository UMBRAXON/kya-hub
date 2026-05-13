# Deploy checklist (minimal, safe)

Goal: deploy changes with **low risk** and clear rollback.

## 0) Preconditions

- You are on the production host as root.
- `.env` is present and `chmod 600`.
- Backups are healthy (R2 offsite + restore drill not failing).

## 1) Before deploy (5 minutes)

```bash
cd /root/kya-hub

# confirm current processes
pm2 list

# take an immediate safety backup (optional but recommended before risky ops)
bash scripts/backup-channel-state.sh || true
bash scripts/backup-database.sh || true
```

## 2) Apply DB migrations (if any)

```bash
cd /root/kya-hub
node migrations/run.js
```

If you want a dry run first:

```bash
node migrations/run.js --dry-run
```

## 3) Restart services

If you changed only backend code:

```bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
pm2 restart kya-hub --update-env
```

If you changed worker scripts too:

```bash
pm2 restart kya-anchor-worker --update-env
pm2 restart kya-crl-worker --update-env
```

If you changed PM2 config (`ecosystem.config.js`):

```bash
pm2 restart ecosystem.config.js --update-env
pm2 save
```

## 4) Post-deploy verification

```bash
# health endpoint must respond quickly
curl -fsS https://umbraxon.xyz/api/health | head -c 400; echo

# internal admin-only sanity (on host)
curl -fsS -H "X-Admin-Key: $ADMIN_API_KEY" http://127.0.0.1:3000/api/admin/system-health | head -c 1200; echo

# watch logs for immediate errors
pm2 logs kya-hub --lines 200 --nostream
```

## 5) Rollback (minimal)

1. Revert code to the last known good state (git tag/commit or restore from your mirror).
2. Re-run migrations only if the rollback requires it (prefer forward-fix; DB rollback is risky).
3. Restart:

```bash
pm2 restart kya-hub --update-env
pm2 restart kya-anchor-worker --update-env
pm2 restart kya-crl-worker --update-env
```

If the issue is data corruption / bad deploy during critical ops, follow `docs/RESTORE-PROCEDURES.md`.

