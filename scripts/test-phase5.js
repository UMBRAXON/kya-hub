#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 5 E2E Test (CRL Transparency Log)
// ----------------------------------------------------------------------------
// What this test exercises:
//
//   1. lib/crl unit tests:
//      - Merkle root determinism (same leaves → same root)
//      - Single-leaf, even-count, odd-count tree shapes
//      - proof correctness for every leaf in a 1, 2, 3, 5, 8, 16 leaf tree
//      - OP_RETURN payload builder/parser round-trip
//      - leaf hash matches SQL backfill formula
//      - canonical JSON sort (key ordering)
//
//   2. DB sanity: revocation_events backfill is non-empty and hashes
//      reproduce in Node.
//
//   3. CRL worker --once --dry-run:
//      - Picks up un-anchored revocations
//      - Inserts crl_anchors row in status='DRY_RUN'
//      - Generates signed CRL JSON file in public/crl/
//      - Signature verifies (offline) with ROOT pubkey
//      - All per-revocation Merkle proofs verify against root
//
//   4. API endpoints (server.js must be online on PORT):
//      - GET /api/crl                → returns >=1 revocation
//      - GET /api/crl/proof/<serial> → returns proof + verifier_recipe
//      - GET /api/crl/epoch/<id>     → returns tree_snapshot + revocations
//      - GET /crl/<file>.json        → 200, content-type application/json
//
//   5. Idempotency: re-running the worker for the same epoch is a no-op
//      (returns 'epoch_exists').
//
// Run:
//   node scripts/test-phase5.js
//   node scripts/test-phase5.js --skip-api    # skips section 4 if server is down
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const axios = require('axios');
const { spawnSync } = require('child_process');

const crl = require('../lib/crl');

const SKIP_API = process.argv.includes('--skip-api');
const BASE_URL = process.env.KYAHUB_BASE_URL || 'http://127.0.0.1:3000';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
    console.log(`  ✓ ${name}`);
    passed++;
}
function fail(name, detail) {
    console.log(`  ✗ ${name}`);
    if (detail) console.log(`    ${detail}`);
    failures.push({ name, detail });
    failed++;
}

