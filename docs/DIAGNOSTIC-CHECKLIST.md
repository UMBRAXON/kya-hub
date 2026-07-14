# Diagnostický checklist (traffic, self-test, platby)

Tento dokument opravuje zastaranú cestu `logs/access.log` (v repozitári neexistuje) a zviaže príkazy s reálnou nasadenou architektúrou (nginx + PM2 + `test-protocol.js`).

## CORS (prehliadač vs. server bot)

- **Backend / `curl` / väčšina botov** neposielajú hlavičku `Origin` — CORS ich **neblokuje**; nič špeciálne netreba.
- **JavaScript v prehliadači** (dashboard, „browser bot“) musí mať doménu v **`CORS_ALLOWED_ORIGINS`** v `.env` (čiarkou oddelený zoznam; v kóde je rozumný default pre `umbraxon.xyz` a `*.umbraxon.xyz`). Po zmene treba **reštartovať hub**.
- Preflight (`OPTIONS`) pre `POST` s vlastnými hlavičkami (napr. **`X-Pow`**, `X-Admin-Key`) rieši hub cez knižnicu `cors` tak, že **povolí presne tie hlavičky**, ktoré klient v preflight požiada — netreba pri každej novej hlavičke meniť kód.

## 1. Live traffic (IP + HTTP status)

### Nginx (ak beží reverse proxy z `nginx-proxy/`)

Access log je v kontajneri/hoste podľa `nginx-proxy/conf.d/default.conf`:

- typicky **`/var/log/nginx/access.log`**

```bash
sudo tail -f /var/log/nginx/access.log | grep '/api/'
```

Ak súbor neexistuje (hub bez nginx na tomto stroji), použij bod 2.

### PM2 (aplikácia — JSON logy, nie Apache access formát)

```bash
tail -f /root/.pm2/logs/kya-hub-out.log | grep -E '"/api/|route":"|register/initiate|webhook'
tail -f /root/.pm2/logs/kya-hub-error.log
```

**Význam:** časté **`402`** s `POW_*` = klient neposlal / zle vyriešil proof-of-work pre `register` alebo `pay`. **`401`** pri `initiate` = challenge / podpis manifestu. Podrobnosti sú v tele odpovede JSON.

### Skratka

```bash
bash scripts/diagnostic-tail-api.sh
```

## 2. Self-test registrácie (`/api/register/initiate`)

Kompletný flow (manifest, podpis, auth challenge, **PoW**, `POST /api/register/initiate`, replay + tamper testy, webhook simulácia, cert) je v:

```bash
cd /path/to/kya-hub
# Lokálny hub (default http://127.0.0.1:3000)
node test-protocol.js

# Alebo explicitne:
LOCAL_SERVER=http://127.0.0.1:3000 node test-protocol.js
```

Voliteľne nastav **`ADMIN_API_KEY`** v prostredí — axios v teste pošle `X-Admin-Key` (rate-limit bypass pre testy; **PoW ostáva zapnutý** okrem ak by si ho vypol na hub env).

**Očakávanie:** na zdravom hube s DB + BTCPay/Alby skončí súhrn **`Passed: 18`**, **`Failed: 0`**. Ak `initiate` zlyhá, botovi by zlyhalo rovnako — najprv skontroluj `POW_REQUIRED` a správne polia (`manifest_signature`, `challenge_id`, `challenge_response`, `body.pow`).

## 3. BTCPay / Alby (Expired / Failed)

Hub sám neukladá „pekný“ dashboard faktúr pre operátora — treba **webové UI** príslušnej brány:

- **BTCPay Server** — zoznam faktúr, filtre *Invalid / Expired / Settled*.
- **Alby Hub** — platby / inbound podľa nasadenia.

Na strane hubu rýchla kontrola dostupnosti API:

```bash
curl -sS https://umbraxon.xyz/api/health | jq .
```

