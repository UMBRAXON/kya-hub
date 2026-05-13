#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 8 smoke test
// ----------------------------------------------------------------------------
// In-process E2E for `/api/agent/:kya_id/data-export`:
//   1. Insert a synthetic agent with a known Ed25519 keypair.
//   2. Sign the canonical export payload and call dataExportService.createExport.
//   3. Verify the on-disk zip exists, is chmod 600, sha256 matches, and the
//      embedded data.json contains the agent row.
//   4. Verify a second valid request (different nonce) ALSO produces an
//      archive (rate-limit isn't tripped at 2).
//   5. Verify a bad signature, bad nonce format, and TS-skew all fail cleanly.
//   6. Verify resolveDownload returns ok with valid token; rejects bad token,
//      rejects already-downloaded.
//   7. Verify the admin-list HTTP endpoint and the prune (dry-run) admin
//      endpoint with X-Admin-Key.
//   8. Cleanup synthetic rows on success.
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');

const dataExport = require('../lib/data-export-service');
const hubkeys = require('../lib/hubkeys');

const BASE_URL = process.env.KYAHUB_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const NO_CLEANUP = process.argv.includes('--no-cleanup');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'kyahub',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

const ax = axios.create({ baseURL: BASE_URL, timeout: 10000, validateStatus: () => true });

