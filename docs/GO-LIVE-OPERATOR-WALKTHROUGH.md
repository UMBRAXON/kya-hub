# Go-live — operátorská navigácia (krok za krokom)

Tento dokument je **praktický sprievodca** doplnok k [`UMBRAXON.md`](../UMBRAXON.md) a [`BOOTSTRAP-CHECKLIST.md`](BOOTSTRAP-CHECKLIST.md). Rieši zvyšné položky v poradí: **cold wallet → sweep → observability → follow-upy → CRL**.

---

## Fáza 1 — Cold wallet + HW

**Môžeš preskočiť / odložiť**, ak teraz nechceš riešiť cold path (akceptuješ dočasne vyšší hot-wallet risk). Potom **nespúšťaj** sweep smerom na cold adresu, kým ju nemáš — nechaj `SWEEP_DESTINATION_ADDRESS` prázdne (skript sweep preskočí, pozri `scripts/sweep-hot-wallet.sh`).

**Cieľ (keď sa k tomu vrátiš):** Vlastný **seed offline**, **zpub** (BIP-84) v BTCPay ako watch-only, plán na hardvérovú peňaženku.

### 1.1 Generovanie (na čistom stroji alebo s plnou pozornosťou)

```bash
cd /root/kya-hub
node scripts/gen-cold-wallet.js --info          # voliteľné: derivácie
node scripts/gen-cold-wallet.js                 # interaktívne: 24 slov + verifikácia
```

- Skript generuje **BIP-39 / 24 slov**, **BIP-84** account, výstupy **xpub**, **zpub** (pre BTCPay native segwit), prvú **bc1q…** adresu na kontrolu.
- Po potvrdení uloží verejné dáta do `/root/kya-hub/.cold-wallet-public.json` (iba pubkey info).
- **Seed nikdy necommituj.** Odporúčané: `history -c && history -w` po skončení (pozri hlavičku v `scripts/gen-cold-wallet.js`).

Existujúci seed (bez nového generovania):

```bash
node scripts/gen-cold-wallet.js --derive
# (skript sa opýta na 24 slov z papiera)
```

### 1.2 BTCPay (watch-only)

1. BTCPay → **Wallets** → pridať / Receive → **Use existing wallet** → **Other** → vložiť **zpub** z výstupu skriptu.
2. Over prvú receive adresu proti `first_receive_address` zo skriptu / `.cold-wallet-public.json`.

### 1.3 Hardvérová peňaženka

Objednaj HW (Coldcard, Trezor, Ledger, …). Po doručení importuj seed podľa výrobcu a podpisuj PSBT odtiaľ.

**Checkpoint:** `[ ]` cold seed na papieri / kovu · `[ ]` zpub v BTCPay · `[ ]` HW objednaná alebo doručená

---

## Fáza 2 — `SWEEP_DESTINATION_ADDRESS` + cron + BTCPay API

**Cieľ:** Automatizovaný **návrh sweepu** cez BTCPay payout (manuálny podpis PSBT v UI), s rozumným prahom a cooldownom.

Skript: [`scripts/sweep-hot-wallet.sh`](../scripts/sweep-hot-wallet.sh)

### 2.1 Premenné v `.env` (na produkčnom hoste)

| Premenná | Význam | Default v skripte |
|-----------|--------|-------------------|
| `BTCPAY_URL` | Base URL BTCPay | (povinné) |
| `BTCPAY_STORE_ID` | Store ID | (povinné) |
| `BTCPAY_API_KEY` | Greenfield API token | (povinné) |
| `SWEEP_DESTINATION_ADDRESS` | **bc1q…** cold receive (musí sedieť s cold wallet) | ak prázdne → sweep skip |
| `SWEEP_THRESHOLD_SATS` | Spusti payout request ak hot balance ≥ prah | `50000` |
| `SWEEP_KEEP_HOT_SATS` | Nechať v hot peňaženke | `10000` |
| `SWEEP_PAYOUT_METHOD` | BTCPay payout method id | `BTC-CHAIN` |
| `SWEEP_COOLDOWN_HOURS` | Min. odstup medzi pokusmi | `24` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Notifikácie o sweep stave | voliteľné |

Voliteľné override ciest skriptu:

- `ENV_FILE` (default `/root/kya-hub/.env`)
- `LOG_FILE` (default `/var/log/kyahub-sweep.log`)
- `STATE_FILE` (default `/var/lib/kyahub-sweep.state`)

### 2.2 BTCPay oprávnenia API kľúča

Skript volá:

1. `GET .../stores/{id}/payment-methods/onchain/BTC/wallet` — zistenie on-chain balance.
2. `POST .../stores/{id}/payouts` — vytvorenie payout requestu (PSBT na podpis).

