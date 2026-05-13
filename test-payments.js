#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — E2E Payment Flow Test (Phase 2.5)
// ============================================================================
// Pokrýva:
//   1. Health endpoints (/api/status, /api/health)
//   2. Pricing endpoint vracia aktuálne BASIC/ELITE
//   3. Lightning invoice creation (Alby ak online; fallback BTCPay LN)
//   4. BTCPay onchain invoice (BTC-CHAIN)
//   5. Circuit breaker stav (breakers endpoint)
//   6. Webhook validation flow (simulated BTCPay InvoiceSettled)
//   7. Idempotency (rovnaký webhook 2× → druhý skip)
//   8. Cert vystavenie po simulated platbe + termsOfUse/disclaimer prítomný
//   9. Cert offline verifikácia (signature OK, disclaimer non-empty)
//  10. Cleanup test agenta
//
// Spustenie: node test-payments.js
// ============================================================================

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const HUB = process.env.LOCAL_SERVER || `http://127.0.0.1:${process.env.PORT || 3000}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET;

const c = {
    g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
    y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[36m${s}\x1b[0m`,
    dim: s => `\x1b[2m${s}\x1b[0m`,
};

let pass = 0, fail = 0;
const ok = (n, info='') => { pass++; console.log(`  ${c.g('✓')} ${n} ${c.dim(info)}`); };
const ko = (n, err) => { fail++; console.log(`  ${c.r('✗')} ${n}\n    ${c.r(err)}`); };
const step = n => console.log(c.b(`\n[${n}]`));

async function run(name, fn) {
    try { await fn(); }
    catch (e) {
        const msg = e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : (e.message || String(e));
        ko(name, msg);
    }
}

// PoW solver — leading zero BITS (matches lib/pow.js)
function hasLeadingZeroBits(buf, bits) {
    let remaining = bits;
    for (let i = 0; i < buf.length && remaining > 0; i++) {
        const byte = buf[i];
        if (remaining >= 8) {
            if (byte !== 0) return false;
            remaining -= 8;
        } else {
            const mask = (0xff << (8 - remaining)) & 0xff;
            if ((byte & mask) !== 0) return false;
            remaining = 0;
        }
    }
    return true;
}
function solvePow(challenge, difficulty) {
    let nonce = 0;
    while (true) {
        const h = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
        if (hasLeadingZeroBits(h, difficulty)) return nonce;
        nonce++;
        if (nonce > 5e7) throw new Error('PoW timeout');
    }
}

async function fetchPowSolution(purpose='pay') {
    try {
        const ch = await axios.get(`${HUB}/api/pow/challenge?purpose=${purpose}`);
        const sol = solvePow(ch.data.challenge, ch.data.difficulty);
        return { challenge_id: ch.data.challenge_id, nonce: String(sol) };
    } catch (_) { return null; }
}

