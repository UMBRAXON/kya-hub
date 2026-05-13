# Production bootstrap checklist

This is the operator-facing “go-live” checklist extracted from `UMBRAXON.md` so it stays actionable and reviewable.

**Doc sync 2026-05-13:** Verejný smoke (`https://umbraxon.xyz/api/health`, `/api/tiers`, `/terms`) → HTTP 200; `umbraxon.xyz:3000` → timeout (API cez TLS/nginx). Splnené položky sú zaškrtnuté podľa `UMBRAXON.md` (§21.9b real LN, §30.14 R2, §31 restore drill). Cold wallet, sweep cron a observability baseline stále vyžadujú potvrdenie na hoste.

## A) Payments: Alby Hub + NWC

- [x] **Alby Hub setup**: SSH tunnel + setup wizard + channel with LSP (target at least 200k SAT inbound). _(Dokumentované v `UMBRAXON.md` §21.9b / §30.Y.)_
- [x] **NWC URI**: copy into `.env` as `ALBY_NWC_URI` (or whichever key is used by your Alby integration). _(Implikované fungujúcim Alby webhook / LN flow v §21.9b.)_
- [x] **Mainnet smoke payment**: BASIC registration succeeds end-to-end (real sats). _(§21.9b real LN E2E; BASIC tier 10 000 sat po revert.)_

## B) Payments: BTCPay (fallback / on-chain)

- [x] **BTCPay API key**: full access key in `.env` (only on the host; never committed). _(Verejný `/api/health` 2026-05-13: `btcpay.status` = OK.)_

### BTCPay API key rotation (exact steps)

1) Create a new key in BTCPay:
- Open BTCPay Server UI → **Account** → **Manage API Keys** → **Create a new API key**.
- Select the **same store** as the current hub uses.
- Prefer **minimum scopes** that still work; if unsure, start with the same scope as the old key.

2) Install the new key on the hub host:

```bash
cd /root/kya-hub
# edit .env and replace BTCPAY_API_KEY with the new value (do not paste it into chat)
nano /root/kya-hub/.env
pm2 restart --update-env kya-hub
```

3) Verification:

```bash
# health should be OK
curl -fsS http://127.0.0.1:3000/api/health | head -c 300; echo

# create a small invoice via the normal flow (preferred), or at least check logs for BTCPay errors
pm2 logs kya-hub --lines 200 --nostream | tail -n 200
```

4) Revoke the old key:
- BTCPay UI → Manage API Keys → **Delete/Revoke** the old key.

## C) Cold wallet + sweeps

- [ ] **Cold wallet**: run `scripts/gen-cold-wallet.js` → write seed offline → import xpub/zpub into BTCPay → set `SWEEP_DESTINATION_ADDRESS` in `.env`.
- [ ] **Hardware wallet**: ordered / available to replace paper seed when possible.
- [ ] **Sweep cron**: active (e.g. 4× daily) and verified with logs.

## D) Backups + DR

- [x] **First DB backup**: run `scripts/backup-database.sh` (cron or manual) and confirm success. _(§30.14 gate #1 + `UMBRAXON.md` §30.Y.)_
- [x] **R2 offsite backups end-to-end**: run `scripts/backup-offsite-smoketest.sh`, then real backup scripts and verify objects exist in R2. _(§30.14 gate #1 RESOLVED.)_
- [x] **Disaster recovery drill**: at least 1× yearly — restore into `kyahub_restore` and verify (`pg_restore`). _(Kvartálny drill PASS 2026-05-12, `UMBRAXON.md` §31 A.3; ročný cyklus ponechať.)_

## E) Observability baseline

- [ ] **Monitoring access**: Netdata reachable via SSH tunnel only (`docs/NETDATA-ACCESS.md`).
- [ ] **Alerts**: Telegram alerts tested (see `docs/ALERTING-RUNBOOK.md`).
- [ ] **Logging**: PM2 logs + `logrotate` installed (`docs/LOGGING.md`).

### Telegram bot token rotation (exact steps)

1) Rotate token in BotFather:
- Open Telegram → chat with **BotFather**
- Run `/token`
- Pick your bot → BotFather returns a **new token** (the old one becomes invalid or should be treated as compromised).

2) Install the new token on the hub host:

```bash
cd /root/kya-hub
# edit .env and replace TELEGRAM_BOT_TOKEN with the new value (do not paste it into chat)
nano /root/kya-hub/.env
pm2 restart --update-env kya-hub
```

3) Verification:

```bash
# trigger any action that sends a notification, or at minimum confirm no auth errors appear:
pm2 logs kya-hub --lines 200 --nostream | tail -n 200
```

