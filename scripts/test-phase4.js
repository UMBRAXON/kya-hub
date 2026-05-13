#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 4 End-to-End Test Suite
// ----------------------------------------------------------------------------
// Pokrýva všetkých 5 stretchov + verejné API:
//   P4-1  ELITE signing key (offline cert sign + verify)
//   P4-2  OP_RETURN anchor worker — admin force-anchor simulate path
//   P4-3  Cert reissue s anchor_txid v credentialSubject
//   P4-4  Verejné endpointy /api/whitelist /elite /verify/anchor/:txid
//   P4-5  Webhook delivery priority — overí agent_tier + priority column
//
// Stratégia bez peňazí:
//   1) Vytvor TEST ELITE agenta priamo v DB (cez psql) — nenahradzuje
//      registračný flow (testovaný v Phase 3), validuje len ANCHOR pipeline.
//   2) Vystaví cert ELITE kľúčom (signed) cez admin /reissue-cert endpoint.
//   3) Spustí admin /anchor/force s simulate_txid (fake 64-hex) + simulate_block_height
//      → server vytvorí BROADCAST → ANCHORED → CERT_REISSUED v jednej transakcii.
//   4) Overí, že:
//      - /api/cert/:kya_id vráti new cert s `credentialSubject.anchor.txid`
//      - signature je VALID (Ed25519 offline)
//      - ELITE signing role (single-sig `proof.signingRole` or multi-sig `proof.signatures[].role`)
//      - /api/whitelist/elite obsahuje agenta
//      - /api/verify/anchor/:txid vracia agent info + is_kya_anchor=false
//        (na fake txid bitcoind nenájde tx, ale endpoint vráti agent z DB).
//   5) Cleanup: zmaže test agenta (kya_id začína "UMBRA-TEST" nech sa nemýli s prod).
//
// Použitie:
//   node scripts/test-phase4.js
//   node scripts/test-phase4.js --keep   # nechaj test agenta v DB
//   node scripts/test-phase4.js --base http://localhost:3000
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });

const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const certs = require('../lib/certs');
const hubkeys = require('../lib/hubkeys');
const anchorLib = require('../lib/anchor');

const ARGS = parseArgs(process.argv.slice(2));
const BASE = ARGS.base || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_KEY) { console.error('ADMIN_API_KEY missing in .env'); process.exit(2); }

const TEST_TAG = ARGS.tag || `t4${Math.floor(Math.random() * 1e6).toString(16).padStart(5, '0')}`;
const TEST_NAME = `phase4-test-${TEST_TAG}`;
const TEST_PUBKEY = crypto.randomBytes(32).toString('hex');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'kyahub',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

/** True if cert was signed with ELITE hub key (single-sig or Phase 5b multi-sig). */
function certHasEliteSigningRole(cert) {
    const p = cert && cert.proof;
    if (!p) return false;
    if (p.type === 'Ed25519MultiSignature2020') {
        return Array.isArray(p.signatures)
            && p.signatures.some((s) => s && s.role === 'ELITE');
    }
    return p.signingRole === 'ELITE';
}

const results = [];
function record(id, ok, note) {
    results.push({ id, ok, note });
    const mark = ok ? '✓' : '✗';
    console.log(`  ${mark} ${id.padEnd(28)} ${note}`);
}

function parseArgs(arr) {
    const out = { base: null, keep: false, tag: null };
    for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (a === '--base') out.base = arr[++i];
        else if (a === '--keep') out.keep = true;
        else if (a === '--tag') out.tag = arr[++i];
    }
    return out;
}

const ax = axios.create({
    baseURL: BASE,
    timeout: 15000,
    validateStatus: () => true,
    headers: { 'X-Admin-Key': ADMIN_KEY },
});