Polia `btcpay`, `alby`, `db` musia byť v poriadku. Z Cursora alebo iného MCP hostiteľa rovnaké dáta vie vrátiť read-only server v [`mcp/README.md`](mcp/README.md) (nástroj `kya_health`).

**`alby: NOT_CONNECTED`** — NWC URI je nastavené (`ALBY_NWC_URI` alebo `.secrets/alby-nwc.txt`), ale WebSocket k Alby Hub zlyhal (Hub locked po reštarte, relay timeout, zlá URI). Hub skúša reconnect s backoffom automaticky. Manuálne:

```bash
# 1) Over, že alby-hub beží a je odomknutý (UI :8080)
pm2 status alby-hub
# 2) Force reconnect z kya-hub
curl -sS -X POST -H "X-Admin-Key: $ADMIN_API_KEY" http://127.0.0.1:3000/api/admin/alby/reconnect | jq .
# 3) Health
curl -sS http://127.0.0.1:3000/api/health | jq .alby
```

**Alby: „pending“ v KYA, ale v Alby Hub UI nič** — hub vytvára LN invoice cez **NWC** (`ALBY_NWC_URI`), nie nutne rovnaký zoznam ako ručné faktúry v UI. Overenie na uzle pripojenom NWC:

```bash
cd /root/kya-hub && node scripts/alby-lookup-invoice.js <invoiceId_z_JSON_register_initiate>
```

(`invoiceId` = 64 hex `payment_hash`.) Ak príkaz vráti JSON so `state: "pending"` a `invoice` (BOLT11), platba existuje na LDK strane; hľadaj v Alby UI pod **Activity** / iný wallet alebo podľa popisu `UMBRAXON … registration`.

## 4. Kód `/api/register/initiate` — „tiché“ chyby

Handler v `server.js` pri validačných zlyhaniach vracia explicitné **4xx/401/409** s `error` kódom. Jediný zmysluplný „tichší“ bod pre klienta je **`502 INVOICE_FAILED`**: detail chyby ide do **pino logu** (`invoice create FAIL`), nie do JSON tela odpovede.

`try/catch` okolo manufacturer DB lookup len **fallbackne** pokračuje na env/manifest attestation a loguje `warn` — **nezmaskuje** úspešnú registráciu ako chybu.

Viac o logoch: `docs/LOGGING.md`.

## 5. Rate limit `POST /api/register/initiate` a Lightning inbound

**Aplikácia:** `server.js` používa na `POST /api/register/initiate` (a `/api/pay`) limiter **`payLimiter`** — default **5 requestov / min / IP** (`RATE_PAY_PER_MIN` v `.env`). Priame volania na port **3000** obchádzajú nginx; limit ostáva v Node.

**Nginx (`kya-hub-proxy`):** zóna `rl_register` (cesty `/api/register-bot`, `/api/register/...` vrátane **`/api/register/initiate`**) má rovnaký cieľ **5/min/IP** na edge; po zmene konfigurácie `nginx -s reload` v kontajneri.

**Inbound likvidita (BASIC 10k musí „prejsť“):** hub nevytvára kanály sám — treba **Alby Hub / LND** s dostatkom **inbound** (remote balance). Skript `scripts/lightning-liquidity-monitor.js` (PM2 `kya-liquidity-monitor`, typicky každých 15 min) číta stav; env napr. `LIQUIDITY_MIN_INBOUND_SATS` (default 10 000), `LIQUIDITY_WARN_SATS`, `LIQUIDITY_CRITICAL_SATS`. Kontrola: `GET /api/admin/lightning/liquidity?fresh=1` s `X-Admin-Key`. Podrobnejšie: `docs/GO-LIVE-OPERATOR-WALKTHROUGH.md` (sekciu o dobíjaní / Lightning).

## 6. `kya_id`, DB zápisy a verejný whitelist

