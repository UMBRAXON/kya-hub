#!/usr/bin/env node
// ============================================================================
// Strategic Sprint §31 C — One-time invoice backfill for historical paying agents.
// ----------------------------------------------------------------------------
// Re-renders PDF invoices for every agent that has a real payment_settled_at
// timestamp + amount, but doesn't yet have a row in the invoices table.
//
// Idempotent: existing rows (matched by payment_hash) are skipped.
//
// Usage:
//   node scripts/backfill-invoices.js                 # backfill all eligible
//   node scripts/backfill-invoices.js --kya UMBRA-AAA # only one agent
//   node scripts/backfill-invoices.js --dry           # show what would be done
// ============================================================================
'use strict';
require('dotenv').config();

const { Pool } = require('pg');
const invoicePdf = require('../lib/invoice-pdf');

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const kyaFilter = (() => {
    const i = process.argv.indexOf('--kya');
    return i > 0 ? process.argv[i + 1] : null;
})();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

(async () => {
    const where = kyaFilter
        ? `WHERE kya_id = '${kyaFilter.replace(/'/g, "''")}' AND payment_amount_sats > 0 AND payment_settled_at IS NOT NULL`
        : `WHERE payment_amount_sats > 0 AND payment_settled_at IS NOT NULL`;
    const r = await pool.query(
        `SELECT id, kya_id, agent_name, tier, payment_invoice_id, payment_method,
                payment_amount_sats, payment_settled_at, anchor_txid
         FROM agents ${where}
         ORDER BY payment_settled_at ASC`);
    console.log(`Eligible agents: ${r.rowCount}`);

    let issued = 0;
    let skipped = 0;
    let failed = 0;
    for (const a of r.rows) {
        const paymentHash = a.payment_invoice_id || `backfill-${a.kya_id}-${Date.parse(a.payment_settled_at) || 0}`;
        const existing = await pool.query(
            'SELECT invoice_number FROM invoices WHERE payment_hash = $1', [paymentHash]);
        if (existing.rowCount > 0) {
            console.log(`  ⏭  ${a.kya_id} (${a.agent_name}) — invoice ${existing.rows[0].invoice_number} already exists`);
            skipped++;
            continue;
        }
        if (DRY) {
            console.log(`  [dry] would issue invoice for ${a.kya_id} amount=${a.payment_amount_sats} sats`);
            continue;
        }
        try {
            const out = await invoicePdf.issueForPayment(pool, {
                agent: { id: a.id, kya_id: a.kya_id, agent_name: a.agent_name, tier: a.tier, anchor_txid: a.anchor_txid },
                paymentMethod: a.payment_method || 'backfill',
                amountSats: a.payment_amount_sats,
                paymentHash,
                paidAt: new Date(a.payment_settled_at),
                logger: console,
            });
            console.log(`  ✓  ${a.kya_id} → ${out.invoice_number}  (${out.pdf_bytes} B, sha=${out.pdf_sha256.slice(0,16)})`);
            issued++;
        } catch (e) {
            console.error(`  ✗  ${a.kya_id}  FAIL: ${e.message}`);
            failed++;
        }
    }
    console.log(`\nDone. issued=${issued} skipped=${skipped} failed=${failed} dry=${DRY}`);
    await pool.end();
})().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
