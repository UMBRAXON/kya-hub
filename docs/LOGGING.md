# Logging — Ops baseline (simple + secure)
 
This project intentionally keeps logging **simple**:
 
- The Node.js services log to **stdout/stderr** (JSON logs via `pino`).
- PM2 captures output into files under **`/root/.pm2/logs/`** (see `ecosystem.config.js`).
- Cron/one-shot scripts (backups) append to **`/var/log/kya-*.log`**.
 
We then apply **system-level rotation + retention** with `logrotate`.
That keeps the app code minimal and avoids introducing third-party logging daemons.
 
## 1) Where logs live
 
### PM2 app logs (primary)
 
- `/root/.pm2/logs/kya-hub-out.log`
- `/root/.pm2/logs/kya-hub-error.log`
- `/root/.pm2/logs/kya-*-out.log` / `kya-*-error.log` (workers)
- `/root/.pm2/logs/alby-hub-out.log` / `alby-hub-error.log`
 
### Cron / maintenance logs
 
- `/var/log/kya-channel-backup.log`
- `/var/log/kya-db-backup.log`
 
## 2) Rotation + retention (recommended)
 
Install the repo-provided logrotate policy:
 
```bash
sudo install -m 0644 /root/kya-hub/config/logrotate-kya-hub /etc/logrotate.d/kya-hub
sudo logrotate -f /etc/logrotate.d/kya-hub
```
 
## 3) Security notes
 
- **Do not `source .env`** in shell sessions. The `.env` file is not shell-safe (it contains free-form text elsewhere in the doc pipeline). Use the `load_env_key` helpers in scripts.
- PM2 logs are under `/root`. Ensure `/root` is `chmod 700` (security audit).
- The app’s logger already redacts secrets (see `scripts/test-item7-log-redaction.js`).

## 4) “Centralized logging” (optional follow-up)

Baseline recommendation: **do not add a log shipping stack** until you have a real need.

If you do need centralization later (multi-host, long retention, cross-service queries):

- Keep **PM2 + logrotate** as the local source-of-truth.
- Add a separate, ops-managed shipper (e.g. journald forwarding, Loki/Promtail, or similar).
- Never ship `.env` contents; keep redaction in place and prefer allowlists over denylists.
 
