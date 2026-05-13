#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 1.5 Protocol Test Suite
// ============================================================================
// Simuluje kompletný flow registrácie bota:
//   1. Bot vygeneruje Ed25519 keypair
//   2. Bot zostaví + podpíše manifest
//   3. Bot získa challenge a podpíše ho
//   4. POST /api/register/initiate
//   5. (skip platbu, simulujeme settled webhook s registrationId)
//   6. GET /api/cert/:kya_id
//   7. POST /api/cert/verify
//   8. Offline cert verify
//
// Spustenie: node test-protocol.js
// ============================================================================
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

const BASE = process.env.LOCAL_SERVER || `http://127.0.0.1:${process.env.PORT || 3000}`;
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const manifestSchema = require('./lib/manifest-schema');
const certs = require('./lib/certs');
const pow = require('./lib/pow');

// Použi admin bypass pre rate-limity (testy posielajú veľa requestov v rade).
// Test sa stále plne autenticky overuje cez Ed25519 a PoW gate je zachovaný (testuje sa explicitne).
if (ADMIN_KEY) {
    axios.defaults.headers.common['X-Admin-Key'] = ADMIN_KEY;
}

// Helper: vyrieš PoW pre register endpoint (rýchla difficulty 12 pre testy)
async function getPowSolution(purpose = 'register') {
    const ch = await axios.get(`${BASE}/api/pow/challenge?purpose=${purpose}&difficulty=12`);
    const sol = pow.solve(ch.data.challenge, ch.data.difficulty);
    return {
        challenge_id: ch.data.challenge_id,
        nonce: sol.nonce,
        iterations: sol.iterations,
    };
}

const c = { g: s=>`\x1b[32m${s}\x1b[0m`, r: s=>`\x1b[31m${s}\x1b[0m`, y: s=>`\x1b[33m${s}\x1b[0m`, b: s=>`\x1b[36m${s}\x1b[0m`, d: s=>`\x1b[2m${s}\x1b[0m` };
let passed = 0, failed = 0;
function ok(name, info='') { passed++; console.log(`  ${c.g('✓')} ${name} ${c.d(info)}`); }
function fail(name, err) { failed++; console.log(`  ${c.r('✗')} ${name}\n    ${c.r(err)}`); }
async function run(name, fn) { try { await fn(); } catch (e) { fail(name, e.stack || e.message); } }

