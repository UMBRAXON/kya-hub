#!/usr/bin/env node
'use strict';

/**
 * Diagnostika: overí, či LN invoice vytvorená hubom cez NWC existuje na strane
 * Alby/LDK (lookupInvoice). Rieši nezhodu „KYA pending“ vs „v Alby Hub UI nič“.
 *
 * Usage (na stroji s .env / ALBY_NWC_URI ako hub):
 *   node scripts/alby-lookup-invoice.js <payment_hash_hex>
 *
 * payment_hash = pole invoiceId z odpovede POST /api/register/initiate (alby-lightning).
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: true });

const alby = require(path.join(ROOT, 'lib', 'alby'));

const logger = {
  info: () => {},
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

function usage() {
    console.error('Usage: node scripts/alby-lookup-invoice.js <payment_hash_hex_64>');
    console.error('  payment_hash = invoiceId from register/initiate JSON (method alby-lightning).');
    process.exit(2);
}

async function main() {
    const raw = process.argv[2];
    if (!raw || raw.startsWith('-')) usage();
    const paymentHash = String(raw).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
        console.error('payment_hash must be 64 hex chars');
        process.exit(2);
    }

    if (!alby.isConfigured()) {
        console.error('Alby NWC not configured (ALBY_NWC_URI or ALBY_NWC_URI_FILE missing).');
        process.exit(3);
    }

    await alby.connect(logger);
    try {
        const out = await alby.lookupInvoice({ paymentHash });
        console.log(JSON.stringify(out, null, 2));
        process.exit(0);
    } catch (e) {
        console.error(JSON.stringify({ error: 'LOOKUP_FAILED', message: e.message }, null, 2));
        process.exit(1);
    } finally {
        try {
            await alby.disconnect();
        } catch (_) { /* ignore */ }
    }
}

main();
