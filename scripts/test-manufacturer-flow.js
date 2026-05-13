#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 4B E2E Smoke Test (Manufacturer Onboarding)
// ----------------------------------------------------------------------------
// Exercises the DB-backed manufacturer onboarding flow end-to-end WITHOUT
// spending any sats and WITHOUT calling /api/register/initiate (which requires
// a payment + a server-issued auth challenge).
//
//   1. Generate an Ed25519 manufacturer keypair (in-test, throwaway).
//   2. Admin: POST /api/admin/manufacturer/register      → PENDING row
//   3. Admin: POST /api/admin/manufacturer/:mid/verify   → VERIFIED row
//   4. Public: GET /api/manufacturer/:mid                → visible
//   5. Public: GET /api/manufacturers                    → contains our mfr
//   6. Build a canonical agent manifest, sha256-hash it, mfr-sign the hash.
//   7. Public: POST /api/manufacturer/attestation        → 200 with id
//   8. Replay the same submission → upsert (no duplicate, still 200)
//   9. Tampered signature submission                     → 401
//  10. DB sanity: row in manufacturer_attestations is unconsumed.
//  11. lib/manufacturer.findUsableAttestation in-process should find it.
//  12. Admin: POST /api/admin/manufacturer/:mid/suspend  → public lookup 404,
//        new attestation submission rejected with MANUFACTURER_NOT_VERIFIED
//  13. Admin: revoke attestation by id                   → consumed_at=null,
//        revoked_at != null
//  14. Cleanup test rows (DELETE attestations + manufacturer) so the DB is
//        unchanged after a successful run.
//
// Run:
//   node scripts/test-manufacturer-flow.js                  # against localhost
//   KYAHUB_BASE_URL=https://hub.umbraxon.xyz node scripts/test-manufacturer-flow.js
//   node scripts/test-manufacturer-flow.js --no-cleanup      # keep rows
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const manufacturer = require('../lib/manufacturer');
const manifestSchema = require('../lib/manifest-schema');
const hubkeys = require('../lib/hubkeys');

const BASE_URL = process.env.KYAHUB_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const NO_CLEANUP = process.argv.includes('--no-cleanup');

if (!ADMIN_KEY) {
    console.error('ADMIN_API_KEY must be set in env or .env. Aborting.');
    process.exit(2);
}