// === Ed25519 helpers (rovnaké ako server) ===
const ED25519_PRIV_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function rawPrivToKey(rawHex) {
    return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PRIV_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'pkcs8' });
}
function rawPubToKey(rawHex) {
    return crypto.createPublicKey({ key: Buffer.concat([ED25519_PUB_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'spki' });
}
function genBotKeypair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('hex');
    const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex');
    return { privHex: privRaw, pubHex: pubRaw, priv: privateKey, pub: publicKey };
}
function signWithKey(privKey, msgBuf) {
    return crypto.sign(null, msgBuf, privKey).toString('hex');
}

(async () => {
    console.log(c.b('\n=== UMBRAXON Phase 1.5 Protocol Test ==='));
    
    // 1) Bot identity
    console.log(c.b('\n[1] Bot generuje Ed25519 keypair'));
    const bot = genBotKeypair();
    ok('keypair generated', `pub=${bot.pubHex.slice(0,16)}...`);
    
    // 2) Manifest
    console.log(c.b('\n[2] Bot zostavuje manifest + lokálna validácia'));
    const agentName = 'TEST-BOT-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const manifest = {
        protocol_version: '1.0',
        agent: {
            name: agentName,
            version: '1.0.0',
            pubkey: bot.pubHex,
            capabilities: ['kyc_check', 'btc_payments'],
            model: 'gpt-4o',
            runtime: 'node-22',
        },
        tier_requested: 'BASIC',
        timestamp: new Date().toISOString(),
        nonce: crypto.randomBytes(16).toString('hex'),
    };
    
    await run('lokálna AJV validácia', () => {
        const v = manifestSchema.validate(manifest);
        if (!v.valid) throw new Error('schema FAIL: ' + JSON.stringify(v.errors));
        ok('manifest valid', `name=${agentName}`);
    });
    
    // 3) Manifest podpis
    console.log(c.b('\n[3] Bot podpisuje manifest_hash'));
    const mHash = manifestSchema.manifestHash(manifest);
    const mSig = signWithKey(bot.priv, Buffer.from(mHash, 'hex'));
    ok('signed', `hash=${mHash.slice(0,16)}...  sig=${mSig.slice(0,16)}...`);
    
    // 4) Get challenge
    console.log(c.b('\n[4] GET /api/auth/challenge'));
    let challenge;
    await run('get challenge', async () => {
        const r = await axios.get(`${BASE}/api/auth/challenge?pubkey=${bot.pubHex}`);
        if (!r.data.challenge_id || !r.data.nonce) throw new Error('chýba challenge_id/nonce v odpovedi');
        challenge = r.data;
        ok('got challenge', `id=${challenge.challenge_id.slice(0,16)} nonce=${challenge.nonce.slice(0,16)}... ttl=${challenge.ttl_sec}s`);
    });
    
    // 5) Sign challenge
    console.log(c.b('\n[5] Bot podpisuje challenge nonce'));
    const challengeResponse = signWithKey(bot.priv, Buffer.from(challenge.nonce, 'hex'));
    ok('challenge_response generated', `sig=${challengeResponse.slice(0,16)}...`);
    
    // 6) POST /api/register/initiate (vyžaduje PoW od Phase 2.2)
    console.log(c.b('\n[6] POST /api/register/initiate (s PoW)'));
    let intent;
    await run('initiate registration', async () => {
        const powSol = await getPowSolution('register');
        const r = await axios.post(`${BASE}/api/register/initiate`, {
            manifest,
            manifest_signature: mSig,
            challenge_id: challenge.challenge_id,
            challenge_response: challengeResponse,
            pow: powSol,
        }, { validateStatus: () => true });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
        if (!r.data.registration_id) throw new Error('chýba registration_id');
        intent = r.data;
        ok('initiate OK', `regId=${intent.registration_id.slice(0,16)} invoice=${intent.invoiceId.slice(0,16)} method=${intent.method} pow_iter=${powSol.iterations}`);
    });
    
    // 7) Tamper protection — replay challenge
    console.log(c.b('\n[7] Replay protection: druhý request s tým istým challenge musí padnúť'));
    await run('replay rejected', async () => {
        const powSol = await getPowSolution('register');
        const r = await axios.post(`${BASE}/api/register/initiate`, {
            manifest,
            manifest_signature: mSig,
            challenge_id: challenge.challenge_id,
            challenge_response: challengeResponse,
            pow: powSol,
        }, { validateStatus: () => true });
        if (r.status === 200) throw new Error('replay PRESlo (BAD!)');
        ok('replay rejected', `HTTP ${r.status}: ${r.data.error}`);
    });
    
    // 8) Tamper protection — zmena manifestu po podpise
    console.log(c.b('\n[8] Tamper protection: zmenený manifest s pôvodným podpisom'));
    await run('tampered manifest rejected', async () => {
        const tampered = { ...manifest, tier_requested: 'ELITE' };
        // Nový challenge pre tento test
        const ch2 = await axios.get(`${BASE}/api/auth/challenge?pubkey=${bot.pubHex}`);
        const chResp2 = signWithKey(bot.priv, Buffer.from(ch2.data.nonce, 'hex'));
        const powSol = await getPowSolution('register');
        const r = await axios.post(`${BASE}/api/register/initiate`, {
            manifest: tampered,
            manifest_signature: mSig,  // pôvodný podpis na pôvodný manifest
            challenge_id: ch2.data.challenge_id,
            challenge_response: chResp2,
            pow: powSol,
        }, { validateStatus: () => true });
        if (r.status === 200) throw new Error('tampered manifest PRESlo (BAD!)');
        ok('tampered rejected', `HTTP ${r.status}: ${r.data.error}`);
    });
    
    // 9) Simulácia webhook InvoiceSettled (lebo nemáme synced bitcoind ani Alby)
    console.log(c.b('\n[9] Simulácia BTCPay webhook InvoiceSettled (s registrationId)'));
    let registeredKyaId = null;
    await run('webhook simulation', async () => {
        const webhookBody = JSON.stringify({
            type: 'InvoiceSettled',
            invoiceId: intent.invoiceId,
            metadata: {
                registrationId: intent.registration_id,
                agentName,
                pubkey: bot.pubHex,
                amount: 10000,
            },
        });
        const sig = 'sha256=' + crypto.createHmac('sha256', BTCPAY_WEBHOOK_SECRET).update(webhookBody).digest('hex');
        const r = await axios.post(`${BASE}/api/webhook/btcpay`, webhookBody, {
            headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': sig, 'BTCPay-Delivery-Id': 'TEST-' + Date.now() },
            validateStatus: () => true,
        });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.data}`);
        ok('webhook accepted', 'agent zaregistrovaný');
    });
    
    // 10) GET cert zo DB (cez agent_name → kya_id)
    console.log(c.b('\n[10] Vyhľadanie kya_id v DB a načítanie certifikátu'));
    let cert = null;
    await run('fetch cert by kya_id', async () => {
        // Najprv získať kya_id (cez admin endpoint, alebo cez DB priamo)
        const { Pool } = require('pg');
        const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
        const dbr = await p.query('SELECT kya_id, cert_serial FROM agents WHERE agent_name = $1', [agentName]);
        await p.end();
        if (dbr.rowCount === 0) throw new Error('agent nenájdený v DB');
        registeredKyaId = dbr.rows[0].kya_id;
        const certSerial = dbr.rows[0].cert_serial;
        if (!certSerial) throw new Error('agent existuje ale cert_serial je NULL (cert sa nevystavil)');
        
        const r = await axios.get(`${BASE}/api/cert/${registeredKyaId}`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
        cert = r.data.certificate;
        ok('cert fetched', `serial=${r.data.serial} expires=${r.data.valid_until ? r.data.valid_until.slice(0,10) : 'never'}`);
    });
    
    // 11) Offline verify + reputation check v cert
    console.log(c.b('\n[11] Offline cert signature verify + reputation zone check'));
    await run('offline verify OK', () => {
        const result = certs.verifyCertSignature(cert);
        if (!result.valid) throw new Error(`verify FAIL: ${result.reason}`);
        const rep = cert.credentialSubject.reputation;
        if (!rep || typeof rep.score !== 'number') throw new Error('cert chýba reputation field');
        if (rep.score !== 500) throw new Error(`BASIC bot mal mať score=500, dostal ${rep.score}`);
        if (rep.zone !== 'NEUTRAL') throw new Error(`BASIC bot mal byť v NEUTRAL zóne, je v ${rep.zone}`);
        ok('offline verify', `issuer=${result.issuerPubkey.slice(0,12)}... score=${rep.score} zone=${rep.zone}`);
    });
    
    // 12) Offline verify s tampered cert
    console.log(c.b('\n[12] Offline verify zlyhá pri tampered cert'));
    await run('tampered offline verify rejected', () => {
        const t = JSON.parse(JSON.stringify(cert));
        t.credentialSubject.tier = 'ELITE'; // upgrade!
        const result = certs.verifyCertSignature(t);
        if (result.valid) throw new Error('tampered prešiel (BAD!)');
        ok('tampered rejected', `reason=${result.reason}`);
    });
    
    // 13) Online verify endpoint
    console.log(c.b('\n[13] POST /api/cert/verify (online verifier)'));
    await run('online verify OK', async () => {
        const r = await axios.post(`${BASE}/api/cert/verify`, { certificate: cert });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        if (!r.data.valid) throw new Error(`online verify FAIL: ${r.data.reason}`);
        ok('online verify', `trusted=${r.data.issuer_trusted}  online_found=${r.data.online_status?.found}`);
    });
    
    // 14) Cert status endpoint (revocation check)
    console.log(c.b('\n[14] GET /api/cert/:kya_id/status'));
    await run('status endpoint', async () => {
        const r = await axios.get(`${BASE}/api/cert/${registeredKyaId}/status`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        if (r.data.status !== 'ACTIVE') throw new Error(`expected ACTIVE, got ${r.data.status}`);
        ok('status ACTIVE', `serial=${r.data.serial}`);
    });
    
    // 14.5) Reputation endpoint
    console.log(c.b('\n[14.5] GET /api/agent/:kya_id/reputation'));
    await run('reputation endpoint', async () => {
        const r = await axios.get(`${BASE}/api/agent/${registeredKyaId}/reputation`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        if (r.data.reputation.score !== 500) throw new Error(`expected 500, got ${r.data.reputation.score}`);
        if (r.data.reputation.zone !== 'NEUTRAL') throw new Error(`expected NEUTRAL, got ${r.data.reputation.zone}`);
        if (!r.data.reputation.operational) throw new Error('NEUTRAL zone musi byt operational');
        ok('reputation', `score=${r.data.reputation.score} zone=${r.data.reputation.zone} next=${r.data.reputation.next_zone?.name}@${r.data.reputation.next_zone?.points_needed}pts`);
    });
    
    // 14.6) Reputation model metadata endpoint
    console.log(c.b('\n[14.6] GET /api/protocol/reputation-model'));
    await run('reputation model public info', async () => {
        const r = await axios.get(`${BASE}/api/protocol/reputation-model`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        if (r.data.starting_score?.BASIC !== 500 || r.data.starting_score?.ELITE !== 900) {
            throw new Error(`expected BASIC=500/ELITE=900, got ${JSON.stringify(r.data.starting_score)}`);
        }
        if (!Array.isArray(r.data.zones) || r.data.zones.length !== 5) throw new Error('expected 5 zones');
        ok('model exposed', `zones=${r.data.zones.map(z => z.name).join(',')}`);
    });
    
    // 15) Duplicate pubkey rejection
    console.log(c.b('\n[15] Duplikátne použitie pubkey → 409'));
    await run('duplicate pubkey rejected', async () => {
        const newManifest = {
            ...manifest,
            agent: { ...manifest.agent, name: agentName + '-DUP' },
            timestamp: new Date().toISOString(),
            nonce: crypto.randomBytes(16).toString('hex'),
        };
        const newHash = manifestSchema.manifestHash(newManifest);
        const newSig = signWithKey(bot.priv, Buffer.from(newHash, 'hex'));
        const ch3 = await axios.get(`${BASE}/api/auth/challenge?pubkey=${bot.pubHex}`);
        const chResp3 = signWithKey(bot.priv, Buffer.from(ch3.data.nonce, 'hex'));
        const powSol = await getPowSolution('register');
        const r = await axios.post(`${BASE}/api/register/initiate`, {
            manifest: newManifest,
            manifest_signature: newSig,
            challenge_id: ch3.data.challenge_id,
            challenge_response: chResp3,
            pow: powSol,
        }, { validateStatus: () => true });
        if (r.status !== 409) throw new Error(`expected 409, got ${r.status}: ${JSON.stringify(r.data)}`);
        ok('duplicate pubkey rejected', `error=${r.data.error}`);
    });
    
    // Cleanup
    console.log(c.b('\n[16] Cleanup test agenta z DB'));
    await run('cleanup', async () => {
        const { Pool } = require('pg');
        const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
        const r1 = await p.query('DELETE FROM certificates WHERE kya_id = $1', [registeredKyaId]);
        const r2 = await p.query('DELETE FROM agents WHERE agent_name = $1', [agentName]);
        const r3 = await p.query("DELETE FROM registration_intents WHERE agent_name = $1", [agentName]);
        await p.end();
        ok('cleanup', `certs=${r1.rowCount} agents=${r2.rowCount} intents=${r3.rowCount}`);
    });
    
    console.log('\n' + c.b('=== SUMMARY ==='));
    console.log(`${c.g('✓ Passed:')} ${passed}`);
    console.log(`${failed > 0 ? c.r('✗ Failed:') : '✗ Failed:'} ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(c.r('FATAL:'), e); process.exit(2); });