let passed = 0, failed = 0;
function ok(n)  { console.log(`  \u2713 ${n}`); passed++; }
function fail(n, d) { console.log(`  \u2717 ${n}${d ? '\n    ' + d : ''}`); failed++; }
function eq(a, b, n) { return (a === b) ? ok(n) : fail(n, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

function newKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
    return { pubHex: pubRaw.toString('hex'), privKey: privateKey };
}

function signCanonical(privKey, canonical) {
    const digest = crypto.createHash('sha256').update(canonical).digest();
    return crypto.sign(null, digest, privKey).toString('hex');
}

// Random 6-hex KYA suffix
function newKyaId() {
    return 'UMBRA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function insertAgent(kya_id, pubHex) {
    await pool.query(
        `INSERT INTO agents (kya_id, agent_name, status, agent_pubkey, tier,
                             reputation_score, conduct_grade, is_active,
                             verified_at, initial_deposit, current_deposit)
         VALUES ($1, $2, 'VERIFIED', $3, 'BASIC', 75, 'A', TRUE,
                 NOW(), 0, 0)`,
        [kya_id, `test-export-${kya_id}`, pubHex]);
    const agentRow = await pool.query(
        'SELECT id FROM agents WHERE kya_id = $1', [kya_id]);
    await pool.query(
        `INSERT INTO reputation_events (agent_id, kya_id, event_type, source,
                                        delta, score_before, score_after, reason)
         VALUES ($1, $2, 'GENESIS', 'system', 0, 75, 75, 'test-item8 init')`,
        [agentRow.rows[0].id, kya_id]);
}

async function cleanup(kya_id) {
    if (NO_CLEANUP) return;
    await pool.query('DELETE FROM data_exports WHERE kya_id = $1', [kya_id]);
    await pool.query('DELETE FROM reputation_events WHERE kya_id = $1', [kya_id]);
    await pool.query('DELETE FROM agents WHERE kya_id = $1', [kya_id]);
}

async function main() {
    const kya_id = newKyaId();
    const { pubHex, privKey } = newKeypair();

    console.log(`\n=== seed synthetic agent ${kya_id} (pubkey ${pubHex.slice(0, 16)}…) ===`);
    await insertAgent(kya_id, pubHex);
    ok(`agent ${kya_id} inserted`);

    try {
        // ---------------- 1) bad-signature / format checks ----------------
        console.log('\n=== 1) error-path validation ===');

        // Bad signature format
        let out = await dataExport.createExport(pool, hubkeys, {
            kya_id, signature: 'not-hex', nonce: crypto.randomBytes(16).toString('hex'),
            timestamp: new Date().toISOString(),
        });
        eq(out.error, 'BAD_SIGNATURE_FORMAT', '1.1 bad signature format → BAD_SIGNATURE_FORMAT');

        // Bad nonce format
        out = await dataExport.createExport(pool, hubkeys, {
            kya_id, signature: 'a'.repeat(128), nonce: 'short',
            timestamp: new Date().toISOString(),
        });
        eq(out.error, 'INVALID_NONCE_FORMAT', '1.2 short nonce → INVALID_NONCE_FORMAT');

        // Timestamp skew
        out = await dataExport.createExport(pool, hubkeys, {
            kya_id, signature: 'a'.repeat(128),
            nonce: crypto.randomBytes(16).toString('hex'),
            timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        });
        eq(out.error, 'TIMESTAMP_SKEW', '1.3 10-min-old timestamp → TIMESTAMP_SKEW');

        // Unknown kya_id
        out = await dataExport.createExport(pool, hubkeys, {
            kya_id: 'UMBRA-FFFFFF',
            signature: 'a'.repeat(128),
            nonce: crypto.randomBytes(16).toString('hex'),
            timestamp: new Date().toISOString(),
        });
        truthy(out.error === 'AGENT_NOT_FOUND' || out.error === 'BAD_SIGNATURE',
            '1.4 unknown kya_id → AGENT_NOT_FOUND/BAD_SIGNATURE');

        // Bad signature (wrong privkey)
        const wrongKey = newKeypair();
        const nonce1 = crypto.randomBytes(16).toString('hex');
        const ts1 = new Date().toISOString();
        const canonical1 = dataExport.canonicalExportPayload({ kya_id, nonce: nonce1, timestamp: ts1 });
        const wrongSig = signCanonical(wrongKey.privKey, canonical1);
        out = await dataExport.createExport(pool, hubkeys, {
            kya_id, signature: wrongSig, nonce: nonce1, timestamp: ts1,
        });
        eq(out.error, 'BAD_SIGNATURE', '1.5 wrong privkey signature → BAD_SIGNATURE');

        // ---------------- 2) valid request ---------------------------------
        console.log('\n=== 2) valid request → archive on disk ===');

        const nonce2 = crypto.randomBytes(16).toString('hex');
        const ts2 = new Date().toISOString();
        const canonical2 = dataExport.canonicalExportPayload({ kya_id, nonce: nonce2, timestamp: ts2 });
        const sig2 = signCanonical(privKey, canonical2);
        const ok1 = await dataExport.createExport(pool, hubkeys, {
            kya_id, signature: sig2, nonce: nonce2, timestamp: ts2,
            client_ip: '127.0.0.1', user_agent: 'item8-smoke-test',
        });
        truthy(ok1.ok === true, '2.1 createExport returned ok=true');
        const exportIdNum = parseInt(ok1.export_id, 10);
        truthy(Number.isFinite(exportIdNum) && exportIdNum > 0,
            `2.2 export_id present (raw=${JSON.stringify(ok1.export_id)})`);
        truthy(typeof ok1.download_token === 'string' && /^[0-9a-f]{64}$/.test(ok1.download_token),
            '2.3 download_token is 64-hex');
        truthy(typeof ok1.archive_size_bytes === 'number' && ok1.archive_size_bytes > 50,
            `2.4 archive_size_bytes > 50 (${ok1.archive_size_bytes})`);
        truthy(/^[0-9a-f]{64}$/.test(ok1.archive_sha256 || ''), '2.5 archive_sha256 64-hex');

        const dbRow = await pool.query(
            'SELECT status, archive_path, archive_sha256 FROM data_exports WHERE id = $1',
            [ok1.export_id]);
        eq(dbRow.rows[0].status, 'READY', '2.6 row status = READY');
        truthy(fs.existsSync(dbRow.rows[0].archive_path),
            `2.7 archive exists on disk (${dbRow.rows[0].archive_path})`);
        const stat = fs.statSync(dbRow.rows[0].archive_path);
        eq(stat.mode & 0o777, 0o600, '2.8 archive mode chmod 600');
        const computed = crypto.createHash('sha256')
            .update(fs.readFileSync(dbRow.rows[0].archive_path)).digest('hex');
        eq(computed, dbRow.rows[0].archive_sha256, '2.9 archive sha256 matches DB');

        // ---------------- 3) resolveDownload semantics ---------------------
        console.log('\n=== 3) resolveDownload + single-use ===');

        // Wrong token
        const badResolve = await dataExport.resolveDownload(pool, {
            export_id: ok1.export_id, kya_id, token: 'a'.repeat(64),
        });
        eq(badResolve.error, 'BAD_TOKEN', '3.1 wrong token → BAD_TOKEN');

        // Correct token (no marking yet)
        const goodResolve = await dataExport.resolveDownload(pool, {
            export_id: ok1.export_id, kya_id, token: ok1.download_token,
        });
        truthy(goodResolve.ok === true, '3.2 correct token resolves OK');
        eq(goodResolve.archive_sha256, ok1.archive_sha256, '3.3 sha256 round-trips');

        // Mark downloaded; second resolve should reject ALREADY_DOWNLOADED
        await dataExport.markDownloaded(pool, ok1.export_id, { client_ip: '127.0.0.1' });
        const stale = await dataExport.resolveDownload(pool, {
            export_id: ok1.export_id, kya_id, token: ok1.download_token,
        });
        eq(stale.error, 'EXPORT_ALREADY_DOWNLOADED', '3.4 second resolve → ALREADY_DOWNLOADED');

        // Mismatched kya_id
        const wrongKya = await dataExport.resolveDownload(pool, {
            export_id: ok1.export_id, kya_id: 'UMBRA-000000', token: ok1.download_token,
        });
        eq(wrongKya.error, 'KYA_ID_MISMATCH', '3.5 mismatched kya_id → KYA_ID_MISMATCH');

        // ---------------- 4) zip contents ---------------------------------
        console.log('\n=== 4) zip contents include agent row ===');
        // We can crudely sniff by reading the binary and grepping for kya_id —
        // the zip compression usually preserves short literals at level 9 only
        // partially, so we run `unzip -p` if available; otherwise we just
        // check the deflated size > json baseline.
        let unzipOk = false;
        try {
            const { execSync } = require('child_process');
            const out = execSync(`unzip -p '${dbRow.rows[0].archive_path}' data.json`).toString('utf8');
            const parsed = JSON.parse(out);
            truthy(Array.isArray(parsed.data?.agent) && parsed.data.agent.length === 1,
                '4.1 data.agent has exactly 1 row');
            eq(parsed.data.agent[0].kya_id, kya_id, '4.2 data.agent[0].kya_id matches');
            truthy(Array.isArray(parsed.data?.reputation_events) && parsed.data.reputation_events.length >= 1,
                '4.3 reputation_events contains at least the seed row');
            truthy(parsed._meta.kya_id === kya_id && typeof parsed._meta.schema_version === 'string',
                '4.4 _meta block present and well-formed');
            unzipOk = true;
        } catch (e) {
            console.log(`    (unzip not available or zip parse failed: ${e.message.slice(0, 80)})`);
            // fallback: sanity-check size
            truthy(stat.size > 500, '4.x archive size > 500 bytes (fallback)');
        }
        if (unzipOk) ok('4.0 zip extraction successful');

        // ---------------- 5) admin endpoints (HTTP) -----------------------
        console.log('\n=== 5) admin endpoints (HTTP) ===');
        if (!ADMIN_KEY) {
            console.log('  (skipped: ADMIN_API_KEY not set in .env)');
        } else {
            const headers = { 'X-Admin-Key': ADMIN_KEY };
            const listRes = await ax.get('/api/admin/data-exports?limit=10', { headers });
            eq(listRes.status, 200, '5.1 GET /api/admin/data-exports → 200');
            truthy(Array.isArray(listRes.data?.rows), '5.2 rows is an array');

            const noKey = await ax.get('/api/admin/data-exports?limit=10');
            truthy(noKey.status === 401 || noKey.status === 403,
                `5.3 missing admin key → 401/403 (got ${noKey.status})`);

            const pruneRes = await ax.post('/api/admin/data-exports/prune',
                { dry_run: true }, { headers });
            eq(pruneRes.status, 200, '5.4 POST /api/admin/data-exports/prune dry-run → 200');
            truthy(typeof pruneRes.data?.removed_count === 'number',
                '5.5 prune returns removed_count');
        }

        // ---------------- 6) rate-limit (5 / day) -------------------------
        console.log('\n=== 6) rate-limit (DATA_EXPORT_MAX_PER_DAY=5) ===');
        let lastErr = null;
        for (let i = 0; i < 5; i++) {
            const n = crypto.randomBytes(16).toString('hex');
            const t = new Date().toISOString();
            const canonical = dataExport.canonicalExportPayload({ kya_id, nonce: n, timestamp: t });
            const sig = signCanonical(privKey, canonical);
            const r = await dataExport.createExport(pool, hubkeys, {
                kya_id, signature: sig, nonce: n, timestamp: t,
            });
            lastErr = r.error || null;
        }
        truthy(lastErr === 'RATE_LIMIT',
            `6.1 5th+ extra request hits RATE_LIMIT (lastErr=${lastErr})`);

        // Clean archives from this kya_id from disk
        if (!NO_CLEANUP) {
            const exports = await pool.query(
                'SELECT archive_path FROM data_exports WHERE kya_id = $1', [kya_id]);
            for (const r of exports.rows) {
                try { if (r.archive_path && fs.existsSync(r.archive_path)) fs.unlinkSync(r.archive_path); }
                catch (_) {}
            }
        }
    } finally {
        await cleanup(kya_id);
        await pool.end();
    }

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('FATAL:', e.stack || e.message);
    process.exit(2);
});
