#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — DAC8 daily accounting export
// Strategic Sprint §30 Item 11 — 2026-05-12
// ----------------------------------------------------------------------------
// Once per day at 01:00 UTC, dump every cert / payment settled in the
// previous calendar day to a CSV + JSON pair, encrypted-uploaded to the
// same off-site S3-compatible bucket as Items 1 and 2 (Cloudflare R2
// preferred — set BACKUP_S3_*; legacy Backblaze B2_* still supported).
//
// Output columns (CSV header row identical to JSON keys, lower_snake):
//   timestamp                ISO-8601 settlement time
//   payment_hash             payment invoice id / BTCPay invoice id
//   amount_sats              integer
//   amount_eur_at_settle     numeric (EUR, 2 dp)
//   amount_btc_at_settle     numeric (BTC, 8 dp)
//   btc_eur_rate             numeric (EUR per 1 BTC, 2 dp; source CoinGecko 24h avg)
//   rate_source              `coingecko_24h_avg` | `coingecko_spot` | `cached` | `unavailable`
//   tier                     BASIC | ELITE | (manufacturer slug if Phase 4B path)
//   agent_kya_id             UMBRA-AB12CD
//   agent_manifest_hash      sha256 hex of canonical manifest
//   anchor_txid              ELITE only: confirmed OP_RETURN txid
//   cert_serial              hub-issued cert serial
//   cert_issued_at           ISO-8601
//   payment_method           lightning | btc-onchain | btcpay-lnurl
//   client_country_iso2      always empty in v1 (we don't store this)
//
// Files written:
//   /root/kya-hub/exports/dac8-YYYYMMDD.csv
//   /root/kya-hub/exports/dac8-YYYYMMDD.json
//   /root/kya-hub/exports/dac8-YYYYMMDD.manifest.json   (counts + sha256)
//
// If `BACKUP_S3_*` (or legacy `B2_*`) is configured, every file is
// encrypted with `BACKUP_PASSPHRASE` (same scheme as Items 1/2) and
// uploaded under the `<prefix>dac8/` key path in the bucket. Every run
// leaves a row in `backup_log` with `backup_kind='dac8_export'`.
//
// USAGE:
//   node scripts/dac8-export.js                  # exports yesterday (UTC)
//   node scripts/dac8-export.js --date 2026-05-11  # back-fill specific day
//   node scripts/dac8-export.js --dry-run        # no DB write, no upload
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { Pool } = require('pg');
const axios = require('axios');

const EXPORT_DIR = process.env.DAC8_EXPORT_DIR || '/root/kya-hub/exports';
const BACKUP_PASS = process.env.BACKUP_PASSPHRASE || '';
// S3-compatible (PREFERRED — Cloudflare R2 / AWS S3 / MinIO / DO Spaces / etc.)
const S3_BUCKET = process.env.BACKUP_S3_BUCKET || '';
const S3_AKID = process.env.BACKUP_S3_ACCESS_KEY_ID || '';
const S3_SECRET = process.env.BACKUP_S3_SECRET_ACCESS_KEY || '';
const S3_ENDPOINT = process.env.BACKUP_S3_ENDPOINT || '';
const S3_REGION = process.env.BACKUP_S3_REGION || 'auto';
const S3_PREFIX = (() => {
    let p = process.env.BACKUP_S3_PREFIX || 'kyahub/';
    if (p.startsWith('/')) p = p.slice(1);
    if (p && !p.endsWith('/')) p += '/';
    return p;
})();
// Legacy B2 (only used if BACKUP_S3_* not set)
const B2_BUCKET = process.env.B2_BUCKET || '';
const B2_KEY_ID = process.env.B2_KEY_ID || '';
const B2_APP_KEY = process.env.B2_APP_KEY || '';
const B2_S3_ENDPOINT = process.env.B2_S3_ENDPOINT || '';
const COINGECKO_BASE = process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3';
const RATE_CACHE_DIR = process.env.DAC8_RATE_CACHE_DIR || '/root/kya-hub/.dac8-rate-cache';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateIdx = args.indexOf('--date');
const FORCED_DATE = dateIdx >= 0 ? args[dateIdx + 1] : null;
const FROM_CRON = args.includes('--from-cron');