- **Chronologické ID:** nový agent dostane `kya_id` z PostgreSQL sekvencie `hub_kya_seq` (tvar `UMBRA-` + 6 číslic, napr. `UMBRA-000466`). Migrácia: `migrations/018_hub_kya_seq.sql` — na novom env ju treba aplikovať pred prvou registráciou po deployi kódu.
- **Integrations v1:** `migrations/020_integrations_discovery.sql` pridá `discovery_opt_in` a tabuľky pre audit delegation passov — aplikuj **pred** reštartom na nový `server.js`, ktorý tieto časti používa (odporúčané poradie: `pg_dump` záloha → `node migrations/run.js` → `pm2 restart`). Pozri [`docs/BOOTSTRAP-CHECKLIST.md`](BOOTSTRAP-CHECKLIST.md) §G.
- **Transakcia + zámky:** `registerAgent()` v `server.js` drží `BEGIN`…`COMMIT` na jednom klientovi; serializácia podľa mena cez `pg_advisory_xact_lock`, intent cez `FOR UPDATE`, existujúci agent tiež `FOR UPDATE` pred `INSERT`.
- **Whitelist API** (`GET /api/whitelist`, `GET /api/whitelist/elite`) sa **nemení** — stále vracia `kya_id` z tabuľky `agents`; kontrakt a filtre sú v `UMBRAXON.md` §26.5. Rýchla kontrola po registrácii:

```bash
curl -sS 'https://umbraxon.xyz/api/whitelist?limit=5' | jq '.agents[].kya_id, .count'
```

## 7. Webhook URL, TLS a POST logovanie

### Verejný dosah webhooku (BTCPay / Alby)

- Hub očakáva **`POST /api/webhook/btcpay`** a **`POST /api/webhook/alby`** na **verejnej HTTPS** doméne za nginxom (pozri `nginx-proxy/conf.d/default.conf` — samostatné `location`, bez `limit_req` ako pri pay/register).
- V **BTCPay Server** (Store → Webhooks) musí byť URL presne táto verejná adresa — **nie** `http://127.0.0.1:3000`, pokiaľ BTCPay neposiela z toho istého hosta. Ak používaš **ngrok / Cloudflare Tunnel**, po páde tunela BTCPay stále posiela na mŕtvu adresu a hub **nič nezaloguje** (žiadny príchod requestu).
- **Smoke z internetu** (overí TLS + proxy + Node; bez platného HMAC dostaneš 400, nie timeout):

```bash
curl -sS -o /dev/null -w 'code=%{http_code} tcp=%{time_connect} tls=%{time_appconnect} total=%{time_total}\n' \
  -X POST 'https://<tvoja-domena>/api/webhook/btcpay' \
  -H 'Content-Type: application/json' -d '{}'
```

### TLS / handshake latencia (prísni HTTP klienti)

- Hub **nemeria** ani neblokuje handshake pod 200 ms — správanie závisí od **klienta** (CDN, Moltbook, …).
- Orientačné čísla: meraj `time_appconnect` cez `curl -w` voči `GET https://<domena>/api/status` alebo `/api/whitelist` z lokality blízkej botom.

### Kde sú POST / webhook v logoch

- Nie je samostatný „skrytý súbor“ pre POST; výstup ide do **PM2** (`docs/LOGGING.md`): `kya-hub-out.log` / `kya-hub-error.log`.
- Aplikácia **neloguje každý HTTP request** globálne (žiadny pino-http); webhook zaloguje **`webhook received`** na úrovni **info** (`server.js`).
- Ak v `.env` nastavíš **`LOG_LEVEL=warn`** (alebo vyššie), riadky **`info`** (vrátane webhooku) **zmiznú** — default v produkcii je **`info`** (`lib/logger.js`).
- Redakcia v `lib/logger.js` maskuje tajomstvá a dlhé hex/base64 reťazce; **nefiltruje** metódu POST ako takú.

```bash
grep -E 'webhook received|webhook/btcpay|InvoiceSettled|registerAgent FAIL' /root/.pm2/logs/kya-hub-out.log | tail
```
