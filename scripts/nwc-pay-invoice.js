#!/usr/bin/env node
/**
 * Pay a BOLT11 invoice via NWC (pay_invoice).
 *
 * Env (first match wins):
 *   NWC_PAY_URI / NWC_PAY_URI_FILE  — outbound wallet (recommended for --auto-pay)
 *   ALBY_NWC_URI / ALBY_NWC_URI_FILE — fallback (same as hub Alby)
 *
 * Usage:
 *   node scripts/nwc-pay-invoice.js '<bolt11>' [--expected-sats 10000] [--dry-run]
 */
'use strict';

require('dotenv').config({
    path: require('path').join(__dirname, '..', '.env'),
    override: true,
    quiet: true,
});

const alby = require('../lib/alby');

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const expIdx = args.indexOf('--expected-sats');
    const expectedSats = expIdx >= 0 ? parseInt(args[expIdx + 1], 10) : null;
    const invoice = args.find((a) => a.startsWith('ln'));

    if (!invoice) {
        console.error('Usage: node scripts/nwc-pay-invoice.js <bolt11> [--expected-sats N] [--dry-run]');
        process.exit(2);
    }

    const payUri = alby.loadPayNwcUri();
    if (!payUri) {
        console.error(JSON.stringify({ ok: false, error: 'NWC_PAY_URI_NOT_CONFIGURED' }));
        process.exit(2);
    }

    const log = {
        info: (o, m) => console.error(m || '', typeof o === 'object' ? JSON.stringify(o) : o || ''),
        warn: (o, m) => console.error(m || '', typeof o === 'object' ? JSON.stringify(o) : o || ''),
        error: (o, m) => console.error(m || '', typeof o === 'object' ? JSON.stringify(o) : o || ''),
    };

    await alby.connect(log, { nwcUri: payUri, forceReconnect: true });
    const bal = await alby.getBalance();
    const out = {
        ok: true,
        dry_run: dryRun,
        balance_sats: bal.balanceSats,
        expected_sats: expectedSats,
        invoice_prefix: invoice.slice(0, 24),
    };

    if (expectedSats && bal.balanceSats < expectedSats) {
        out.ok = false;
        out.error = 'INSUFFICIENT_BALANCE';
        console.log(JSON.stringify(out));
        process.exit(3);
    }

    if (dryRun) {
        console.log(JSON.stringify(out));
        await alby.disconnect();
        return;
    }

    const meta = { comment: 'KYA Hub registration invoice' };
    if (process.env.REGISTRATION_ID) meta.registration_id = process.env.REGISTRATION_ID;

    const pay = await alby.payInvoice({
        invoice,
        amountSats: expectedSats || undefined,
        metadata: meta,
    });
    out.preimage = pay.preimage ? `${pay.preimage.slice(0, 16)}...` : null;
    out.fees_paid_sats = pay.feesPaidSats;
    console.log(JSON.stringify(out));
    await alby.disconnect();
}

main().catch((e) => {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
});