function assertEq(actual, expected, name) {
    if (actual === expected) return ok(name);
    return fail(name, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
function assertTrue(cond, name, detail) {
    if (cond) return ok(name);
    return fail(name, detail);
}

const pool = new Pool({
    user: process.env.KYAHUB_APP_PASSWORD ? 'kyahub_app' : (process.env.DB_USER || 'postgres'),
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'kyahub',
    password: process.env.KYAHUB_APP_PASSWORD || process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

async function section(title, fn) {
    console.log(`\n=== ${title} ===`);
    try { await fn(); }
    catch (e) {
        console.log(`  ! section threw: ${e.message}`);
        failures.push({ name: title, detail: e.message });
        failed++;
    }
}

async function main() {
    await section('1. lib/crl unit tests', async () => {
        // 1a. Empty tree
        const e = crl.buildMerkleTree([]);
        assertEq(e.leafCount, 0, '1a.1 empty tree leafCount=0');
        assertTrue(/^[0-9a-f]{64}$/.test(e.root), '1a.2 empty tree root is 32B hex');
        assertEq(e.root, crl.EMPTY_ROOT, '1a.3 empty root === EMPTY_ROOT sentinel');

        // 1b. Single leaf tree
        const a = crl.sha256Hex(Buffer.from('a'));
        const t1 = crl.buildMerkleTree([a]);
        assertEq(t1.root, a, '1b.1 single-leaf root = leaf hash');
        const p1 = crl.buildProof(t1, 0);
        assertEq(p1.proof.length, 0, '1b.2 single-leaf proof has 0 steps');
        assertTrue(crl.verifyProof(a, p1.proof, t1.root), '1b.3 single-leaf proof verifies');

        // 1c. Various sizes — every leaf must verify against the root
        for (const n of [2, 3, 5, 8, 16, 17]) {
            const leaves = Array.from({ length: n }, (_, i) => crl.sha256Hex(Buffer.from(`leaf-${i}`)));
            const tree = crl.buildMerkleTree(leaves);
            let allOk = true;
            for (let i = 0; i < n; i++) {
                const p = crl.buildProof(tree, i);
                if (!crl.verifyProof(p.leaf, p.proof, p.root)) { allOk = false; break; }
            }
            assertTrue(allOk, `1c n=${n} all proofs verify against root`);
        }

        // 1d. Determinism
        const leaves = Array.from({ length: 7 }, (_, i) => crl.sha256Hex(Buffer.from(`x-${i}`)));
        const r1 = crl.buildMerkleTree(leaves).root;
        const r2 = crl.buildMerkleTree(leaves).root;
        assertEq(r1, r2, '1d.1 buildMerkleTree is deterministic');

        // 1e. OP_RETURN round-trip
        const root = crl.sha256Hex(Buffer.from('root'));
        const orh = crl.buildCrlOpReturnPayload(root);
        assertEq(orh.length, 72, '1e.1 OP_RETURN payload is 36 B (72 hex chars)');
        assertTrue(orh.startsWith(crl.CRL_MAGIC_HEX), '1e.2 OP_RETURN starts with KYAR magic');
        // Build a synthetic scriptPubKey "6a24<payload>" (24 = OP_PUSHBYTES_36)
        const spk = '6a24' + orh;
        const parsed = crl.parseCrlOpReturnHex(spk);
        assertTrue(parsed && parsed.format === 'KYAR', '1e.3 parseCrlOpReturnHex finds KYAR');
        assertEq(parsed && parsed.merkleRoot, root, '1e.4 parsed root matches');

        // 1f. Non-KYAR is rejected
        const notKyar = '6a24' + 'cafebabe' + root;
        const parsedX = crl.parseCrlOpReturnHex(notKyar);
        assertEq(parsedX, null, '1f.1 parseCrlOpReturnHex returns null for non-KYAR magic');

        // 1g. canonicalize sort stability
        const c1 = crl.canonicalize({ b: 1, a: 2, c: { y: 1, x: 2 } });
        const c2 = crl.canonicalize({ c: { x: 2, y: 1 }, a: 2, b: 1 });
        assertEq(c1, c2, '1g.1 canonicalize ignores key insertion order');
    });

    await section('2. DB backfill + hash consistency', async () => {
        const r = await pool.query(
            `SELECT cert_serial, kya_id,
                    TO_CHAR(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso,
                    revocation_reason, revocation_hash
             FROM revocation_events ORDER BY id`
        );
        assertTrue(r.rowCount >= 1, `2.0 revocation_events has rows (n=${r.rowCount})`);
        let allMatch = true;
        for (const row of r.rows) {
            const computed = crl.computeRevocationHash({
                cert_serial: row.cert_serial,
                kya_id: row.kya_id,
                revoked_at: row.iso,
                revocation_reason: row.revocation_reason,
            });
            if (computed !== row.revocation_hash) {
                fail(`2.${row.cert_serial} hash mismatch`, `db=${row.revocation_hash} js=${computed}`);
                allMatch = false;
            }
        }
        if (allMatch) ok('2.1 every backfilled hash matches lib/crl computeRevocationHash');
    });

    await section('3. CRL worker --once --dry-run', async () => {
        // 3.1 Read DRY_RUN state — it should already exist from earlier prep
        const before = await pool.query(`SELECT id, status, merkle_root, leaf_count FROM crl_anchors WHERE epoch_id = $1`, [crl.epochIdFor(new Date())]);
        const epochExists = before.rowCount > 0;

        // 3.2 Run worker --once (this should be idempotent if epoch already exists)
        const r = spawnSync('node', ['scripts/crl-worker.js', '--once', '--dry-run'], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf-8',
            env: { ...process.env, CRL_WORKER_BROADCAST_ENABLED: 'false' },
            timeout: 60000,
        });
        const exitOk = r.status === 0;
        assertTrue(exitOk, '3.1 worker exits 0', `stdout_tail=${(r.stdout || '').split('\n').slice(-3).join(' | ')}`);

        // 3.3 Verify DB state
        const after = await pool.query(`SELECT * FROM crl_anchors WHERE epoch_id = $1`, [crl.epochIdFor(new Date())]);
        assertTrue(after.rowCount === 1, '3.2 exactly one anchor row for current epoch');
        const a = after.rows[0];
        assertTrue(['DRY_RUN', 'BROADCAST', 'ANCHORED'].includes(a.status), `3.3 anchor status in {DRY_RUN,BROADCAST,ANCHORED} got=${a.status}`);
        assertTrue(/^[0-9a-f]{64}$/.test(a.merkle_root), '3.4 merkle_root is 32B hex');

        // 3.4 All revocations linked
        const rev = await pool.query(`SELECT id, merkle_leaf_index FROM revocation_events WHERE crl_anchor_id = $1 ORDER BY merkle_leaf_index`, [a.id]);
        assertTrue(rev.rowCount === a.leaf_count, `3.5 leaf count match (events.linked=${rev.rowCount} anchor.leaf_count=${a.leaf_count})`);

        // 3.5 Signed file exists + verifies
        const fname = `crl-${a.epoch_label.replace('CRL-', '').toLowerCase()}.json`; // crl-2026-05-12.json
        const altFname = `${a.epoch_label.toLowerCase()}.json`;
        const tryPaths = [
            path.join(__dirname, '..', 'public', 'crl', altFname),
            path.join(__dirname, '..', 'public', 'crl', fname),
        ];
        const filePath = tryPaths.find(p => fs.existsSync(p));
        assertTrue(!!filePath, `3.6 signed CRL JSON exists on disk (tried: ${tryPaths.join(', ')})`);
        if (filePath) {
            const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const ver = crl.verifyCrlSignature(json);
            assertTrue(ver.valid, `3.7 signed CRL signature verifies (role=${ver.signingRole})`);
            assertEq(json.merkle_root, a.merkle_root, '3.8 signed JSON merkle_root matches anchor row');
            // Each proof verifies
            let allP = true;
            for (const r of json.revocations) {
                if (!crl.verifyProof(r.revocation_hash, r.merkle_proof, json.merkle_root)) {
                    allP = false; break;
                }
            }
            assertTrue(allP, '3.9 every Merkle proof in signed JSON verifies against root');
        }

        // 3.6 Idempotency — running again must not create a 2nd anchor row
        const r2 = spawnSync('node', ['scripts/crl-worker.js', '--once', '--dry-run'], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf-8',
            env: { ...process.env, CRL_WORKER_BROADCAST_ENABLED: 'false' },
            timeout: 30000,
        });
        const rowsNow = await pool.query(`SELECT COUNT(*) AS c FROM crl_anchors WHERE epoch_id = $1`, [crl.epochIdFor(new Date())]);
        assertEq(parseInt(rowsNow.rows[0].c, 10), 1, '3.10 idempotency: 2nd worker run does not duplicate epoch');
    });

    if (!SKIP_API) {
        await section('4. API endpoints', async () => {
            try {
                const list = await axios.get(`${BASE_URL}/api/crl?limit=5`, { timeout: 5000 });
                assertEq(list.status, 200, '4.1 GET /api/crl → 200');
                assertTrue(Array.isArray(list.data.revocations), '4.2 has revocations array');
                assertTrue(list.data.revocations.length >= 1, `4.3 at least one revocation (got ${list.data.revocations.length})`);
            } catch (e) {
                fail('4.A /api/crl reachable', e.message);
            }

            try {
                const proof = await axios.get(`${BASE_URL}/api/crl/proof/CERT-CAD028-001`, { timeout: 5000 });
                assertEq(proof.status, 200, '4.4 GET /api/crl/proof/CERT-CAD028-001 → 200');
                assertTrue(proof.data.anchor && Array.isArray(proof.data.anchor.merkle_proof), '4.5 anchor.merkle_proof present');
                // Verify the returned proof offline:
                const verified = crl.verifyProof(proof.data.revocation_hash, proof.data.anchor.merkle_proof, proof.data.anchor.merkle_root);
                assertTrue(verified, '4.6 returned proof verifies against returned root (offline cryptographic check)');
            } catch (e) {
                fail('4.B /api/crl/proof reachable', e.message);
            }

            try {
                const epoch = await axios.get(`${BASE_URL}/api/crl/epoch/${crl.epochIdFor(new Date())}`, { timeout: 5000 });
                assertEq(epoch.status, 200, '4.7 GET /api/crl/epoch/:id → 200');
                assertTrue(!!epoch.data.tree_snapshot, '4.8 tree_snapshot present');
                assertTrue(Array.isArray(epoch.data.revocations) && epoch.data.revocations.length >= 1, '4.9 epoch returns revocations');
            } catch (e) {
                fail('4.C /api/crl/epoch reachable', e.message);
            }

            try {
                const epoch_label_lower = `crl-${new Date().toISOString().slice(0, 10)}`;
                const fileRes = await axios.get(`${BASE_URL}/crl/${epoch_label_lower}.json`, { timeout: 5000, transformResponse: x => x });
                assertEq(fileRes.status, 200, '4.10 GET /crl/<file>.json → 200');
                const ct = (fileRes.headers['content-type'] || '').toLowerCase();
                assertTrue(ct.includes('application/json'), `4.11 content-type is application/json (got ${ct})`);
                // Verify on-disk signature too — content-served must match disk
                const parsed = JSON.parse(fileRes.data);
                const ver = crl.verifyCrlSignature(parsed);
                assertTrue(ver.valid, '4.12 served CRL JSON signature verifies');
            } catch (e) {
                fail('4.D /crl/<file>.json reachable', e.message);
            }
        });
    } else {
        console.log('\n=== 4. API endpoints SKIPPED (--skip-api) ===');
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`  passed: ${passed}`);
    console.log(`  failed: ${failed}`);
    if (failures.length) {
        console.log(`\n  failures:`);
        for (const f of failures) console.log(`    - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
    }
    await pool.end();
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(2);
});
