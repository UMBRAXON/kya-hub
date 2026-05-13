#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 11 smoke test
// ----------------------------------------------------------------------------
// Seeds two synthetic agents settled on a fixed historical date, then runs
// `scripts/dac8-export.js --date <that day>`, and asserts:
//   1. The CSV file is created with the expected header + 2 rows.
//   2. The JSON file is well-formed and contains both agents.
//   3. The manifest sha256 matches the actual file sha256.
//   4. The `backup_log` row was written with `backup_kind='dac8_export'`.
//   5. BTC/EUR rate was fetched (or marked unavailable cleanly).
//   6. The rate cache file lives at the expected path.
//   7. The CSV escapes correctly when a row contains commas / quotes.
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'kyahub',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

let passed = 0, failed = 0;
function ok(n)  { console.log(`  \u2713 ${n}`); passed++; }
function fail(n, d) { console.log(`  \u2717 ${n}${d ? ' — ' + d : ''}`); failed++; }
function eq(a, b, n) { return (a === b) ? ok(n) : fail(n, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

const TEST_DATE = '2024-01-02'; // far enough in the past that production data is unlikely to overlap
const exportDir = process.env.DAC8_EXPORT_DIR || '/root/kya-hub/exports';
const csvPath  = path.join(exportDir, `dac8-${TEST_DATE.replace(/-/g, '')}.csv`);
const jsonPath = path.join(exportDir, `dac8-${TEST_DATE.replace(/-/g, '')}.json`);
const manifestPath = path.join(exportDir, `dac8-${TEST_DATE.replace(/-/g, '')}.manifest.json`);

const SEED_KYAS = ['UMBRA-AA1101', 'UMBRA-AA1102'];

async function seed() {
    const ts = `${TEST_DATE} 12:00:00`;
    await pool.query(
        `INSERT INTO agents (kya_id, agent_name, status, tier, conduct_grade,
                              payment_invoice_id, payment_method,
                              payment_amount_sats, payment_settled_at,
                              cert_serial, cert_issued_at, manifest_hash,
                              reputation_score, is_active)
         VALUES
            ($1, 'dac8-test-1', 'VERIFIED', 'BASIC', 'A', 'inv-test-1', 'lightning',
             3000, $3::timestamp, 'CERT-DAC8-1', $3::timestamp,
             '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 75, TRUE),
            ($2, 'dac8-test-2', 'VERIFIED', 'ELITE', 'A', 'inv-with,comma', 'btc-onchain',
             12500, $3::timestamp, 'CERT-DAC8-2', $3::timestamp,
             'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 95, TRUE)`,
        [SEED_KYAS[0], SEED_KYAS[1], ts]);
    // Set anchor_txid on the ELITE row
    await pool.query(
        `UPDATE agents SET anchor_txid = $1 WHERE kya_id = $2`,
        ['deadbeef'.repeat(8), SEED_KYAS[1]]);
}

async function cleanup() {
    await pool.query('DELETE FROM backup_log WHERE backup_kind = $1 AND metadata->>\'date\' = $2',
        ['dac8_export', TEST_DATE]);
    await pool.query('DELETE FROM agents WHERE kya_id = ANY($1::text[])', [SEED_KYAS]);
    for (const p of [csvPath, jsonPath, manifestPath]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
}

async function main() {
    // Pre-clean in case a previous run left state
    await cleanup();
    console.log(`\n=== seeding 2 synthetic agents on ${TEST_DATE} ===`);
    await seed();
    ok('agents inserted');

    try {
        console.log('\n=== running scripts/dac8-export.js --date ' + TEST_DATE + ' ===');
        const out = execSync(`node ${path.join(__dirname, 'dac8-export.js')} --date ${TEST_DATE}`,
            { encoding: 'utf-8' });
        truthy(out.includes('rows in window: 2'),
            '1.1 export reports 2 rows in window');
        truthy(fs.existsSync(csvPath),  '1.2 CSV exists');
        truthy(fs.existsSync(jsonPath), '1.3 JSON exists');
        truthy(fs.existsSync(manifestPath), '1.4 manifest exists');

        const csv = fs.readFileSync(csvPath, 'utf8');
        const lines = csv.trim().split('\n');
        truthy(lines.length === 3, `1.5 CSV has 3 lines (header + 2 rows), got ${lines.length}`);
        truthy(lines[0].startsWith('timestamp,payment_hash,amount_sats,'),
            '1.6 CSV header starts with expected fields');
        // payment_invoice_id contains a comma → must be quoted in CSV
        truthy(csv.includes('"inv-with,comma"'),
            '1.7 comma-bearing payment_invoice_id is double-quoted in CSV');

        const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        eq(j.rows.length, 2, '2.1 JSON rows length 2');
        eq(j._meta.row_count, 2, '2.2 _meta.row_count = 2');
        eq(j._meta.total_sats, 15500, '2.3 _meta.total_sats = 15500');
        truthy(typeof j._meta.rate === 'object', '2.4 _meta.rate object present');

        const rowKyaIds = j.rows.map(r => r.agent_kya_id).sort();
        eq(JSON.stringify(rowKyaIds), JSON.stringify(SEED_KYAS.slice().sort()),
            '2.5 JSON contains both seeded kya_ids');
        const eliteRow = j.rows.find(r => r.tier === 'ELITE');
        truthy(eliteRow && /^[a-f0-9]{64}$/.test(eliteRow.anchor_txid),
            `2.6 ELITE row anchor_txid is 64 hex (${eliteRow?.anchor_txid?.slice(0,16)}…)`);

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const actualCsvHash = crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');
        eq(manifest.csv_sha256, actualCsvHash, '3.1 manifest.csv_sha256 = actual sha256');
        const actualJsonHash = crypto.createHash('sha256').update(fs.readFileSync(jsonPath)).digest('hex');
        eq(manifest.json_sha256, actualJsonHash, '3.2 manifest.json_sha256 = actual sha256');
        eq(manifest.row_count, 2, '3.3 manifest.row_count = 2');
        eq(manifest.total_sats, 15500, '3.4 manifest.total_sats = 15500');

        const bl = await pool.query(
            `SELECT * FROM backup_log
              WHERE backup_kind = 'dac8_export'
                AND metadata->>'date' = $1
              ORDER BY id DESC LIMIT 1`,
            [TEST_DATE]);
        eq(bl.rowCount, 1, '4.1 backup_log row inserted');
        const row = bl.rows[0];
        truthy(row.destination === 'b2+local' || row.destination === 'local',
            `4.2 destination is b2+local or local (got ${row.destination})`);
        truthy(row.status === 'OK' || row.status === 'PARTIAL',
            `4.3 status is OK or PARTIAL (got ${row.status})`);
        eq(row.sha256, actualCsvHash, '4.4 backup_log sha256 matches');

        // rate source check
        const expectedRateCachePath = path.join(
            process.env.DAC8_RATE_CACHE_DIR || '/root/kya-hub/.dac8-rate-cache',
            `${TEST_DATE}.json`);
        if (j._meta.rate.rate_source === 'coingecko_history' || j._meta.rate.rate_source === 'coingecko_spot') {
            truthy(typeof j._meta.rate.rate_eur === 'number' && j._meta.rate.rate_eur > 0,
                `5.1 rate_eur is a positive number (${j._meta.rate.rate_eur})`);
            truthy(fs.existsSync(expectedRateCachePath),
                `6.1 rate cache file created at ${expectedRateCachePath}`);
        } else {
            console.log(`  (rate fetch was unavailable: ${j._meta.rate.rate_source}; skipping 5.1/6.1)`);
            ok('5.1 rate gracefully marked unavailable (no fatal)');
        }
    } finally {
        await cleanup();
        await pool.end();
    }

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(async e => {
    console.error('FATAL:', e.stack || e.message);
    try { await cleanup(); await pool.end(); } catch (_) {}
    process.exit(2);
});
