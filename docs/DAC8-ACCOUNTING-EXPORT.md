# DAC8 Accounting Export — UMBRAXON KYA-Hub

**Status:** Strategic Sprint §30 Item 11 — 2026-05-12.

## Why

The EU's DAC8 directive (Council Directive 2023/2226) requires
crypto-asset service providers to report transactions to tax
authorities. This script produces the auditor-ready daily CSV + JSON
extract that the operator's accountant uses to feed those reports.

The export is **purely an internal cron job**. It does no on-chain
broadcasting, no payment processing, no agent state mutation. It
reads the same `agents` rows that the public certificate registry
already reads, augments them with the day's BTC/EUR rate, and writes
three files per day.

## Schedule

- Cron via PM2: `kya-dac8-export`, `cron_restart: '0 1 * * *'`
  (01:00 UTC daily), `autorestart: false`. The script processes
  **yesterday** (UTC) so the day is fully settled before extraction.
- Manual back-fill:
  `node scripts/dac8-export.js --date 2026-05-11`
- Dry run (no file write, no DB insert):
  `node scripts/dac8-export.js --date 2026-05-11 --dry-run`

## Output files

Written to `/root/kya-hub/exports/` (chmod 700), three per day:

```
dac8-20260511.csv               UTF-8, comma-delimited, header in row 1
dac8-20260511.json              { _meta: {...}, rows: [...] }
dac8-20260511.manifest.json     { row_count, total_sats, total_eur,
                                  csv_sha256, json_sha256, ... }
```

CSV / JSON column reference:

| column                  | source                                                                     | notes                                                       |
| ----------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `timestamp`             | `agents.payment_settled_at`                                                | ISO-8601                                                    |
| `payment_hash`          | `agents.payment_invoice_id`                                                | BTCPay invoice id OR Lightning payment_hash                 |
| `amount_sats`           | `agents.payment_amount_sats`                                               | integer satoshis                                            |
| `amount_btc_at_settle`  | derived                                                                    | 8 dp                                                        |
| `amount_eur_at_settle`  | `amount_btc * rate_eur`                                                    | 2 dp, empty if rate unavailable                             |
| `btc_eur_rate`          | CoinGecko (see "Rate source" below)                                        | EUR per 1 BTC                                               |
| `rate_source`           | `coingecko_history` / `coingecko_spot` / `unavailable`                     | which CoinGecko endpoint provided the rate                  |
| `tier`                  | `agents.tier`                                                              | BASIC / ELITE                                               |
| `agent_kya_id`          | `agents.kya_id`                                                            | `UMBRA-AB12CD`                                              |
| `agent_manifest_hash`   | `agents.manifest_hash`                                                     | sha256 of canonical manifest                                |
| `anchor_txid`           | `agents.anchor_txid`                                                       | ELITE-only confirmed OP_RETURN tx                           |
| `cert_serial`           | `agents.cert_serial`                                                       | hub-issued                                                  |
| `cert_issued_at`        | `agents.cert_issued_at`                                                    | ISO-8601                                                    |
| `payment_method`        | `agents.payment_method`                                                    | `lightning` / `btc-onchain` / `btcpay-lnurl`                |
| `manufacturer_id`       | `agents.manufacturer_id`                                                   | Phase 4B onboarded agents only                              |
| `mfr_tier`              | `agents.mfr_tier`                                                          | Phase 4B onboarded agents only                              |
| `client_country_iso2`   | (empty)                                                                    | reserved for a future geoIP enrichment; never auto-filled   |

### Rate source

The script tries, in order, for each requested day:

1. Cache lookup at `/root/kya-hub/.dac8-rate-cache/<YYYY-MM-DD>.json`
   — once a day's rate is fetched, it's cached forever.
2. `GET https://api.coingecko.com/api/v3/coins/bitcoin/history?date=DD-MM-YYYY&localization=false`
   → `market_data.current_price.eur` (CoinGecko's 24h average for
   that UTC day; free tier endpoint).
3. Fallback: spot price (`/simple/price?ids=bitcoin&vs_currencies=eur`).
4. If both fail, the row is still emitted but with `btc_eur_rate=""`
   and `rate_source="unavailable"`. The operator can re-run the
   export later once CoinGecko is reachable; the cached rate will
   propagate forward and the manifest's sha256 will change.

The 24h-average path is preferred because it's what the EU DAC8
reference implementation (and most tax software) expects for "day's
fair value".

## Off-Hetzner upload

If `B2_KEY_ID` + `B2_APP_KEY` + `B2_BUCKET` + `B2_S3_ENDPOINT` +
`BACKUP_PASSPHRASE` are all configured (same set as Items 1 + 2), the
script will:

1. Encrypt each of the three files with `openssl enc -aes-256-cbc
   -pbkdf2 -salt` using `BACKUP_PASSPHRASE`.
2. Append an HMAC-SHA256(file, passphrase) integrity sidecar.
3. Upload to `s3://${B2_BUCKET}/dac8/<filename>.enc` via the AWS S3
   CLI (which speaks the B2 S3-compatible API).
4. Insert a `backup_log` row with `backup_kind='dac8_export'`,
   `destination='b2+local'` on success or `'local'` + `status='PARTIAL'`
   if the upload failed.

If B2 is not configured, the operator gets local-only retention. The
`backup_log` row still goes in.

## Restore / spot-check procedure

1. Download `dac8-20260511.csv.enc` from B2 (or copy from the local
   `/root/kya-hub/exports/` directory).
2. Verify HMAC:
   `cat dac8-20260511.csv.enc.hmac` should match
   `openssl dgst -sha256 -hmac "$BACKUP_PASSPHRASE" dac8-20260511.csv.enc`.
3. Decrypt:
   `openssl enc -d -aes-256-cbc -pbkdf2 -salt -in dac8-20260511.csv.enc
     -out dac8-20260511.csv -pass pass:"$BACKUP_PASSPHRASE"`.
4. Compare its sha256 against the `manifest.json` entry recorded for
   that day in `backup_log.sha256`.

## Operator playbook

Monthly accountant handoff:

```bash
# Bundle the past month into a single zip.
cd /root/kya-hub/exports
zip dac8-2026-05.zip dac8-202605*.csv dac8-202605*.json dac8-202605*.manifest.json
# Email/upload that single zip to the accountant.
```

Annual audit:

```bash
# Re-build the year's totals from the manifests:
jq -s 'map(.total_eur) | add' /root/kya-hub/exports/dac8-2026*.manifest.json
```

## Environment variables

| variable                  | default                                | meaning                                            |
| ------------------------- | -------------------------------------- | -------------------------------------------------- |
| `DAC8_EXPORT_DIR`         | `/root/kya-hub/exports`                | output directory (chmod 700)                       |
| `DAC8_RATE_CACHE_DIR`     | `/root/kya-hub/.dac8-rate-cache`       | persistent BTC/EUR rate cache                      |
| `COINGECKO_BASE_URL`      | `https://api.coingecko.com/api/v3`     | for self-hosted CoinGecko proxies (paid tier)      |
| `BACKUP_PASSPHRASE`       | (Item 1)                               | same passphrase as the LN / pg backups             |
| `B2_KEY_ID`/`B2_APP_KEY`/`B2_BUCKET`/`B2_S3_ENDPOINT` | (Item 1)            | same B2 credentials as the LN / pg backups         |
