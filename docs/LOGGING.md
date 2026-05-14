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

## 4) Bitcoin Core, LND, and BTCPay Docker (not covered by `logrotate-kya-hub`)

[`config/logrotate-kya-hub`](../config/logrotate-kya-hub) only rotates **PM2** files under `/root/.pm2/logs/` and **`/var/log/kya-*.log`**. It does **not** rotate **`debug.log`** inside Bitcoin Core or LND data directories. Those processes often run **inside Docker** (BTCPay Server stack); their `debug.log` can grow until the host disk fills if nothing limits it.

**Alby Hub** in this deployment logs through **PM2** (`alby-hub-out.log` / `alby-hub-error.log`), so it is already included in the baseline policy above.

**What to do on the host**

1. **Container stdout/stderr** (docker `json-file` logs): configure **log rotation at the Docker level** for noisy services — e.g. in `docker-compose` overrides or daemon `log-opts`: `max-size` (e.g. `10m`) and `max-file` (e.g. `3`). This prevents unbounded growth of `/var/lib/docker/containers/<id>/<id>-json.log`.
2. **In-datadir `debug.log`**: if Bitcoin Core or LND write a large `debug.log` on a path you control (bind mount or extracted volume path), add a **separate** `logrotate` stanza on the host. Discover the real path with `docker inspect` (Mounts) or your BTCPay / deployment docs; paths differ per install.
3. **Example stanza (edit before use):** [`config/logrotate-btcpay-bitcoin-lnd.example`](../config/logrotate-btcpay-bitcoin-lnd.example) — copy ideas only; uncomment and replace `PLACEHOLDER_*` paths after you know them. Install with `sudo install -m 0644 … /etc/logrotate.d/btcpay-bitcoin-lnd` only when validated (`logrotate -d`).

**Operational note:** `copytruncate` (as in the KYA policy) is a pragmatic choice when daemons keep files open; some teams prefer `size`-based rotation or lowering `debug` categories in `bitcoin.conf` / `lnd.conf` instead of huge trace logs.

## 5) “Centralized logging” (optional follow-up)

Baseline recommendation: **do not add a log shipping stack** until you have a real need.

If you do need centralization later (multi-host, long retention, cross-service queries):

- Keep **PM2 + logrotate** as the local source-of-truth.
- Add a separate, ops-managed shipper (e.g. journald forwarding, Loki/Promtail, or similar).
- Never ship `.env` contents; keep redaction in place and prefer allowlists over denylists.
 