async function main() {
    console.log(`\n=== UMBRAXON KYA-Hub — Phase 4 E2E Test ===`);
    console.log(`  base:       ${BASE}`);
    console.log(`  test tag:   ${TEST_TAG}`);
    console.log(`  test name:  ${TEST_NAME}`);
    console.log(``);

    // ----- Step 0: precondition checks -----
    const status = await ax.get('/api/status');
    record('PRE_status_ok', status.status === 200 && status.data.status === 'ok', `status=${status.data && status.data.status}`);

    const pub = await ax.get('/api/hub/pubkey');
    const hasElite = pub.status === 200 && Array.isArray(pub.data.keys) && pub.data.keys.some(k => k.role === 'ELITE');
    record('PRE_elite_key_loaded', hasElite, `ELITE key present in /api/hub/pubkey`);

    // ----- Step 1: create a TEST ELITE agent directly in DB -----
    const kya_id = `UMBRA-${'T' + TEST_TAG.toUpperCase().slice(0,5).padEnd(5, '0')}`;
    // Ensure kya_id matches /^UMBRA-[A-F0-9]{6}$/  → force hex chars
    const hexedTag = TEST_TAG.replace(/[^a-fA-F0-9]/g, '0').slice(0, 6).padEnd(6, '0').toUpperCase();
    const safeKyaId = `UMBRA-${hexedTag}`;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Cleanup any prior test row
        await client.query(`DELETE FROM agents WHERE kya_id = $1`, [safeKyaId]);
        const seal = crypto.createHash('sha256').update(`${TEST_NAME}:${safeKyaId}:50000`).digest('hex');
        const ins = await client.query(
            `INSERT INTO agents (
                kya_id, agent_name, status, reputation_score, agent_pubkey,
                data_hash, origin_node, conduct_grade, tier,
                initial_deposit, current_deposit, agent_manifest,
                valid_until, is_active, last_seen,
                payment_invoice_id, payment_method, payment_amount_sats, payment_settled_at,
                anchor_status
            ) VALUES (
                $1, $2, 'PENDING_ANCHOR', 900, $3,
                $4, 'phase4-test', 'S', 'ELITE',
                50000, 50000, '{}'::jsonb,
                NULL, TRUE, NOW(),
                $5, 'phase4-test', 50000, NOW(),
                'PENDING'
            )
            ON CONFLICT (agent_name) DO UPDATE SET agent_name = EXCLUDED.agent_name
            RETURNING id`,
            [safeKyaId, TEST_NAME, TEST_PUBKEY, seal, `test-invoice-${TEST_TAG}`]
        );
        const agentId = ins.rows[0].id;
        await client.query(
            `INSERT INTO pending_anchors (agent_id, hmac_hash, tier, status)
             VALUES ($1, $2, 'ELITE', 'PENDING')`,
            [agentId, seal]
        );
        await client.query('COMMIT');
        record('S1_create_elite_agent', true, `kya_id=${safeKyaId} agent_id=${agentId}`);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        record('S1_create_elite_agent', false, e.message);
        return finalize();
    } finally {
        client.release();
    }

    // ----- Step 2: issue initial ELITE cert via admin reissue endpoint -----
    const reissue = await ax.post(`/api/admin/agent/${safeKyaId}/reissue-cert`, { reason: 'phase4-test-bootstrap' });
    const issuedOk = reissue.status === 200 && reissue.data.reissued && reissue.data.certificate;
    record('S2_issue_initial_elite_cert',
        issuedOk && certHasEliteSigningRole(reissue.data.certificate),
        `serial=${reissue.data.serial} proof.type=${reissue.data.certificate && reissue.data.certificate.proof && reissue.data.certificate.proof.type}`);
    if (!issuedOk) return finalize();
    const initialCert = reissue.data.certificate;
    const initialSerial = reissue.data.serial;
    const initialVerify = certs.verifyCertSignature(initialCert);
    record('S2_initial_cert_sig_valid', initialVerify.valid, `reason=${initialVerify.reason}`);

    // ----- Step 3: enter PENDING_ANCHOR state (already from S1) and call force-anchor -----
    // Generate a fake 32-byte txid for simulation
    const simulateTxid = crypto.randomBytes(32).toString('hex');
    const simulateBlock = 949999;

    const force = await ax.post('/api/admin/anchor/force', {
        kya_id: safeKyaId,
        simulate_txid: simulateTxid,
        simulate_block_height: simulateBlock,
    });
    const forceOk = force.status === 200 && force.data.ok === true && force.data.simulated_anchored === true;
    record('S3_force_anchor_simulate', forceOk,
        `txid=${simulateTxid.slice(0, 12)}... reissued=${force.data.reissued_cert_serial}`);
    if (!forceOk) {
        console.log('  force response:', JSON.stringify(force.data, null, 2));
        return finalize();
    }

    // ----- Step 4: fetch latest cert and verify anchor field + signature + ELITE role -----
    const certRes = await ax.get(`/api/cert/${safeKyaId}`);
    const certOk = certRes.status === 200 && certRes.data.certificate;
    record('S4_fetch_reissued_cert', certOk, `serial=${certRes.data && certRes.data.serial}`);
    if (!certOk) return finalize();
    const newCert = certRes.data.certificate;

    const verify = certs.verifyCertSignature(newCert);
    record('S4_cert_signature_valid', verify.valid, `reason=${verify.reason} pubkey=${(verify.issuerPubkey || '').slice(0, 12)}...`);
    record('S4_signingRole_is_ELITE', certHasEliteSigningRole(newCert),
        `proof.type=${newCert.proof && newCert.proof.type}`);

    const anch = newCert.credentialSubject && newCert.credentialSubject.anchor;
    record('S4_anchor_field_present', !!anch, anch ? `txid=${anch.txid.slice(0, 12)}... magic=${anch.magic}` : 'missing');
    record('S4_anchor_txid_matches', anch && anch.txid === simulateTxid, `expected=${simulateTxid.slice(0, 12)}...`);

    const expectedCertHash = anchorLib.certHashOf(initialCert);
    record('S4_anchor_cert_hash_matches_initial', anch && anch.cert_hash === expectedCertHash, `expected=${expectedCertHash.slice(0,12)}...`);

    record('S4_anchor_block_height', anch && anch.block_height === simulateBlock, `block_height=${anch && anch.block_height}`);

    // OP_RETURN payload reconstruction check
    const expectedOpReturn = '4b594131' + expectedCertHash;
    const opReturnFromAnchor = anch && (anch.op_return_hex || ('4b594131' + (anch.cert_hash || '')));
    record('S4_op_return_payload_valid',
        opReturnFromAnchor && opReturnFromAnchor.toLowerCase() === expectedOpReturn.toLowerCase(),
        `bytes=${opReturnFromAnchor ? opReturnFromAnchor.length / 2 : '?'} (expected 36)`);

    // ----- Step 5: ensure old cert is now REVOKED -----
    const oldCertRow = await pool.query(
        `SELECT serial, is_current, revoke_reason FROM certificates WHERE kya_id = $1 AND serial = $2`,
        [safeKyaId, initialSerial]
    );
    record('S5_old_cert_revoked',
        oldCertRow.rowCount > 0 && oldCertRow.rows[0].is_current === false && /reissued_with_anchor|reissue/.test(oldCertRow.rows[0].revoke_reason || ''),
        `is_current=${oldCertRow.rows[0] && oldCertRow.rows[0].is_current} reason=${oldCertRow.rows[0] && oldCertRow.rows[0].revoke_reason}`);

    // ----- Step 6: /api/whitelist/elite contains our agent -----
    const wl = await ax.get('/api/whitelist/elite?limit=500');
    const inElite = wl.status === 200 && wl.data.agents.some(a => a.kya_id === safeKyaId);
    record('S6_whitelist_elite_contains_agent', inElite, `count=${wl.data && wl.data.count}`);
    const myEntry = wl.data && wl.data.agents.find(a => a.kya_id === safeKyaId);
    record('S6_whitelist_elite_anchor_txid_match',
        myEntry && myEntry.anchor_txid === simulateTxid,
        `txid=${myEntry && myEntry.anchor_txid && myEntry.anchor_txid.slice(0, 12)}...`);

    // ----- Step 7: /api/whitelist (general) contains our agent -----
    const wlAll = await ax.get('/api/whitelist?limit=500');
    const inAll = wlAll.status === 200 && wlAll.data.agents.some(a => a.kya_id === safeKyaId);
    record('S7_whitelist_contains_agent', inAll, `count=${wlAll.data && wlAll.data.count}`);

    // ----- Step 8: /api/verify/anchor/:txid resolves to our agent via DB reverse-lookup -----
    const verifyAnch = await ax.get(`/api/verify/anchor/${simulateTxid}`);
    record('S8_verify_anchor_endpoint_ok', verifyAnch.status === 200, `status=${verifyAnch.status}`);
    record('S8_verify_anchor_reverse_lookup',
        verifyAnch.data && verifyAnch.data.agent && verifyAnch.data.agent.kya_id === safeKyaId,
        `agent=${verifyAnch.data && verifyAnch.data.agent && verifyAnch.data.agent.kya_id}`);
    record('S8_verify_anchor_cert_hash_present',
        verifyAnch.data && verifyAnch.data.cert && verifyAnch.data.cert.cert_hash_in_anchor === expectedCertHash,
        `cert_hash=${verifyAnch.data && verifyAnch.data.cert && (verifyAnch.data.cert.cert_hash_in_anchor || '').slice(0, 12)}...`);
    // is_kya_anchor will be false for a fake txid (bitcoind doesn't have it) — that's expected.
    record('S8_verify_anchor_on_chain_field_present',
        verifyAnch.data && verifyAnch.data.on_chain !== undefined,
        `on_chain.found=${verifyAnch.data && verifyAnch.data.on_chain && verifyAnch.data.on_chain.found}`);

    // ----- Step 9: anchor audit trail completeness -----
    const audit = await ax.get(`/api/admin/anchor/audit/${safeKyaId}`);
    const events = audit.data && audit.data.events ? audit.data.events.map(e => e.event_type) : [];
    record('S9_audit_has_FORCED_BY_ADMIN', events.includes('FORCED_BY_ADMIN'), `events=${events.join(',')}`);
    record('S9_audit_has_CERT_REISSUED', events.includes('CERT_REISSUED'), `count=${events.length}`);

    // ----- Step 10: pending_anchors row state -----
    const paRow = await pool.query(
        `SELECT status, bitcoin_txid, cert_serial, cert_hash, block_height, reissued_cert_serial
         FROM pending_anchors WHERE agent_id = (SELECT id FROM agents WHERE kya_id = $1)
         ORDER BY id DESC LIMIT 1`,
        [safeKyaId]
    );
    record('S10_pending_anchor_ANCHORED',
        paRow.rowCount > 0 && paRow.rows[0].status === 'ANCHORED',
        `status=${paRow.rows[0] && paRow.rows[0].status} txid=${paRow.rows[0] && (paRow.rows[0].bitcoin_txid || '').slice(0,12)}...`);
    record('S10_pending_anchor_reissue_serial_set',
        paRow.rowCount > 0 && paRow.rows[0].reissued_cert_serial && paRow.rows[0].reissued_cert_serial !== initialSerial,
        `reissued=${paRow.rows[0] && paRow.rows[0].reissued_cert_serial}`);

    // ----- Step 11: webhook_deliveries.agent_tier column works (insert a probe row) -----
    const probeId = `phase4-probe-${TEST_TAG}`;
    try {
        await pool.query(
            `INSERT INTO webhook_deliveries (source, delivery_id, invoice_id, event_type, payload_hash, agent_tier, priority)
             VALUES ('test', $1, $1, 'phase4-probe', 'a'::text, 'ELITE', 9)
             ON CONFLICT DO NOTHING`,
            [probeId]
        );
        const probe = await pool.query(`SELECT agent_tier, priority FROM webhook_deliveries WHERE delivery_id = $1`, [probeId]);
        record('S11_webhook_tier_priority',
            probe.rowCount === 1 && probe.rows[0].agent_tier === 'ELITE' && probe.rows[0].priority === 9,
            `agent_tier=${probe.rows[0] && probe.rows[0].agent_tier} priority=${probe.rows[0] && probe.rows[0].priority}`);
        await pool.query(`DELETE FROM webhook_deliveries WHERE delivery_id = $1`, [probeId]);
    } catch (e) {
        record('S11_webhook_tier_priority', false, e.message);
    }

    // ----- Step 12: webhook admin queue endpoint -----
    const wq = await ax.get('/api/admin/webhooks/queue');
    record('S12_admin_webhook_queue_ok', wq.status === 200 && Array.isArray(wq.data.queue), `count=${wq.data && wq.data.count}`);

    return finalize();
}

async function finalize() {
    let cleaned = false;
    if (!ARGS.keep) {
        try {
            const r = await pool.query(`DELETE FROM agents WHERE agent_name = $1 RETURNING kya_id`, [TEST_NAME]);
            cleaned = r.rowCount > 0;
        } catch (_) { /* ignore */ }
    }
    await pool.end().catch(() => {});

    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    console.log('');
    console.log('=== Summary ===');
    console.log(`  total:    ${results.length}`);
    console.log(`  passed:   ${passed}`);
    console.log(`  failed:   ${failed}`);
    console.log(`  cleanup:  ${ARGS.keep ? 'KEPT (--keep)' : (cleaned ? 'deleted test agent' : 'no rows to delete')}`);
    console.log('');
    if (failed === 0) {
        console.log('🎉 PHASE 4 — ALL CHECKS PASS\n');
        process.exit(0);
    } else {
        console.log('❌ PHASE 4 — FAILURES (see above)\n');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('FATAL:', err.message, err.stack);
    pool.end().catch(() => {});
    process.exit(2);
});