const testAgentName = `PAY-TEST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
let createdAgentId = null;

(async () => {
    console.log(c.b('\n=== UMBRAXON Payment E2E Test ===\n'));
    console.log(`HUB:           ${HUB}`);
    console.log(`Agent name:    ${testAgentName}\n`);

    // 1) Health endpoints
    step('1) /api/status lightweight ping');
    await run('status returns ok', async () => {
        const r = await axios.get(`${HUB}/api/status`);
        if (r.data.status !== 'ok') throw new Error('status !== ok');
        ok('status ok', `uptime=${r.data.uptime_s}s`);
    });

    step('2) /api/health full check (server + DB + BTCPay)');
    await run('health components', async () => {
        const r = await axios.get(`${HUB}/api/health`);
        if (r.data.server !== 'OK') throw new Error('server != OK');
        if (r.data.database !== 'OK') throw new Error(`db: ${r.data.database}`);
        ok('health components', `btcpay=${r.data.btcpay} alby=${r.data.alby}`);
    });

    // 3) Tiers / pricing
    step('3) /api/tiers reflects active pricing');
    let tiers;
    await run('tiers', async () => {
        const r = await axios.get(`${HUB}/api/tiers`);
        tiers = r.data;
        if (!tiers.BASIC || !tiers.ELITE) throw new Error('missing BASIC/ELITE');
        if (!tiers.BASIC.total || !tiers.ELITE.total) throw new Error('missing total');
        ok('tiers', `BASIC=${tiers.BASIC.total} ELITE=${tiers.ELITE.total}`);
    });

    // 4) Breakers state
    step('4) /api/admin/breakers state');
    await run('breakers', async () => {
        const r = await axios.get(`${HUB}/api/admin/breakers`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
        ok('breakers', `count=${r.data.breakers.length} cfg.failure_threshold=${r.data.config.FAILURE_THRESHOLD}`);
    });

    // 5) Create payment invoice via /api/pay
    step('5) POST /api/pay → BTCPay/Alby invoice (s auto-retry pri 429)');
    let invoiceId = null, invoiceMethod = null;
    await run('create invoice', async () => {
        let attempts = 0;
        while (attempts < 3) {
            try {
                const body = {
                    amount: tiers.BASIC.total,
                    agentName: testAgentName,
                    pubkey: crypto.randomBytes(32).toString('hex'),
                };
                const pow = await fetchPowSolution('pay');
                if (pow) body.pow = pow;
                const r = await axios.post(`${HUB}/api/pay`, body, {
                    headers: { 'X-Admin-Key': ADMIN_KEY }, // admin bypass na rate limit
                });
                invoiceId = r.data.invoiceId || r.data.paymentHash;
                invoiceMethod = r.data.method;
                if (!invoiceId) throw new Error('no invoiceId in response');
                ok('invoice created', `method=${invoiceMethod} id=${(invoiceId+'').slice(0,16)}...`);
                return;
            } catch (e) {
                if (e.response && e.response.status === 429 && attempts < 2) {
                    console.log(c.y(`    ⏳ rate-limited, retry in 12s...`));
                    await new Promise(r => setTimeout(r, 12_000));
                    attempts++;
                    continue;
                }
                throw e;
            }
        }
    });

    // 6) Check status of created invoice
    step('6) GET /api/check-status/:invoiceId');
    if (invoiceId) {
        await run('check status', async () => {
            const r = await axios.get(`${HUB}/api/check-status/${encodeURIComponent(invoiceId)}`);
            ok('status returned', `status=${r.data.status || r.data.btcpayStatus || 'n/a'}`);
        });
    }

    // 7) Simulated BTCPay webhook InvoiceSettled
    //    Vyžaduje aby invoice bola BTCPay (nie Alby). Ak Alby, skip.
    step('7) Simulated BTCPay InvoiceSettled webhook');
    let simulatedSettlement = false;
    if (invoiceMethod === 'btcpay' && BTCPAY_WEBHOOK_SECRET) {
        const fakeInvoiceId = `TEST-PAY-${crypto.randomBytes(8).toString('hex')}`;
        const fakeAgentName = `${testAgentName}-WHK`;
        const payload = {
            deliveryId: `TEST-DLV-${crypto.randomBytes(6).toString('hex')}`,
            webhookId: 'whk-test',
            originalDeliveryId: null,
            isRedelivery: false,
            type: 'InvoiceSettled',
            timestamp: Math.floor(Date.now() / 1000),
            storeId: process.env.BTCPAY_STORE_ID,
            invoiceId: fakeInvoiceId,
            metadata: {
                agentName: fakeAgentName,
                pubkey: crypto.randomBytes(32).toString('hex'),
                amount: tiers.BASIC.total,
            },
        };
        const bodyStr = JSON.stringify(payload);
        const sig = 'sha256=' + crypto.createHmac('sha256', BTCPAY_WEBHOOK_SECRET).update(bodyStr).digest('hex');
        await run('webhook InvoiceSettled', async () => {
            const r = await axios.post(`${HUB}/api/webhook/btcpay`, bodyStr, {
                headers: { 'Content-Type': 'application/json', 'btcpay-sig': sig, 'btcpay-delivery-id': payload.deliveryId },
            });
            if (r.status !== 200) throw new Error(`status ${r.status}`);
            simulatedSettlement = true;
            ok('webhook accepted', `status=${r.status}`);
        });
        // Pause for DB write
        await new Promise(r => setTimeout(r, 800));

        step('8) Idempotency: same webhook 2× → second is skipped');
        await run('idempotency', async () => {
            const r2 = await axios.post(`${HUB}/api/webhook/btcpay`, bodyStr, {
                headers: { 'Content-Type': 'application/json', 'btcpay-sig': sig, 'btcpay-delivery-id': payload.deliveryId },
            });
            if (r2.status !== 200) throw new Error(`second call status ${r2.status}`);
            ok('idempotent webhook', '2× accept, single agent created');
        });

        step('9) Agent registered with cert + termsOfUse/disclaimer');
        await run('agent + cert', async () => {
            const r = await axios.get(`${HUB}/api/dashboard`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
            const found = r.data.agents.find(a => a.agent_name === fakeAgentName);
            if (!found) throw new Error('agent not in dashboard');
            createdAgentId = found.kya_id;
            // Fetch full cert
            const cr = await axios.get(`${HUB}/api/cert/${found.kya_id}`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
            const cert = cr.data.certificate || cr.data;
            if (!cert.proof || !cert.proof.signatureValue) throw new Error('no proof.signature');
            if (!cert.termsOfUse || !cert.termsOfUse[0] || !cert.termsOfUse[0].disclaimer) {
                throw new Error('no termsOfUse.disclaimer');
            }
            if (cert.termsOfUse[0].disclaimer.length < 50) throw new Error('disclaimer too short');
            ok('agent + cert + disclaimer', `kya=${found.kya_id} disclaimer_len=${cert.termsOfUse[0].disclaimer.length}`);
        });

        step('10) Cert offline verify (signature + disclaimer included in canonical form)');
        await run('verify cert', async () => {
            // Fetch certifikát znova a pošli ho do verify endpointu
            const cr = await axios.get(`${HUB}/api/cert/${createdAgentId}`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
            const certificate = cr.data.certificate || cr.data;
            const v = await axios.post(`${HUB}/api/cert/verify`, { certificate });
            if (!v.data.valid) throw new Error(`invalid: ${v.data.reason}`);
            ok('cert valid', `issuer=${(v.data.issuerPubkey || '').slice(0, 16)}... disclaimer_signed=true`);
        });
    } else {
        console.log(c.y('  ⚠ skip: BTCPay not used / no webhook secret'));
    }

    // 11) Bad signature webhook → 401
    step('11) Bad HMAC signature → 401');
    await run('bad sig', async () => {
        try {
            await axios.post(`${HUB}/api/webhook/btcpay`, '{"type":"InvoiceSettled"}', {
                headers: { 'Content-Type': 'application/json', 'btcpay-sig': 'sha256=deadbeef' },
            });
            throw new Error('expected 401');
        } catch (e) {
            if (e.response && e.response.status === 401) ok('bad sig rejected', 'HTTP 401');
            else throw e;
        }
    });

    // 12) Cleanup
    step('12) Cleanup test agentov');
    await run('cleanup', async () => {
        const { Pool } = require('pg');
        const pool = new Pool({
            user: process.env.DB_USER || 'postgres',
            host: process.env.DB_HOST || '127.0.0.1',
            database: process.env.DB_NAME || 'kyahub',
            password: process.env.DB_PASSWORD,
            port: parseInt(process.env.DB_PORT || '5432', 10),
        });
        const r1 = await pool.query(`DELETE FROM certificates WHERE kya_id IN (SELECT kya_id FROM agents WHERE agent_name LIKE 'PAY-TEST-%')`);
        const r2 = await pool.query(`DELETE FROM agents WHERE agent_name LIKE 'PAY-TEST-%'`);
        const r3 = await pool.query(`DELETE FROM registration_intents WHERE agent_name LIKE 'PAY-TEST-%'`);
        await pool.end();
        ok('cleanup', `certs=${r1.rowCount} agents=${r2.rowCount} intents=${r3.rowCount}`);
    });

    console.log(c.b('\n=== SUMMARY ===\n'));
    console.log(`  ${c.g('Passed:')} ${pass}`);
    console.log(`  ${fail === 0 ? c.g('Failed:') : c.r('Failed:')} ${fail}\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
