#!/usr/bin/env node
// UMBRAXON BTCPay Gateway — Test Suite
// Spúšťaj: node test-btcpay.js
//   alebo: node test-btcpay.js --webhook-only
//   alebo: node test-btcpay.js --skip-invoice
require('dotenv').config();

const axios = require('axios');
const crypto = require('crypto');
const http = require('http');

const BTCPAY_URL = process.env.BTCPAY_URL;
const BTCPAY_API_KEY = process.env.BTCPAY_API_KEY;
const BTCPAY_STORE_ID = process.env.BTCPAY_STORE_ID;
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET;
const LOCAL_SERVER = process.env.LOCAL_SERVER || `http://127.0.0.1:${process.env.PORT || 3000}`;

const args = process.argv.slice(2);
const webhookOnly = args.includes('--webhook-only');
const skipInvoice = args.includes('--skip-invoice');

const c = {
    g: (s) => `\x1b[32m${s}\x1b[0m`,
    r: (s) => `\x1b[31m${s}\x1b[0m`,
    y: (s) => `\x1b[33m${s}\x1b[0m`,
    b: (s) => `\x1b[36m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`
};

let passed = 0, failed = 0;
function ok(name, info = '') { passed++; console.log(`  ${c.g('✓')} ${name} ${c.dim(info)}`); }
function fail(name, err) { failed++; console.log(`  ${c.r('✗')} ${name}\n    ${c.r(err)}`); }
async function run(name, fn) {
    try { await fn(); } catch (e) { fail(name, e.message || String(e)); }
}

