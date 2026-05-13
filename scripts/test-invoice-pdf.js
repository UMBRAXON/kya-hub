#!/usr/bin/env node
// ============================================================================
// Strategic Sprint §31 C — PDF invoice render smoke test.
// Renders ONE invoice into /tmp/, prints sha256 + file size + pageCount.
// Does NOT touch DB.
// ============================================================================
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderPdfToFile, getBtcRateEur, satsToEur } = require('../lib/invoice-pdf');

async function main() {
    const fx = await getBtcRateEur();
    const amountSats = 10000;
    const eur = satsToEur(amountSats, fx.rate);
    const outPath = '/tmp/test-invoice-' + Date.now() + '.pdf';

    await renderPdfToFile({
        outPath,
        ctx: {
            invoiceNumber: 'UMX-2026-20260512-9999',
            kyaId: 'UMBRA-DEADBE',
            agentName: 'pdf-smoke-test-bot',
            tier: 'BASIC',
            anchorTxid: null,
            amountSats,
            amountEur: eur,
            btcRateEur: fx.rate,
            paymentMethod: 'lightning',
            paymentHash: '0123456789abcdef'.repeat(4),
            paymentPreimageSha: crypto.createHash('sha256').update('preimage-test').digest('hex'),
            paidAt: new Date(),
            issuedDate: new Date(),
            sellerVatId: '',
        },
    });

    const buf = fs.readFileSync(outPath);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    console.log('PDF path :', outPath);
    console.log('bytes    :', buf.length);
    console.log('sha256   :', sha);
    console.log('fx_source:', fx.source, 'rate=', fx.rate);

    // Best-effort page count — PDFs include "/Type /Page" objects.
    const pageMatches = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || [];
    console.log('page_count_approx:', pageMatches.length);

    // Header sanity
    if (!buf.slice(0, 5).toString().startsWith('%PDF-')) {
        console.error('FAIL: not a valid PDF header');
        process.exit(2);
    } else {
        console.log('header   : %PDF- OK');
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