const pool = new Pool({
    user: process.env.KYAHUB_APP_PASSWORD ? 'kyahub_app' : (process.env.DB_USER || 'postgres'),
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'kyahub',
    password: process.env.KYAHUB_APP_PASSWORD || process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

let passed = 0, failed = 0;
const failures = [];

function ok(n)  { console.log(`  \u2713 ${n}`); passed++; }
function fail(n, d) { console.log(`  \u2717 ${n}\n    ${d || ''}`); failed++; failures.push({ n, d }); }
function eq(a, b, n)  { return (a === b) ? ok(n) : fail(n, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

const ax = axios.create({
    baseURL: BASE_URL,
    timeout: 15000,
    validateStatus: () => true,
});

function adminHeaders() { return { 'X-Admin-Key': ADMIN_KEY, 'X-Admin-User': 'test-mfr-flow' }; }

// Generate throwaway Ed25519 keypair, return { pubHex, sk: KeyObject }
function newKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
    return { pubHex: pubRaw.toString('hex'), pubKey: publicKey, privKey: privateKey };
}

function signHashHex(privKey, hashHex) {
    const msg = Buffer.from(hashHex, 'hex');
    return crypto.sign(null, msg, privKey).toString('hex');
}

function buildSampleManifest({ name, pubHex }) {
    return {
        protocol_version: '1.0',
        agent: {
            name,
            version: '1.0.0',
            pubkey: pubHex,
            capabilities: ['payments', 'reputation_check'],
            model: 'kya-test-model',
            runtime: 'node-22',
            description: 'Phase 4B smoke test bot',
        },
        tier_requested: 'BASIC',
        timestamp: new Date().toISOString(),
        nonce: crypto.randomBytes(16).toString('hex'),
    };
}

async function section(title, fn) {
    console.log(`\n=== ${title} ===`);
    try { await fn(); } catch (e) {
        console.log(`  ! section threw: ${e.message}\n${e.stack || ''}`);
        failures.push({ n: title, d: e.message });
        failed++;
    }
}

(async () => {
    // Unique-per-run mfr_id
    const runSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const MFR_ID = `KYA_TEST_${runSuffix}`;
    const mfrKp = newKeypair();
    const agentKp = newKeypair();
    const AGENT_NAME = `kya-test-${runSuffix.toLowerCase()}-bot`;
    const manifest = buildSampleManifest({ name: AGENT_NAME, pubHex: agentKp.pubHex });
    const manifestHash = manifestSchema.manifestHash(manifest);
    const mfrSig = signHashHex(mfrKp.privKey, manifestHash);

    console.log(`mfr_id        = ${MFR_ID}`);
    console.log(`mfr pubkey    = ${mfrKp.pubHex}`);
    console.log(`agent name    = ${AGENT_NAME}`);
    console.log(`agent pubkey  = ${agentKp.pubHex}`);
    console.log(`manifest hash = ${manifestHash}`);

    let createdMfrRowId = null;
    let attestationId = null;

    await section('1. Self-test: manifest signature verifies in-process', async () => {
        const ok1 = hubkeys.verify(Buffer.from(manifestHash, 'hex'), mfrSig, mfrKp.pubHex);
        truthy(ok1, '1.1 hubkeys.verify accepts our mfr sig');
    });

    await section('2. Admin: register manufacturer (PENDING)', async () => {
        const r = await ax.post('/api/admin/manufacturer/register', {
            manufacturer_id: MFR_ID,
            name: `Test Manufacturer ${runSuffix}`,
            pubkey: mfrKp.pubHex,
            tier: 'SILVER',
            country: 'SK',
            contact_email: 'test@umbraxon.xyz',
            description: 'Phase 4B smoke-test entity',
        }, { headers: adminHeaders() });
        eq(r.status, 200, '2.1 register returns 200');
        truthy(r.data && r.data.ok && r.data.manufacturer, '2.2 body has manufacturer');
        if (r.data && r.data.manufacturer) {
            eq(r.data.manufacturer.manufacturer_id, MFR_ID, '2.3 manufacturer_id echo');
            eq(r.data.manufacturer.status, 'PENDING', '2.4 status=PENDING');
            eq(r.data.manufacturer.tier, 'SILVER', '2.5 tier=SILVER');
            truthy(r.data.manufacturer.rep_bonus >= 25, '2.6 rep_bonus default >= 25');
        }
    });

    await section('3. Public: GET /api/manufacturer/:mid (should be 404 while PENDING)', async () => {
        const r = await ax.get(`/api/manufacturer/${MFR_ID}`);
        eq(r.status, 404, '3.1 PENDING mfr not visible publicly');
        // But admin can see PENDING
        const r2 = await ax.get(`/api/manufacturer/${MFR_ID}`, { headers: adminHeaders() });
        eq(r2.status, 200, '3.2 admin can see PENDING via X-Admin-Key');
        truthy(r2.data && r2.data.status === 'PENDING', '3.3 admin sees status=PENDING');
    });

    await section('4. Admin: verify (PENDING -> VERIFIED)', async () => {
        const r = await ax.post(`/api/admin/manufacturer/${MFR_ID}/verify`, {},
            { headers: adminHeaders() });
        eq(r.status, 200, '4.1 verify returns 200');
        truthy(r.data && r.data.manufacturer && r.data.manufacturer.status === 'VERIFIED',
            '4.2 status flipped to VERIFIED');
    });

    await section('5. Public visibility after verification', async () => {
        const r = await ax.get(`/api/manufacturer/${MFR_ID}`);
        eq(r.status, 200, '5.1 public lookup OK');
        truthy(r.data && r.data.status === 'VERIFIED', '5.2 status=VERIFIED');
        // listing
        const r2 = await ax.get('/api/manufacturers?limit=200');
        eq(r2.status, 200, '5.3 list endpoint 200');
        const found = (r2.data && Array.isArray(r2.data.manufacturers))
            ? r2.data.manufacturers.some(m => m.manufacturer_id === MFR_ID)
            : false;
        truthy(found, '5.4 our mfr appears in /api/manufacturers');
    });

    await section('6. Public: submit attestation (happy path)', async () => {
        const r = await ax.post('/api/manufacturer/attestation', {
            manufacturer_id: MFR_ID,
            manifest,
            mfr_signature: mfrSig,
            expected_agent_pubkey: agentKp.pubHex,
            expected_agent_name: AGENT_NAME,
        });
        eq(r.status, 200, '6.1 attestation submit 200');
        truthy(r.data && r.data.ok && r.data.attestation_id, '6.2 has attestation_id');
        eq(r.data.manifest_hash, manifestHash, '6.3 manifest_hash echo matches');
        attestationId = r.data.attestation_id;
    });

    await section('7. Submitting same attestation again (idempotent upsert)', async () => {
        const r = await ax.post('/api/manufacturer/attestation', {
            manufacturer_id: MFR_ID,
            manifest,
            mfr_signature: mfrSig,
        });
        eq(r.status, 200, '7.1 replay still 200');
        eq(r.data.attestation_id, attestationId, '7.2 same attestation_id');
    });

    await section('8. Tampered signature rejected', async () => {
        const bad = mfrSig.replace(/.$/, mfrSig.endsWith('0') ? '1' : '0');
        const r = await ax.post('/api/manufacturer/attestation', {
            manufacturer_id: MFR_ID,
            manifest,
            mfr_signature: bad,
        });
        eq(r.status, 401, '8.1 tampered sig => 401');
        truthy(r.data && r.data.error === 'BAD_MFR_SIGNATURE', '8.2 BAD_MFR_SIGNATURE error code');
    });

    await section('9. DB sanity: unconsumed attestation row exists', async () => {
        const row = await pool.query(
            `SELECT id, agent_id, consumed_at, revoked_at, agent_manifest_hash, mfr_signature
             FROM manufacturer_attestations WHERE id = $1`, [attestationId]
        );
        eq(row.rowCount, 1, '9.1 row in DB');
        if (row.rowCount > 0) {
            const r = row.rows[0];
            createdMfrRowId = Number(r.id);
            eq(r.agent_id, null, '9.2 agent_id IS NULL (unconsumed)');
            eq(r.consumed_at, null, '9.3 consumed_at IS NULL');
            eq(r.revoked_at, null, '9.4 revoked_at IS NULL');
            eq(r.agent_manifest_hash, manifestHash, '9.5 manifest_hash persisted');
        }
    });

    await section('10. lib/manufacturer.findUsableAttestation in-process', async () => {
        const a = await manufacturer.findUsableAttestation(pool, {
            manifest_hash: manifestHash,
            agent_pubkey: agentKp.pubHex,
            agent_name: AGENT_NAME,
        });
        truthy(a && Number(a.id) === attestationId, '10.1 finds the attestation row');
        truthy(a && a.tier === 'SILVER', '10.2 joins manufacturers, tier=SILVER');
        truthy(a && a.rep_bonus >= 25, '10.3 rep_bonus joined');
    });

    await section('11. Admin: suspend, then submission must be rejected', async () => {
        const s = await ax.post(`/api/admin/manufacturer/${MFR_ID}/suspend`,
            { reason: 'test suspension' }, { headers: adminHeaders() });
        eq(s.status, 200, '11.1 suspend 200');
        const r = await ax.post('/api/manufacturer/attestation', {
            manufacturer_id: MFR_ID,
            manifest: buildSampleManifest({ name: AGENT_NAME + '-2', pubHex: agentKp.pubHex }),
            mfr_signature: signHashHex(mfrKp.privKey,
                manifestSchema.manifestHash(buildSampleManifest({
                    name: AGENT_NAME + '-2', pubHex: agentKp.pubHex,
                }))),
        });
        eq(r.status, 403, '11.2 suspended mfr cannot submit (403)');
        truthy(r.data && r.data.error === 'MANUFACTURER_NOT_VERIFIED',
            '11.3 MANUFACTURER_NOT_VERIFIED error code');
        // Public should no longer see them
        const r2 = await ax.get(`/api/manufacturer/${MFR_ID}`);
        eq(r2.status, 404, '11.4 suspended mfr hidden from public');
        // Reverse: verify back
        const v = await ax.post(`/api/admin/manufacturer/${MFR_ID}/verify`, {},
            { headers: adminHeaders() });
        eq(v.status, 200, '11.5 re-verify OK');
    });

    await section('12. Admin: revoke single attestation', async () => {
        const r = await ax.post(`/api/admin/manufacturer/attestation/${attestationId}/revoke`,
            { reason: 'test revoke' }, { headers: adminHeaders() });
        eq(r.status, 200, '12.1 revoke OK');
        // findUsable should now return null
        const a = await manufacturer.findUsableAttestation(pool, {
            manifest_hash: manifestHash,
            agent_pubkey: agentKp.pubHex,
            agent_name: AGENT_NAME,
        });
        truthy(a === null, '12.2 findUsableAttestation returns null after revoke');
    });

    await section('13. P1 hardening: rate-limit + size caps', async () => {
        // Reset bucket so this run starts fresh (in-process — only works
        // because the server reads from .env on reload; tests run against
        // the SAME process for these in-process resets).
        const mfrLib = require('../lib/manufacturer');
        mfrLib._resetMfrBucket(MFR_ID);

        // Capacity for SILVER is 120/hr by default. Burst limit is the full
        // capacity. Pull tokens directly to verify bucket behaviour.
        const cap = mfrLib._tierRateLimit('SILVER');
        let allowedHits = 0;
        for (let i = 0; i < cap + 5; i++) {
            const r = mfrLib._consumeMfrToken(MFR_ID, 'SILVER');
            if (r.allowed) allowedHits++;
        }
        eq(allowedHits, cap, `13.0a bucket allows exactly capacity=${cap} tokens before throttling`);
        // Subsequent call should be denied
        const denied = mfrLib._consumeMfrToken(MFR_ID, 'SILVER');
        truthy(!denied.allowed, '13.0b 1 over capacity => denied');
        truthy(denied.retry_after_seconds > 0, '13.0c retry_after_seconds > 0');

        // Reset for cleanup
        mfrLib._resetMfrBucket(MFR_ID);

        // Metadata size cap
        const huge = 'x'.repeat(8192);
        const r2 = await ax.post('/api/manufacturer/attestation', {
            manufacturer_id: MFR_ID,
            manifest,
            mfr_signature: mfrSig,
            attestation_metadata: { huge },
        });
        eq(r2.status, 413, '13.0d oversized metadata => 413');
        truthy(r2.data && r2.data.error === 'ATTESTATION_METADATA_TOO_LARGE',
            '13.0e ATTESTATION_METADATA_TOO_LARGE error code');
    });

    if (!NO_CLEANUP) {
        await section('14. Cleanup test rows', async () => {
            // The runtime `kyahub_app` role does NOT have DELETE on these
            // tables (production uses soft-delete only). Try DELETE with a
            // privileged pg connection if DB_ADMIN_USER/PASSWORD are set,
            // otherwise fall back to a "logical" cleanup: revoke + REVOKED.
            const adminUser = process.env.DB_ADMIN_USER || process.env.DB_USER;
            const adminPass = process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD;
            let cleaned = false;
            if (adminUser && adminPass && adminUser !== 'kyahub_app') {
                try {
                    const admin = new Pool({
                        user: adminUser, password: adminPass,
                        host: process.env.DB_HOST || '127.0.0.1',
                        database: process.env.DB_NAME || 'kyahub',
                        port: parseInt(process.env.DB_PORT || '5432', 10),
                    });
                    const att = await admin.query(
                        `DELETE FROM manufacturer_attestations WHERE manufacturer_id =
                           (SELECT id FROM manufacturers WHERE manufacturer_id = $1)`,
                        [MFR_ID]
                    );
                    const mfr = await admin.query(
                        `DELETE FROM manufacturers WHERE manufacturer_id = $1`, [MFR_ID]
                    );
                    await admin.end();
                    ok(`14.1 hard-deleted ${att.rowCount} att(s) + ${mfr.rowCount} mfr row(s) via privileged DB user`);
                    cleaned = true;
                } catch (e) {
                    console.log(`  ! privileged DELETE failed (${e.code || e.message}); falling back to soft-cleanup`);
                }
            }
            if (!cleaned) {
                // Soft cleanup via the public revoke API (no DELETE needed).
                const r = await ax.post(`/api/admin/manufacturer/${MFR_ID}/revoke`,
                    { reason: 'test cleanup' }, { headers: adminHeaders() });
                ok(`14.1 soft-cleanup: manufacturer marked REVOKED (http ${r.status}). ` +
                   `To hard-delete, set DB_ADMIN_USER/DB_ADMIN_PASSWORD and re-run, or:\n` +
                   `      DELETE FROM manufacturer_attestations WHERE manufacturer_ext_id = '${MFR_ID}';\n` +
                   `      DELETE FROM manufacturers WHERE manufacturer_id = '${MFR_ID}';`);
            }
        });
    } else {
        console.log('\n(--no-cleanup) leaving rows in DB for inspection.');
        console.log(`  manufacturers.manufacturer_id = ${MFR_ID}`);
        console.log(`  manufacturer_attestations.id  = ${attestationId}`);
    }

    console.log(`\n=== RESULTS ===`);
    console.log(`PASS: ${passed}    FAIL: ${failed}`);
    if (failed > 0) {
        for (const f of failures) console.log(`  - ${f.n}: ${f.d || ''}`);
    }
    await pool.end();
    process.exit(failed > 0 ? 1 : 0);
})().catch(async (e) => {
    console.error('FATAL', e);
    try { await pool.end(); } catch (_) {}
    process.exit(99);
});