(async () => {
    console.log(c.b('\n=== UMBRAXON BTCPay Gateway Test Suite ===\n'));

    // ----------------- TEST 1: env -----------------
    console.log(c.b('[1] ENV configuration'));
    await run('BTCPAY_URL set', () => {
        if (!BTCPAY_URL) throw new Error('chýba .env: BTCPAY_URL');
        ok('BTCPAY_URL set', `(${BTCPAY_URL})`);
    });
    await run('BTCPAY_API_KEY set', () => {
        if (!BTCPAY_API_KEY) throw new Error('chýba .env: BTCPAY_API_KEY');
        ok('BTCPAY_API_KEY set', `(${BTCPAY_API_KEY.slice(0, 6)}...${BTCPAY_API_KEY.slice(-4)})`);
    });
    await run('BTCPAY_STORE_ID set', () => {
        if (!BTCPAY_STORE_ID) throw new Error('chýba .env: BTCPAY_STORE_ID');
        ok('BTCPAY_STORE_ID set', `(${BTCPAY_STORE_ID.slice(0, 8)}...)`);
    });
    await run('BTCPAY_WEBHOOK_SECRET set', () => {
        if (!BTCPAY_WEBHOOK_SECRET) throw new Error('chýba .env: BTCPAY_WEBHOOK_SECRET');
        ok('BTCPAY_WEBHOOK_SECRET set', `(${BTCPAY_WEBHOOK_SECRET.length} znakov)`);
    });

    // ----------------- TEST 2: BTCPay API connectivity -----------------
    if (!webhookOnly) {
        console.log(c.b('\n[2] BTCPay Server API connectivity'));
        await run('GET /api/v1/stores/{storeId}/invoices?take=1', async () => {
            const res = await axios.get(`${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices?take=1`, {
                headers: { 'Authorization': `token ${BTCPAY_API_KEY}` },
                timeout: 10000,
                validateStatus: () => true
            });
            if (res.status !== 200) {
                throw new Error(`HTTP ${res.status}: ${(res.data && res.data.message) || JSON.stringify(res.data).slice(0, 200)}`);
            }
            ok('store API key works', `(${Array.isArray(res.data) ? res.data.length : 0} invoices vrátených)`);
        });

        // ----------------- TEST 3: invoice create -----------------
        if (!skipInvoice) {
            console.log(c.b('\n[3] Invoice lifecycle'));
            let testInvoiceId = null;
            await run('POST create test invoice (BASIC tier, 10000 SATS)', async () => {
                const res = await axios.post(`${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices`, {
                    amount: 10000,
                    currency: "SATS",
                    metadata: { agentName: 'TEST-BOT-' + Date.now(), pubkey: 'test', amount: 10000, test: true },
                    checkout: { speedPolicy: "HighSpeed" }
                }, {
                    headers: { 'Authorization': `token ${BTCPAY_API_KEY}`, 'Content-Type': 'application/json' },
                    timeout: 10000,
                    validateStatus: () => true
                });
                if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
                testInvoiceId = res.data.id;
                ok('invoice created', `(id=${testInvoiceId}, status=${res.data.status})`);
                console.log(`    ${c.dim('checkoutLink:')} ${res.data.checkoutLink}`);
            });

            if (testInvoiceId) {
                await run('GET invoice payment-methods (BOLT11)', async () => {
                    const res = await axios.get(
                        `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${testInvoiceId}/payment-methods`,
                        { headers: { 'Authorization': `token ${BTCPAY_API_KEY}` }, timeout: 10000, validateStatus: () => true }
                    );
                    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
                    const methods = (res.data || []).map(m => m.paymentMethod || m.paymentMethodId);
                    ok('payment methods present', `[${methods.join(', ')}]`);
                });

                await run('GET invoice status', async () => {
                    const res = await axios.get(
                        `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices/${testInvoiceId}`,
                        { headers: { 'Authorization': `token ${BTCPAY_API_KEY}` }, timeout: 5000 }
                    );
                    ok('status fetched', `(${res.data.status})`);
                });

                // ----------------- TEST 4: Local server endpoints -----------------
                console.log(c.b('\n[4] Local server endpoints'));
                await run('GET /api/health', async () => {
                    const res = await axios.get(`${LOCAL_SERVER}/api/health`, { timeout: 5000, validateStatus: () => true });
                    if (res.status !== 200) throw new Error(`HTTP ${res.status} — server beží?`);
                    ok('health endpoint', `(db=${res.data.database}, btcpay=${res.data.btcpay})`);
                });

                await run('GET /api/tiers', async () => {
                    const res = await axios.get(`${LOCAL_SERVER}/api/tiers`, { timeout: 5000, validateStatus: () => true });
                    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
                    if (res.data.BASIC.total !== 10000) throw new Error(`BASIC.total = ${res.data.BASIC.total}, očakávané 10000`);
                    if (res.data.ELITE.total !== 50000) throw new Error(`ELITE.total = ${res.data.ELITE.total}, očakávané 50000`);
                    ok('tiers endpoint', `(BASIC=${res.data.BASIC.total}, ELITE=${res.data.ELITE.total})`);
                });

                await run('POST /api/pay (BASIC)', async () => {
                    const res = await axios.post(`${LOCAL_SERVER}/api/pay`, {
                        agentName: 'TEST-LOCAL-' + Date.now(),
                        amount: 10000,
                        pubkey: 'testpub',
                        manifest: { role: 'test' }
                    }, { timeout: 15000, validateStatus: () => true });
                    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data)}`);
                    if (!res.data.invoiceId) throw new Error('chýba invoiceId v response');
                    if (!res.data.paymentRequest) throw new Error('chýba paymentRequest (LNURL/BOLT11) — peňaženka nedostane QR');
                    const uri = res.data.paymentRequest;
                    const isLightning = uri.toLowerCase().startsWith('lightning:');
                    const isBitcoin = uri.toLowerCase().startsWith('bitcoin:');
                    if (!isLightning && !isBitcoin && !uri.toLowerCase().startsWith('lnbc') && !uri.toLowerCase().startsWith('lnurl')) {
                        throw new Error('paymentRequest má neznámy formát: ' + uri.slice(0, 30));
                    }
                    ok('pay endpoint', `(method=${res.data.paymentMethod}, uri=${uri.slice(0, 40)}...)`);
                });

                await run('POST /api/pay (invalid tier)', async () => {
                    const res = await axios.post(`${LOCAL_SERVER}/api/pay`, {
                        agentName: 'TEST',
                        amount: 1234,
                    }, { timeout: 5000, validateStatus: () => true });
                    if (res.status !== 400) throw new Error(`očakávaná HTTP 400, dostal ${res.status}`);
                    ok('invalid tier rejected', `(error=${res.data.error})`);
                });

                await run('GET /api/check-status/:id', async () => {
                    const res = await axios.get(`${LOCAL_SERVER}/api/check-status/${testInvoiceId}`, { timeout: 5000, validateStatus: () => true });
                    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
                    ok('check-status', `(status=${res.data.status}, btcpay=${res.data.btcpayStatus})`);
                });
            }
        }
    }

    // ----------------- TEST 5: Webhook HMAC signature -----------------
    console.log(c.b('\n[5] Webhook signature verification'));

    const fakePayload = JSON.stringify({
        type: 'InvoiceSettled',
        invoiceId: 'TEST-INV-' + Date.now(),
        metadata: {
            agentName: 'TEST-WEBHOOK-BOT-' + Date.now(),
            pubkey: 'fake-pubkey',
            amount: 10000,
            manifest: { test: true }
        }
    });

    const validSig = 'sha256=' + crypto.createHmac('sha256', BTCPAY_WEBHOOK_SECRET).update(fakePayload).digest('hex');
    const invalidSig = 'sha256=' + crypto.createHmac('sha256', 'wrong-secret').update(fakePayload).digest('hex');

    await run('POST webhook with VALID signature', async () => {
        const res = await axios.post(`${LOCAL_SERVER}/api/webhook/btcpay`, fakePayload, {
            headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': validSig },
            timeout: 10000,
            validateStatus: () => true
        });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.data}`);
        ok('valid signature accepted', `(HTTP 200)`);
    });

    await run('POST webhook with INVALID signature → must reject', async () => {
        const res = await axios.post(`${LOCAL_SERVER}/api/webhook/btcpay`, fakePayload, {
            headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': invalidSig },
            timeout: 5000,
            validateStatus: () => true
        });
        if (res.status !== 401) throw new Error(`očakávaná HTTP 401, dostal ${res.status}`);
        ok('invalid signature rejected', `(HTTP 401)`);
    });

    await run('POST webhook without signature → must reject', async () => {
        const res = await axios.post(`${LOCAL_SERVER}/api/webhook/btcpay`, fakePayload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000,
            validateStatus: () => true
        });
        if (res.status !== 400) throw new Error(`očakávaná HTTP 400, dostal ${res.status}`);
        ok('missing signature rejected', `(HTTP 400)`);
    });

    // ----------------- SUMMARY -----------------
    console.log('\n' + c.b('=== SUMMARY ==='));
    console.log(`${c.g('✓ Passed:')} ${passed}`);
    console.log(`${failed > 0 ? c.r('✗ Failed:') : '✗ Failed:'} ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
    console.error(c.r('\nFATAL:'), e);
    process.exit(2);
});