Ak API vráti `missingPermission` a v logu je hláška o **`btcpay.store.canmodifystoresettings`**, vygeneruj v BTCPay UI nový kľúč s dostatočnými právami pre **store** (skript v logu odporúča „Full access for store“ ako spoľahlivú voľbu; po stabilizácii môžeš zúžiť scopes podľa Greenfield dokumentácie).

### 2.3 Cron + prvý test

```bash
sudo touch /var/log/kyahub-sweep.log
sudo chown root:root /var/log/kyahub-sweep.log   # alebo vlastník podľa tvojej politiky

cd /root/kya-hub
bash scripts/sweep-hot-wallet.sh --dry-run
```

Príklad crontabu (4× denne — uprav podľa `UMBRAXON.md` §21.5):

```cron
0 */4 * * * /bin/bash /root/kya-hub/scripts/sweep-hot-wallet.sh >> /var/log/kyahub-sweep.log 2>&1
```

**Checkpoint:** `[ ]` `.env` má `SWEEP_DESTINATION_ADDRESS` · `[ ]` dry-run OK · `[ ]` cron nainštalovaný · `[ ]` jeden reálny beh / payout podpísaný v BTCPay UI

---

## Fáza 3 — Observability (sekcia E checklistu)

| Krok | Dokument |
|------|----------|
| Netdata cez SSH tunel | [`NETDATA-ACCESS.md`](NETDATA-ACCESS.md) |
| Telegram alerty | [`ALERTING-RUNBOOK.md`](ALERTING-RUNBOOK.md) |
| PM2 logy + logrotate | [`LOGGING.md`](LOGGING.md) §2–3, šablóna `config/logrotate-kya-hub`; §4 + `config/logrotate-btcpay-bitcoin-lnd.example` pre veľké `debug.log` (BTCPay / bitcoind / LND) |

**Checkpoint:** `[ ]` Netdata UI · `[ ]` test Telegram · `[ ]` logrotate bez chýb (`logrotate -d` …)

---

## Fáza 4 — Follow-upy (priorita po Fáze 3)

1. **Faktúry** — `INVOICE_SELLER_*`, `INVOICE_SELLER_LOGO_PATH` v `.env`, regenerácia PDF (`UMBRAXON.md` §31). *(Môže byť odložené.)*
2. **Prometheus / Netdata** — scrape `GET /api/metrics` s `X-Admin-Key`: [`PROMETHEUS-METRICS.md`](PROMETHEUS-METRICS.md). *(Voliteľné, keď budeš chcieť grafy.)*
3. **Watchtower** — [`WATCHTOWER-SETUP.md`](WATCHTOWER-SETUP.md). *(Neskôr.)*
4. **`bitcoind` `txindex=1` + neprunovaný full node** — **pre tento hub nie je potrebné** na overovanie vlastných KYA anchorov: `verifyAnchorOnChain` najprv berie TX z peňaženky `kya-anchor` cez `gettransaction` (funguje pre všetky tx vysielané touto peňaženkou, aj staré), potom `getrawtransaction`, nakoniec mempool.space. Zapínaj `txindex` len ak chceš **úplne bez externého API** a si ochotný prevádzkovať **neprunovaný** archívny uzol (pozri `UMBRAXON.md` §27 Step 2, konflikt s `-prune`).
5. **ToS / advokát** — **zatiaľ vynechané** (operátor); pred veľkým objemom alebo zmenou firmy §32.

---

## Fáza 5 — CRL: GO vs DRY_RUN

- Default: worker beží v **DRY_RUN** (žiadny reálny on-chain CRL broadcast).
- **GO (live broadcast):** v `.env` nastav `CRL_WORKER_BROADCAST_ENABLED=true`, potom:

```bash
pm2 restart kya-crl-worker --update-env
```

- Detailný postup a admin endpointy: **`UMBRAXON.md` §27** (Phase 5), komentáre v [`ecosystem.config.js`](../ecosystem.config.js) pri aplikácii `kya-crl-worker`.
- Pred GO over aspoň jeden: `node scripts/crl-worker.js --once --dry-run` (ak je dokumentovaný v §27).

**Checkpoint:** Rozhodnutie zdokumentované v internom runbooku · prvé hodiny po GO sledovať Telegram + bitcoind log.

---

## Dobíjanie / treasury — kde sú SATy a ako doplniť

**Tri oddelené „hrnce“** (nemiešajú sa automaticky):

| Hrniec | Na čo | Kde to vidíš / ovládaš |
|--------|--------|-------------------------|
| **BTCPay store** (on-chain) | Príjem z **on-chain** platieb do obchodu | BTCPay UI (zostatok store wallet) |
| **`kya-anchor`** (Bitcoin Core) | **Fee za OP_RETURN** (ELITE anchor, CRL) — on-chain | Nie je to isté ako BTCPay tile; pozri nižšie |
| **Alby Hub** (Lightning) | **LN platby** (NWC) — registrácie cez Lightning | Alby Hub UI / kanály |