function isoDay(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function targetDate() {
    if (FORCED_DATE) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(FORCED_DATE)) throw new Error(`bad --date: ${FORCED_DATE}`);
        return FORCED_DATE;
    }
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return isoDay(d);
}

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
}

// CoinGecko: fetch 24h average for the requested calendar day (UTC).
// Strategy:
//   1. Look in the rate cache (`/root/kya-hub/.dac8-rate-cache/<YYYY-MM-DD>.json`).
//   2. If not cached, call `/coins/bitcoin/history?date=DD-MM-YYYY` (free tier).
//   3. Cache it for next run.
// Falls back to `cached: false, rate_source: 'unavailable'` if the API fails
// and there's no cache — the row is still written but with rate=null.
async function getBtcEurRate(yyyymmdd) {
    ensureDir(RATE_CACHE_DIR);
    const cacheFile = path.join(RATE_CACHE_DIR, `${yyyymmdd}.json`);
    if (fs.existsSync(cacheFile)) {
        try {
            return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        } catch (_) {}
    }
    const [y, m, dd] = yyyymmdd.split('-');
    const histUrl = `${COINGECKO_BASE}/coins/bitcoin/history?date=${dd}-${m}-${y}&localization=false`;
    try {
        const r = await axios.get(histUrl, { timeout: 8000 });
        const eur = r?.data?.market_data?.current_price?.eur;
        if (typeof eur === 'number' && eur > 0) {
            const out = { rate_eur: eur, rate_source: 'coingecko_history' };
            try { fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2), { mode: 0o600 }); } catch (_) {}
            return out;
        }
    } catch (e) { /* fall through */ }
    try {
        const r = await axios.get(`${COINGECKO_BASE}/simple/price?ids=bitcoin&vs_currencies=eur`,
            { timeout: 5000 });
        const eur = r?.data?.bitcoin?.eur;
        if (typeof eur === 'number' && eur > 0) {
            const out = { rate_eur: eur, rate_source: 'coingecko_spot' };
            try { fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2), { mode: 0o600 }); } catch (_) {}
            return out;
        }
    } catch (e) { /* fall through */ }
    return { rate_eur: null, rate_source: 'unavailable' };
}

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

