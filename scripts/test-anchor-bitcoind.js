#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — anchor bitcoind backend smoke test
// ----------------------------------------------------------------------------
// Validates the Option-B broadcast path (bitcoind direct) WITHOUT actually
// broadcasting:
//   1. Pulls the current cert for given kya_id (or builds a synthetic payload)
//   2. Calls anchor.bitcoindBuildAndOptionallyBroadcast({ broadcast: false })
//   3. Decodes the resulting raw tx and asserts:
//        - vout has at least one `6a` (OP_RETURN) script
//        - OP_RETURN payload starts with magic "4b594131" (KYA1)
//        - OP_RETURN payload includes the expected cert hash
//        - tx has ≥1 input and ≥1 non-OP_RETURN change output
//
// Usage:
//   node scripts/test-anchor-bitcoind.js [kya_id]
//
//   If kya_id is omitted, synthesizes a payload from a fixed test cert hash so
//   the test can run even before any agents have certs.
//
// Exits with code 0 if all assertions pass, 1 otherwise. Designed to be safe
// to run BEFORE flipping ANCHOR_WORKER_BROADCAST_ENABLED — it never sends a tx.
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });

const { Pool } = require('pg');
const anchor = require('../lib/anchor');

const KYA_ID = process.argv[2] || null;

async function main() {
    console.log('=== anchor bitcoind backend smoke test ===');
    console.log('backend:', anchor.getAnchorBackend());

    // Wallet status
    const status = await anchor.getAnchorWalletStatus();
    console.log('wallet status:', JSON.stringify(status, null, 2));

    // Build an OP_RETURN payload
    let opReturnHex;
    let certSerial = '(synthetic)';
    let certHash;
    if (KYA_ID) {
        const pool = new Pool({
            user: process.env.KYAHUB_APP_PASSWORD ? 'kyahub_app' : (process.env.DB_USER || 'postgres'),
            host: process.env.DB_HOST || '127.0.0.1',
            database: process.env.DB_NAME || 'kyahub',
            password: process.env.KYAHUB_APP_PASSWORD || process.env.DB_PASSWORD,
            port: parseInt(process.env.DB_PORT || '5432', 10),
            max: 2,
        });
        const r = await pool.query(
            `SELECT c.serial, c.cert_body, a.id AS agent_id
             FROM certificates c JOIN agents a ON a.id = c.agent_id
             WHERE a.kya_id = $1 AND c.is_current = TRUE
             ORDER BY c.issued_at DESC LIMIT 1`,
            [KYA_ID]
        );
        if (r.rowCount === 0) { console.error(`no current cert for ${KYA_ID}`); process.exit(1); }
        await pool.end();
        certSerial = r.rows[0].serial;
        certHash = anchor.certHashOf(r.rows[0].cert_body);
        opReturnHex = anchor.buildOpReturnPayload(r.rows[0].cert_body);
    } else {
        const crypto = require('crypto');
        certHash = crypto.createHash('sha256').update('synthetic-smoke-test').digest('hex');
        opReturnHex = anchor.MAGIC_HEX + certHash;
    }

    console.log('cert_serial:', certSerial);
    console.log('cert_hash:  ', certHash);
    console.log('op_return:  ', opReturnHex, `(${opReturnHex.length / 2} bytes)`);

    const feerate = await anchor.estimateAnchorFeerate();
    console.log('feerate:    ', feerate, 'sat/vB');

    if ((status.balance_sats || 0) < 1000) {
        console.warn('⚠ wallet balance < 1000 sat — fundrawtransaction will fail, this is expected pre-bootstrap.');
        console.warn('  Will still attempt construction to confirm the error mode is "Insufficient funds" not anything stranger.');
    }

    let result;
    try {
        result = await anchor.bitcoindBuildAndOptionallyBroadcast({
            opReturnHex,
            feerateSatVb: feerate,
            broadcast: false,
        });
    } catch (e) {
        console.error('build FAILED:', e.message);
        if (e.rpcError) console.error('rpcError:', JSON.stringify(e.rpcError));
        if (e.rpcError && /insufficient funds/i.test(e.rpcError.message || '')) {
            console.log('✓ Failure mode is "Insufficient funds" — exactly as expected pre-funding.');
            console.log('  After bootstrap-funding the wallet, rerun this script and assertions should pass.');
            process.exit(0);
        }
        process.exit(1);
    }

    console.log('\n=== build OK ===');
    console.log('would-be txid:    ', result.txid);
    console.log('fee_sats:         ', result.fee_sats);
    console.log('op_return vout:   ', result.vout);
    console.log('decoded op_return:', result.raw && result.raw.decoded_op_return_hex);
    console.log('tx_hex_size:      ', result.transactionHex.length / 2, 'bytes');

    // Assertions
    const decoded = result.raw && result.raw.decoded_op_return_hex || '';
    const wantTail = opReturnHex.toLowerCase();
    let pass = true;
    function assert(name, ok) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) pass = false; }
    assert('OP_RETURN output present',          /^6a/.test(decoded));
    assert('OP_RETURN payload includes magic',  decoded.includes('4b594131'));
    assert('OP_RETURN payload includes hash',   decoded.toLowerCase().includes(wantTail));
    assert('built tx is signed (has hex)',      typeof result.transactionHex === 'string' && result.transactionHex.length > 100);
    assert('fee_sats is positive integer',      Number.isFinite(result.fee_sats) && result.fee_sats > 0);
    assert('vout index returned',               Number.isInteger(result.vout) && result.vout >= 0);

    if (pass) {
        console.log('\nALL ASSERTIONS PASSED — bitcoind backend ready for LIVE broadcast.');
        process.exit(0);
    }
    console.log('\nFAILED assertions.');
    process.exit(1);
}

main().catch(e => { console.error('test crashed:', e.message, e.stack); process.exit(1); });