### A) `kya-anchor` — zostatok (SAT)

Na serveri v `/root/kya-hub`:

```bash
# Prehľad + prahy (JSON do stdout)
node scripts/anchor-wallet-monitor.js --dry-run

# Len zostatok v satoch
node -e "require('dotenv').config(); const b=require('./lib/bitcoind-rpc'); const w=process.env.BITCOIND_ANCHOR_WALLET||'kya-anchor'; (async()=>{ const bal=await b.walletCall(w,'getbalance',[]); console.log(Math.round(Number(bal)*1e8),'sats'); })();"
```

Telegram varovania pri nízkom zostatku: PM2 `kya-anchor-wallet-monitor` — detail [`UMBRAXON.md`](../UMBRAXON.md) §26.12.1.

### B) `kya-anchor` — **nová receive adresa** (kam poslať BTC z burzy / BTCPay hot wallet)

```bash
cd /root/kya-hub && node -e "require('dotenv').config(); const b=require('./lib/bitcoind-rpc'); const w=process.env.BITCOIND_ANCHOR_WALLET||'kya-anchor'; (async()=>{ console.log(await b.walletCall(w,'getnewaddress',['topup-'+new Date().toISOString().slice(0,10),'bech32'])); })();"
```

Alternatíva cez `bitcoin-cli` v Dockeri (názov kontajnera a `-rpcport` podľa tvojho BTCPay/bitcoind setupu — presný príklad v **`UMBRAXON.md`** Phase 4 / bitcoind):

`docker exec <bitcoind_container> bitcoin-cli -datadir=/data -rpcport=<port> -rpcwallet=kya-anchor getnewaddress topup-$(date +%Y%m%d) bech32`

Pošli on-chain BTC na vypísanú **`bc1q…`**; po potvrdení sa zvýši `getbalance` / `balance_sats`.

### C) Alby Hub — čo dobíjať

- Na **prijímanie** LN platieb potrebuješ predovšetkým **inbound likviditu** (kapacita kanála „z druhej strany“), nie len veľký lokálny zostatok.
- **Lokálne (outbound) SATy** — rezerva na poplatky / odosielanie; presná suma závisí od objemu.
- Monitor: [`docs/WATCHTOWER-MONITORING.md`](WATCHTOWER-MONITORING.md) je pre watchtower; pre likviditu pozri **§30 Item 6** / `scripts/lightning-liquidity-monitor.js` a Alby dokumentáciu v `UMBRAXON.md` (Phase 3D/3E).

### D) Zapamätaj si

- **BTCPay on-chain zostatok ≠ `kya-anchor`.** Medzi nimi treba **manuálny** prevod (withdraw z BTCPay / burza → `bc1q…` z kroku B).
- **Alby ≠ BTCPay ≠ bitcoind** — tri samostatné dobitia podľa toho, čo práve dochádza (LN príjem vs on-chain anchor fee).

---

## Registrácia a verejný whitelist

Po úspešnej platbe a webhooku by mal nový agent vystupovať v hub API s novým `kya_id` (chronologický formát `UMBRA-000…` po migrácii `018_hub_kya_seq.sql`). Overenie bez prihlásenia:

```bash
curl -sS 'https://umbraxon.xyz/api/whitelist?limit=20' | jq '.epoch, .count, [.agents[] | {kya_id, agent_name, tier}]'
curl -sS 'https://umbraxon.xyz/api/whitelist/elite?limit=20' | jq '.count'
```

Kontrakt endpointov: **`UMBRAXON.md` §26.5**. Ak agent chýba, skontroluj `elite_listing_status` / anchor pre ELITE a PM2 log `registerAgent` / `webhook`.

**Webhook a TLS:** v BTCPay musí byť webhook URL **`https://<verejná-domena>/api/webhook/btcpay`** (nie localhost cez mŕtvy tunel). Rýchly test: `curl -X POST …/api/webhook/btcpay` s prázdnym JSON → očakávané **400** ak je reťazec dostupný. TLS handshake meraj cez `curl -w '%{time_appconnect}'`. Ak nevidíš `webhook received` v `kya-hub-out.log`, skontroluj **`LOG_LEVEL`** v `.env` (pre tieto riadky nechaj **`info`**). Podrobnejšie: [`docs/DIAGNOSTIC-CHECKLIST.md`](DIAGNOSTIC-CHECKLIST.md) §7.

---

## Rýchle odkazy

- Hlavná príručka: [`UMBRAXON.md`](../UMBRAXON.md)
- Go-live checklist: [`BOOTSTRAP-CHECKLIST.md`](BOOTSTRAP-CHECKLIST.md)
- Deploy: [`DEPLOY-CHECKLIST.md`](DEPLOY-CHECKLIST.md)