async function exportDay(pool, dateStr) {
    const dayStart = new Date(`${dateStr}T00:00:00Z`).toISOString();
    const dayEnd = new Date(`${dateStr}T23:59:59.999Z`).toISOString();
    console.log(`[dac8] export window: ${dayStart} … ${dayEnd}`);

    const rate = await getBtcEurRate(dateStr);
    console.log(`[dac8] BTC/EUR rate: ${rate.rate_eur ?? 'unavailable'} (${rate.rate_source})`);

    const q = await pool.query(
        `SELECT
            a.kya_id,
            a.tier,
            a.manifest_hash,
            a.payment_invoice_id,
            a.payment_method,
            a.payment_amount_sats,
            a.payment_settled_at,
            a.anchor_txid,
            a.cert_serial,
            a.cert_issued_at,
            a.mfr_tier,
            a.manufacturer_id
         FROM agents a
         WHERE a.payment_settled_at >= $1::timestamp
           AND a.payment_settled_at <  $2::timestamp
         ORDER BY a.payment_settled_at ASC`,
        [dayStart, dayEnd]);
    console.log(`[dac8] rows in window: ${q.rowCount}`);

    const rows = q.rows.map(r => {
        const sats = r.payment_amount_sats || 0;
        const btc = sats / 1e8;
        const eur = (rate.rate_eur != null) ? (btc * rate.rate_eur) : null;
        return {
            timestamp:           r.payment_settled_at ? new Date(r.payment_settled_at).toISOString() : '',
            payment_hash:        r.payment_invoice_id || '',
            amount_sats:         sats,
            amount_btc_at_settle: btc.toFixed(8),
            amount_eur_at_settle: eur != null ? eur.toFixed(2) : '',
            btc_eur_rate:        rate.rate_eur != null ? rate.rate_eur.toFixed(2) : '',
            rate_source:         rate.rate_source,
            tier:                r.tier || '',
            agent_kya_id:        r.kya_id || '',
            agent_manifest_hash: r.manifest_hash || '',
            anchor_txid:         r.anchor_txid || '',
            cert_serial:         r.cert_serial || '',
            cert_issued_at:      r.cert_issued_at ? new Date(r.cert_issued_at).toISOString() : '',
            payment_method:      r.payment_method || '',
            manufacturer_id:     r.manufacturer_id || '',
            mfr_tier:            r.mfr_tier || '',
            client_country_iso2: '',
        };
    });

    const totalSats = rows.reduce((s, r) => s + r.amount_sats, 0);
    const totalEur = rows.reduce((s, r) => s + (parseFloat(r.amount_eur_at_settle) || 0), 0);

    const fileBase = `dac8-${dateStr.replace(/-/g, '')}`;
    const csvPath = path.join(EXPORT_DIR, `${fileBase}.csv`);
    const jsonPath = path.join(EXPORT_DIR, `${fileBase}.json`);
    const manifestPath = path.join(EXPORT_DIR, `${fileBase}.manifest.json`);

    ensureDir(EXPORT_DIR);

    const headers = rows.length ? Object.keys(rows[0]) : [
        'timestamp','payment_hash','amount_sats','amount_btc_at_settle',
        'amount_eur_at_settle','btc_eur_rate','rate_source','tier',
        'agent_kya_id','agent_manifest_hash','anchor_txid','cert_serial',
        'cert_issued_at','payment_method','manufacturer_id','mfr_tier',
        'client_country_iso2',
    ];
    const csv = [headers.join(',')]
        .concat(rows.map(r => headers.map(h => csvEscape(r[h])).join(',')))
        .join('\n') + '\n';

    if (!DRY_RUN) {
        fs.writeFileSync(csvPath, csv, { mode: 0o600 });
        fs.writeFileSync(jsonPath, JSON.stringify({
            _meta: {
                date: dateStr,
                generated_at: new Date().toISOString(),
                hub_version: process.env.HUB_VERSION || 'unknown',
                rate: rate,
                row_count: rows.length,
                total_sats: totalSats,
                total_eur: totalEur,
            },
            rows,
        }, null, 2), { mode: 0o600 });
        fs.writeFileSync(manifestPath, JSON.stringify({
            date: dateStr,
            generated_at: new Date().toISOString(),
            row_count: rows.length,
            total_sats: totalSats,
            total_eur: totalEur,
            csv_sha256: crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex'),
            json_sha256: crypto.createHash('sha256').update(fs.readFileSync(jsonPath)).digest('hex'),
        }, null, 2), { mode: 0o600 });
        console.log(`[dac8] wrote ${csvPath} (${rows.length} rows, ${totalSats} sats, €${totalEur.toFixed(2)})`);
    } else {
        console.log(`[dac8] DRY RUN — would write ${csvPath} (${rows.length} rows)`);
    }

    // Optional off-site upload (encrypt + push) — replicates Item 1/2 path.
    // Prefer S3-compat (Cloudflare R2 / AWS S3 / MinIO / etc.); fall back to legacy B2 vars.
    let destination = 'local';
    let uploadError = null;
    let providerKind = 'none';
    let providerBucket = '';
    let providerEndpoint = '';
    let providerAkid = '';
    let providerSecret = '';
    let providerRegion = 'auto';
    let providerPrefix = '';

    if (S3_AKID && S3_SECRET && S3_BUCKET && S3_ENDPOINT) {
        providerKind = 's3-compat';
        providerBucket = S3_BUCKET;
        providerEndpoint = S3_ENDPOINT;
        providerAkid = S3_AKID;
        providerSecret = S3_SECRET;
        providerRegion = S3_REGION;
        providerPrefix = `${S3_PREFIX}dac8/`;
    } else if (B2_KEY_ID && B2_APP_KEY && B2_BUCKET && B2_S3_ENDPOINT) {
        providerKind = 'b2-legacy';
        providerBucket = B2_BUCKET;
        providerEndpoint = B2_S3_ENDPOINT;
        providerAkid = B2_KEY_ID;
        providerSecret = B2_APP_KEY;
        providerRegion = 'us-west-002';
        providerPrefix = 'dac8/';
    }

    if (!DRY_RUN && providerKind !== 'none' && BACKUP_PASS) {
        try {
            for (const src of [csvPath, jsonPath, manifestPath]) {
                const enc = src + '.enc';
                execSync(`openssl enc -aes-256-cbc -pbkdf2 -salt -in '${src}' -out '${enc}' -pass pass:'${BACKUP_PASS}'`,
                    { stdio: ['ignore', 'pipe', 'pipe'] });
                const hmac = crypto.createHmac('sha256', BACKUP_PASS)
                    .update(fs.readFileSync(enc)).digest('hex');
                fs.appendFileSync(enc + '.hmac', hmac);
                const key = `${providerPrefix}${path.basename(enc)}`;
                execSync(
                    `AWS_ACCESS_KEY_ID='${providerAkid}' ` +
                    `AWS_SECRET_ACCESS_KEY='${providerSecret}' ` +
                    `AWS_DEFAULT_REGION='${providerRegion}' ` +
                    `aws s3 cp '${enc}' 's3://${providerBucket}/${key}' ` +
                    `--endpoint-url '${providerEndpoint}' --only-show-errors`,
                    { stdio: ['ignore', 'pipe', 'pipe'] });
                fs.unlinkSync(enc);
                fs.unlinkSync(enc + '.hmac');
            }
            destination = `${providerKind}+local`;
        } catch (e) {
            destination = 'local';
            uploadError = String(e.message || e).slice(0, 500);
            console.warn(`[dac8] off-site upload FAILED (${providerKind}), kept local copy only: ${uploadError}`);
        }
    } else if (!DRY_RUN) {
        console.log('[dac8] off-site backup not configured (BACKUP_S3_* or B2_*) → local-only retention');
    }

    if (!DRY_RUN) {
        try {
            const csvHash = crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');
            await pool.query(
                `INSERT INTO backup_log (backup_kind, object_path, destination, size_bytes,
                                          sha256, encryption, status, error_message, metadata, host)
                 VALUES ('dac8_export', $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
                [
                    csvPath,
                    destination,
                    fs.statSync(csvPath).size,
                    csvHash,
                    destination === 'local' ? 'plain' : 'AES-256-CBC',
                    uploadError ? 'PARTIAL' : 'OK',
                    uploadError,
                    JSON.stringify({
                        date: dateStr, row_count: rows.length,
                        total_sats: totalSats, total_eur: totalEur,
                        rate: rate,
                        provider_kind: providerKind,
                    }),
                    require('os').hostname(),
                ]);
        } catch (e) {
            console.warn(`[dac8] backup_log insert failed: ${e.message}`);
        }
    }

    return {
        date: dateStr,
        csv_path: csvPath,
        json_path: jsonPath,
        manifest_path: manifestPath,
        row_count: rows.length,
        total_sats: totalSats,
        total_eur: totalEur,
        destination,
        provider_kind: providerKind,
        rate,
        upload_error: uploadError,
        dry_run: !!DRY_RUN,
    };
}

async function main() {
    const date = targetDate();
    console.log(`[dac8] target date (UTC): ${date} ${DRY_RUN ? '(DRY RUN)' : ''}${FROM_CRON ? ' [from cron]' : ''}`);
    const pool = new Pool({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || '127.0.0.1',
        database: process.env.DB_NAME || 'kyahub',
        password: process.env.DB_PASSWORD,
        port: parseInt(process.env.DB_PORT || '5432', 10),
    });
    try {
        const out = await exportDay(pool, date);
        console.log('[dac8] result:', JSON.stringify(out, null, 2));
        process.exit(0);
    } catch (e) {
        console.error('[dac8] FATAL:', e.stack || e.message);
        try {
            await pool.query(
                `INSERT INTO backup_log (backup_kind, object_path, destination, status, error_message)
                 VALUES ('dac8_export', $1, 'none', 'FAIL', $2)`,
                [path.join(EXPORT_DIR, `dac8-${date.replace(/-/g, '')}.csv`),
                 String(e.message || e).slice(0, 500)]);
        } catch (_) {}
        process.exit(1);
    } finally {
        await pool.end();
    }
}

if (require.main === module) main();

module.exports = { exportDay, getBtcEurRate };
