# Production bootstrap checklist

This is the operator-facing “go-live” checklist extracted from `UMBRAXON.md` so it stays actionable and reviewable.

**Doc sync 2026-05-13:** Verejný smoke (`https://umbraxon.xyz/api/health`, `/api/tiers`, `/terms`) → HTTP 200; `umbraxon.xyz:3000` → timeout (API cez TLS/nginx). Splnené položky sú zaškrtnuté podľa `UMBRAXON.md` (§21.9b real LN, §30.14 R2, §31 restore drill). Cold wallet, sweep cron a observability baseline stále vyžadujú potvrdenie na hoste.

**Podrobný postup (cold → sweep → E → follow-upy → CRL):** [`GO-LIVE-OPERATOR-WALKTHROUGH.md`](GO-LIVE-OPERATOR-WALKTHROUGH.md).

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
- [ ] **Lightning channel state off-site**: hourly cron for `scripts/backup-channel-state.sh` (see `docs/RESTORE-PROCEDURES.md`) and at least one verified object in `BACKUP_S3_*` (or B2). This hub uses **Alby Hub (LDK)** — not classic **LND**; there is no `lncli channel.backup` file in this stack.
- [ ] **Lightning / wallet recovery secrets off-server**: store Alby (and any other wallet) recovery material and cold-wallet seed **off the hub host** (paper, hardware wallet, encrypted vault). The repo never automates seed export.

## E) Observability baseline

- [x] **Monitoring access**: Netdata reachable via SSH tunnel only (`docs/NETDATA-ACCESS.md`). _(Host check 2026-05-13: netdata on `127.0.0.1:19999`, local HTTP 200.)_
- [x] **Alerts**: Telegram alerts tested (see `docs/ALERTING-RUNBOOK.md`). _(Host check 2026-05-13: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` set in `.env`; operator skips token rotation.)_
- [x] **Logging**: PM2 logs + `logrotate` installed (`docs/LOGGING.md`). _(Host check 2026-05-13: `/etc/logrotate.d/kyahub` present; `logrotate -d` clean; `pm2-logrotate` online.)_
- [ ] **BTCPay / Bitcoin Core / LND log volume**: confirm Docker log limits (`max-size` / `max-file`) and/or host rotation for large `debug.log` paths per [`docs/LOGGING.md`](LOGGING.md) §4 and `config/logrotate-btcpay-bitcoin-lnd.example` (baseline `logrotate-kya-hub` does not cover those).

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

## F) Chronologické `kya_id` (nový deploy kódu)

- [ ] **`migrations/018_hub_kya_seq.sql`** aplikovaná na produkčnej DB (`hub_kya_seq` + `GRANT` pre `kyahub_app`). Bez sekvencie `registerAgent()` pri novom agentovi zlyhá na `nextval`.
- [ ] Po prvej registrácii over verejný index: `curl -fsS 'https://<tvoja-domena>/api/whitelist?limit=5' | jq '.agents[].kya_id'` — očakávaj tvar `UMBRA-000…` pre nových agentov (starí môžu mať „hex“ vzhľad).

## G) Integrations v1 — discovery, delegation pass, manifest extensions (2026-05)

- [ ] **`migrations/020_integrations_discovery.sql`** aplikovaná (`agents.discovery_opt_in`, `delegation_pass_ledger`, `delegation_request_nonces`, indexy, `GRANT`). Bez nej nový hub kód hlási SQL chyby pri INSERT agenta alebo pri `POST /api/agent/{kya_id}/delegation-pass`.
- [ ] Po deployi over: `curl -fsS https://<tvoja-domena>/api/protocol/l402-delegation-profile | head` a `curl -fsS 'https://<tvoja-domena>/api/discovery/v1/agents.json?limit=1'`.
