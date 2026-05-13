#!/usr/bin/env node
/**
 * Real Lightning end-to-end payment test for UMBRAXON KYA-Hub
 *
 * Usage:
 *   node scripts/test-real-ln-payment.js [agentName] [tier=BASIC|ELITE]
 *
 * What it does:
 *   1. Creates a /api/pay request with Alby Lightning method
 *   2. Prints the BOLT11 invoice — pay it from any LN wallet (WoS, Phoenix, ...)
 *   3. Polls /api/check-status/:invoiceId every 2s
 *   4. When settled → verifies agent in DB + cert is signed
 *   5. Runs offline crypto verify on the resulting cert
 */

require('dotenv').config({ path: '/root/kya-hub/.env' });

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const HOST = process.env.KYAHUB_TEST_HOST || 'https://umbraxon.xyz';
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const AGENT_NAME = process.argv[2] || `real-ln-test-${Date.now()}`;
const TIER = (process.argv[3] || 'BASIC').toUpperCase();

const TIER_AMOUNTS = { BASIC: 10000, ELITE: 50000 };
let AMOUNT = TIER_AMOUNTS[TIER];
if (!AMOUNT) {
    console.error(`Invalid tier: ${TIER}. Use BASIC or ELITE.`);
    process.exit(1);
}

// TIER_AMOUNT_OVERRIDE — useful for ad-hoc testing where admin has temporarily
// changed tier price via /api/admin/pricing (e.g. user has limited LN balance).
// Must match the currently-configured tier amount or /api/pay rejects with INVALID_TIER.
if (process.env.TIER_AMOUNT_OVERRIDE) {
    const override = parseInt(process.env.TIER_AMOUNT_OVERRIDE, 10);
    if (Number.isFinite(override) && override > 0) {
        console.log(`  ⚠ TIER_AMOUNT_OVERRIDE: ${TIER} amount ${AMOUNT} → ${override} sats`);
        AMOUNT = override;
    }
}

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, HOST);
        const proto = url.protocol === 'https:' ? https : http;
        const opts = {
            method,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': ADMIN_KEY,
            },
        };
        const req = proto.request(opts, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, body: json });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function canonicalize(obj) {
    if (Array.isArray(obj)) return obj.map(canonicalize);
    if (obj && typeof obj === 'object') {
        return Object.keys(obj).sort().reduce((acc, k) => {
            acc[k] = canonicalize(obj[k]); return acc;
        }, {});
    }
    return obj;
}

async function verifyCert(kyaId) {
    const { body } = await request('GET', `/api/cert/${kyaId}`);
    const cert = body.certificate || body;
    const { proof, ...bodyOnly } = cert;
    const canonical = JSON.stringify(canonicalize(bodyOnly));
    const digest = crypto.createHash('sha256').update(canonical).digest();
    const issuerPubHex = cert.issuer.id.split(':').pop();
    const ED_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    const spki = Buffer.concat([ED_PREFIX, Buffer.from(issuerPubHex, 'hex')]);
    const pubKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const sig = Buffer.from(proof.signatureValue, 'hex');
    return { ok: crypto.verify(null, digest, pubKey, sig), cert };
}

(async () => {
    if (!ADMIN_KEY) {
        console.error('✗ ADMIN_API_KEY missing in .env'); process.exit(2);
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  UMBRAXON KYA-Hub — Real LN Payment Test');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Host       : ${HOST}`);
    console.log(`Agent      : ${AGENT_NAME}`);
    console.log(`Tier       : ${TIER} (${AMOUNT} sats)`);
    console.log(`Method     : alby_ln (NWC over Nostr)`);
    console.log();

    console.log('→ Creating payment invoice via /api/pay ...');
    const { status, body } = await request('POST', '/api/pay', {
        amount: AMOUNT,
        agentName: AGENT_NAME,
        paymentMethod: 'alby_ln',
    });

    if (status !== 200 || !body.paymentRequest) {
        console.error(`✗ /api/pay returned HTTP ${status}:`, body);
        process.exit(3);
    }

    console.log(`✓ Invoice created via ${body.method}`);
    console.log();
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  PAY THIS BOLT11 INVOICE FROM YOUR LIGHTNING WALLET:');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(body.paymentRequest);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Amount      : ${AMOUNT} sats`);
    console.log(`InvoiceId   : ${body.invoiceId}`);
    console.log(`PaymentHash : ${body.paymentHash}`);
    console.log(`Expires     : ${new Date(body.expiresAt * 1000).toISOString()}`);
    console.log();
    console.log('Waiting for payment (polling every 3s, max 5 minutes) ...');

    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;
    let lastStatus = null;

    while (Date.now() - startedAt < TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 3000));

        const { body: statusBody } = await request('GET', `/api/check-status/${body.invoiceId}`);
        const s = statusBody.status || statusBody.state || 'unknown';

        if (s !== lastStatus) {
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            console.log(`  [${elapsed}s] status=${s}`);
            lastStatus = s;
        }

        if (s === 'settled' || s === 'paid' || s === 'verified' || statusBody.settled) {
            console.log();
            console.log('✅ PAYMENT SETTLED!');
            console.log();

            // Wait a moment for agent registration + cert signing to complete
            await new Promise(r => setTimeout(r, 2000));

            // Verify agent exists
            console.log('→ Verifying agent registration...');
            const { body: regBody } = await request('GET', `/api/agent/${AGENT_NAME}`);
            const kyaId = regBody.kya_id || regBody.kyaId || statusBody.kya_id;

            if (!kyaId) {
                console.error('✗ Agent not registered or no kya_id returned');
                console.error('  Response:', JSON.stringify(regBody).substring(0, 200));
                process.exit(4);
            }
            console.log(`✓ Agent registered: ${kyaId}`);

            // Verify cert signature
            console.log('→ Running offline crypto cert verification...');
            const { ok, cert } = await verifyCert(kyaId);

            console.log('═══════════════════════════════════════════════════════════');
            console.log(`  RESULT for ${kyaId}`);
            console.log('═══════════════════════════════════════════════════════════');
            console.log('  Cert ID         :', cert.id);
            console.log('  Tier            :', cert.credentialSubject?.tier);
            console.log('  Grade           :', cert.credentialSubject?.grade);
            console.log('  Reputation      :', cert.credentialSubject?.reputation?.score, `(${cert.credentialSubject?.reputation?.zone})`);
            console.log('  Payment method  :', cert.credentialSubject?.payment_proof?.method);
            console.log('  Payment amount  :', cert.credentialSubject?.payment_proof?.amount_sats, 'sats');
            console.log('  Disclaimer      :', cert.termsOfUse?.length > 0 ? '✓ YES' : '✗ NO');
            console.log('  -----');
            console.log('  SIGNATURE VALID :', ok ? '✅ ✅ ✅  YES' : '❌ ❌ ❌  NO');
            console.log('═══════════════════════════════════════════════════════════');
            process.exit(ok ? 0 : 5);
        }
    }

    console.error(`✗ TIMEOUT after ${TIMEOUT_MS/1000}s — payment not received`);
    console.error('  Invoice not paid (or NWC subscription not delivering events)');
    console.error('  Check pm2 logs kya-hub for "[alby] payment received"');
    process.exit(6);
})().catch(e => { console.error('✗ ERROR:', e.message); process.exit(99); });
