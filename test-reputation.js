#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 2 Reputation Tracking E2E Test
// ============================================================================
// Pokrýva:
//   1. Bot self-action (positive, rate-limited)
//   2. Bot self-action (negative — vždy aplikované)
//   3. Heartbeat
//   4. Peer report — auto-applied
//   5. Peer report — eskalované (FRAUD)
//   6. Anonymous report → PENDING_REVIEW
//   7. Admin slash → SUSPENDED → cert revoked
//   8. Admin restore + reissue-cert
//   9. Events history endpoint
//  10. Manual decay run
// ============================================================================
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET;
const manifestSchema = require('./lib/manifest-schema');

// Testy posielajú veľa requestov za sebou → bypass zone rate limiter cez admin key.
// Pre realistický flow má bot v PROBATION skutočne max 1 req/min (overené v dedikovanom teste).
if (ADMIN_KEY) {
    axios.defaults.headers.common['X-Admin-Key'] = ADMIN_KEY;
}

const c = { g: s=>`\x1b[32m${s}\x1b[0m`, r: s=>`\x1b[31m${s}\x1b[0m`, y: s=>`\x1b[33m${s}\x1b[0m`, b: s=>`\x1b[36m${s}\x1b[0m`, d: s=>`\x1b[2m${s}\x1b[0m` };
let passed = 0, failed = 0;
function ok(name, info='') { passed++; console.log(`  ${c.g('✓')} ${name} ${c.d(info)}`); }
function fail(name, err) { failed++; console.log(`  ${c.r('✗')} ${name}\n    ${c.r(err)}`); }
async function run(name, fn) { try { await fn(); } catch (e) { fail(name, e.stack || e.message); } }

// Ed25519 helpers
const ED25519_PRIV_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_PUB_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function rawPrivToKey(rawHex) {
    return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PRIV_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'pkcs8' });
}
function genKeypair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('hex');
    const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex');
    return { privHex: privRaw, pubHex: pubRaw, priv: privateKey };
}
function sign(privKey, msgBuf) {
    return crypto.sign(null, msgBuf, privKey).toString('hex');
}

// Helper: vykoná celý register flow pre nového bota (vráti kya_id + keypair)
async function registerBot(tierRequested = 'BASIC') {
    const bot = genKeypair();
    const agentName = 'REPTEST-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const manifest = {
        protocol_version: '1.0',
        agent: {
            name: agentName,
            version: '1.0.0',
            pubkey: bot.pubHex,
            capabilities: ['kyc_check', 'btc_payments'],
        },
        tier_requested: tierRequested,
        timestamp: new Date().toISOString(),
        nonce: crypto.randomBytes(16).toString('hex'),
    };
    const mHash = manifestSchema.manifestHash(manifest);
    const mSig = sign(bot.priv, Buffer.from(mHash, 'hex'));
    
    const ch = await axios.get(`${BASE}/api/auth/challenge?pubkey=${bot.pubHex}`);
    const chResp = sign(bot.priv, Buffer.from(ch.data.nonce, 'hex'));
    
    const initRes = await axios.post(`${BASE}/api/register/initiate`, {
        manifest, manifest_signature: mSig,
        challenge_id: ch.data.challenge_id,
        challenge_response: chResp,
    });
    
    // Simuluj webhook InvoiceSettled
    const amount = tierRequested === 'ELITE' ? 80000 : 10000;
    const webhookBody = JSON.stringify({
        type: 'InvoiceSettled',
        invoiceId: initRes.data.invoiceId,
        metadata: {
            registrationId: initRes.data.registration_id,
            agentName, pubkey: bot.pubHex, amount,
        },
    });
    const sigHeader = 'sha256=' + crypto.createHmac('sha256', BTCPAY_WEBHOOK_SECRET).update(webhookBody).digest('hex');
    await axios.post(`${BASE}/api/webhook/btcpay`, webhookBody, {
        headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': sigHeader, 'BTCPay-Delivery-Id': 'TEST-REP-' + Date.now() + Math.random() },
    });
    
    // Nájdi kya_id
    const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
    const r = await p.query('SELECT kya_id, id FROM agents WHERE agent_name = $1', [agentName]);
    await p.end();
    if (r.rowCount === 0) throw new Error(`Bot ${agentName} sa neregistroval`);
    
    return { kya_id: r.rows[0].kya_id, db_id: r.rows[0].id, agentName, pubHex: bot.pubHex, privHex: bot.privHex, priv: bot.priv };
}

// Helper: vyrobí podpísané telo action requestu
function buildActionRequest(privKey, { action_type, target, context, evidence_hash }) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const signedPayload = JSON.stringify({
        action_type, target: target || null, context: context || null,
        evidence_hash: evidence_hash || null, nonce, timestamp,
    });
    const digest = crypto.createHash('sha256').update(signedPayload).digest();
    const signature = sign(privKey, digest);
    return { action_type, target, context, evidence_hash, signature, nonce, timestamp };
}

function buildHeartbeatRequest(privKey, kya_id) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const digest = crypto.createHash('sha256').update(`${kya_id}|${nonce}|${timestamp}`).digest();
    const signature = sign(privKey, digest);
    return { signature, nonce, timestamp };
}

function buildReportRequest(reporterPriv, { target_kya, report_type, description, evidence }) {
    const payload = JSON.stringify({
        target_kya, report_type, description,
        evidence: evidence || null,
    });
    const digest = crypto.createHash('sha256').update(payload).digest();
    const signature = sign(reporterPriv, digest);
    return { signature };
}

async function cleanup(kya_ids) {
    const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
    for (const k of kya_ids) {
        await p.query('DELETE FROM reputation_events WHERE kya_id = $1', [k]);
        await p.query('DELETE FROM action_log WHERE kya_id = $1', [k]);
        await p.query('DELETE FROM reports WHERE target_kya_id = $1 OR reporter_kya_id = $1', [k]);
        await p.query('DELETE FROM certificates WHERE kya_id = $1', [k]);
        await p.query('DELETE FROM registration_intents WHERE agent_pubkey IN (SELECT agent_pubkey FROM agents WHERE kya_id = $1)', [k]);
        await p.query('DELETE FROM agents WHERE kya_id = $1', [k]);
    }
    await p.end();
}

(async () => {
    console.log(c.b('\n=== UMBRAXON Phase 2 Reputation Tracking Test ==='));
    
    let basicBot, eliteBot, reporterBot;
    const cleanupList = [];
    
    try {
        // === Setup ===
        console.log(c.b('\n[Setup] Vytváram 3 testovacie boty (2× BASIC + 1× ELITE)'));
        basicBot = await registerBot('BASIC');
        cleanupList.push(basicBot.kya_id);
        ok('basicBot registered', `kya_id=${basicBot.kya_id}`);
        
        eliteBot = await registerBot('ELITE');
        cleanupList.push(eliteBot.kya_id);
        ok('eliteBot registered', `kya_id=${eliteBot.kya_id}`);
        
        reporterBot = await registerBot('BASIC');
        cleanupList.push(reporterBot.kya_id);
        ok('reporterBot registered', `kya_id=${reporterBot.kya_id}`);
        
        // === [1] Self-action positive (BASIC) ===
        console.log(c.b('\n[1] BASIC bot self-reportuje VERIFICATION_SUCCESS (pozitívne)'));
        await run('positive self-action', async () => {
            const body = buildActionRequest(basicBot.priv, {
                action_type: 'VERIFICATION_SUCCESS',
                target: 'user-test-001',
                evidence_hash: 'a'.repeat(64),  // BASIC nepotrebuje, ale stále posielame
            });
            const r = await axios.post(`${BASE}/api/agent/${basicBot.kya_id}/action`, body);
            if (!r.data.accepted) throw new Error('not accepted');
            if (r.data.event?.new_score !== 501) throw new Error(`expected 501, got ${r.data.event?.new_score}`);
            ok('+1 applied', `score 500→${r.data.event.new_score}`);
        });
        
        // === [2] Rate limit (pokus o ďalší +1 v tej istej hodine) ===
        console.log(c.b('\n[2] Rate limit: druhý positive action v 1h musí byť rate-limited'));
        await run('rate limit triggered', async () => {
            const body = buildActionRequest(basicBot.priv, {
                action_type: 'VERIFICATION_SUCCESS',
                target: 'user-test-002',
                evidence_hash: 'b'.repeat(64),
            });
            const r = await axios.post(`${BASE}/api/agent/${basicBot.kya_id}/action`, body);
            if (!r.data.rate_limited) throw new Error('rate limit nebol triggered');
            ok('rate-limited correctly', `reason=${r.data.reason}`);
        });
        
        // === [3] Self-action negative (priznanie chyby) ===
        console.log(c.b('\n[3] BASIC bot priznáva VERIFICATION_FAIL (-50, no rate limit)'));
        await run('negative self-action', async () => {
            const body = buildActionRequest(basicBot.priv, {
                action_type: 'VERIFICATION_FAIL',
                target: 'user-test-003',
            });
            const r = await axios.post(`${BASE}/api/agent/${basicBot.kya_id}/action`, body);
            if (r.data.event?.delta !== -50) throw new Error(`expected -50, got ${r.data.event?.delta}`);
            ok('-50 applied', `score 501→${r.data.event.new_score}`);
        });
        
        // === [4] ELITE bez evidence_hash → logged only ===
        console.log(c.b('\n[4] ELITE pozitívny action bez evidence_hash → logged, no delta'));
        await run('elite no-proof logged', async () => {
            const body = buildActionRequest(eliteBot.priv, {
                action_type: 'VERIFICATION_SUCCESS',
                target: 'user-elite-001',
                // BEZ evidence_hash
            });
            const r = await axios.post(`${BASE}/api/agent/${eliteBot.kya_id}/action`, body);
            if (r.data.applied !== false) throw new Error('mal byť logged-only, nie applied');
            ok('elite logged only', `note=${r.data.note || ''}`);
        });
        
        // === [5] Heartbeat ===
        console.log(c.b('\n[5] Heartbeat: oba boty pošlú ping'));
        await run('heartbeat OK', async () => {
            const body = buildHeartbeatRequest(basicBot.priv, basicBot.kya_id);
            const r = await axios.post(`${BASE}/api/agent/${basicBot.kya_id}/heartbeat`, body);
            if (!r.data.ok) throw new Error('heartbeat not OK');
            ok('basic heartbeat', `next_expected=${r.data.next_expected_within_days}d`);
            
            const body2 = buildHeartbeatRequest(eliteBot.priv, eliteBot.kya_id);
            const r2 = await axios.post(`${BASE}/api/agent/${eliteBot.kya_id}/heartbeat`, body2);
            if (!r2.data.ok) throw new Error('elite heartbeat not OK');
            ok('elite heartbeat', `server_time=${r2.data.server_time.slice(11, 19)}`);
        });
        
        // === [6] Peer report — auto-applied ===
        console.log(c.b('\n[6] Peer report POOR_QUALITY → auto-applied -20'));
        // reporterBot je BASIC (score=500=NEUTRAL) → môže auto-apply
        await run('peer report auto-applied', async () => {
            const description = 'Reporter dokumentuje slabú kvalitu výstupu pri spracovaní';
            const sig = buildReportRequest(reporterBot.priv, {
                target_kya: basicBot.kya_id, report_type: 'POOR_QUALITY', description,
            });
            const r = await axios.post(`${BASE}/api/agent/${basicBot.kya_id}/report`, {
                report_type: 'POOR_QUALITY', description,
                reporter_kya_id: reporterBot.kya_id,
                reporter_pubkey: reporterBot.pubHex,
                reporter_signature: sig.signature,
            });
            if (r.data.status !== 'AUTO_APPLIED') throw new Error(`expected AUTO_APPLIED, got ${r.data.status}`);
            // Phase 2.4: NEGATIVE_PEER_REVIEW -20 prejde Sybil-weighting (mladý BASIC reporter má 0.175×).
            // Akceptuj any negative delta (Sybil-aware) — dôležité je že auto-aplikované.
            if (!r.data.event || r.data.event.delta >= 0) {
                throw new Error(`expected negative delta, got ${r.data.event?.delta}`);
            }
            ok('auto-applied (sybil-weighted)', `delta=${r.data.event.delta} new_score=${r.data.event.new_score} zone=${r.data.event.new_zone}`);
        });
        
        // === [7] Peer report — FRAUD eskalované ===
        console.log(c.b('\n[7] Peer report FRAUD → eskalované (žiadne auto-apply)'));
        await run('peer report escalated', async () => {
            const description = 'Detegoval som podvodné správanie cieľového bota voči viacerým userom';
            const sig = buildReportRequest(reporterBot.priv, {
                target_kya: eliteBot.kya_id, report_type: 'FRAUD', description,
            });
            const r = await axios.post(`${BASE}/api/agent/${eliteBot.kya_id}/report`, {
                report_type: 'FRAUD', description,
                reporter_kya_id: reporterBot.kya_id,
                reporter_pubkey: reporterBot.pubHex,
                reporter_signature: sig.signature,
            });
            if (r.data.status !== 'ESCALATED') throw new Error(`expected ESCALATED, got ${r.data.status}`);
            if (r.data.auto_applied) throw new Error('FRAUD by sa nemal auto-aplikovať');
            ok('escalated', `report_id=${r.data.report_id} msg="${r.data.message?.slice(0,40)}..."`);
        });
        
        // === [8] Anonymous report → PENDING_REVIEW ===
        console.log(c.b('\n[8] Anonymný report → PENDING_REVIEW'));
        let anonReportId = null;
        await run('anonymous report pending', async () => {
            const r = await axios.post(`${BASE}/api/agent/${basicBot.kya_id}/report`, {
                report_type: 'SPAM',
                description: 'Anonymný user reportuje spam správanie tohto agenta v komunite',
            });
            if (r.data.status !== 'PENDING_REVIEW') throw new Error(`expected PENDING_REVIEW, got ${r.data.status}`);
            if (r.data.auto_applied) throw new Error('anonymous report by sa nemal auto-aplikovať');
            anonReportId = r.data.report_id;
            ok('pending', `report_id=${anonReportId}`);
        });
        
        // === [9] Admin resolve report → VALID (slashing) ===
        console.log(c.b('\n[9] Admin resolve PENDING report ako VALID → slashing'));
        await run('admin resolve report', async () => {
            const r = await axios.post(`${BASE}/api/admin/reports/${anonReportId}/resolve`, {
                resolution: 'VALID',
                note: 'Potvrdené spam správanie, ďakujeme za nahlasenie',
            }, { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
            if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
            // Endpoint vracia { report_id, resolution, event } — event obsahuje newScore atď.
            if (!r.data.event || typeof r.data.event.newScore !== 'number') {
                throw new Error(`admin resolve mal vrátiť event s newScore, dostal: ${JSON.stringify(r.data)}`);
            }
            ok('SPAM_REPORT applied', `new_score=${r.data.event.newScore} new_zone=${r.data.event.newZone}`);
        });
        
        // === [10] Admin slash → SUSPENDED → cert revoked cascade ===
        // FRAUD_PROVEN = -500. ELITE 900 → 400 (NEUTRAL). Pre dosiahnutie SUSPENDED
        // použijeme custom delta -800 (z 900 → 100 = SUSPENDED).
        console.log(c.b('\n[10] Admin slash eliteBot s custom delta -800 → SUSPENDED + cert revoked'));
        let eliteCertSerialBefore = null;
        await run('admin slash → cascade', async () => {
            const certBefore = await axios.get(`${BASE}/api/cert/${eliteBot.kya_id}`);
            eliteCertSerialBefore = certBefore.data.serial;
            
            const r = await axios.post(`${BASE}/api/admin/agent/${eliteBot.kya_id}/slash`, {
                event_type: 'FRAUD_PROVEN',
                delta: -800,                       // custom delta aby sme prepadli do SUSPENDED
                reason: 'Test: simulujeme proven fraud + protocol violation cluster',
            }, { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
            if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
            if (r.data.newZone !== 'SUSPENDED') throw new Error(`expected SUSPENDED, got ${r.data.newZone} (score=${r.data.newScore})`);
            
            const revoked = r.data.sideEffects?.find(s => s.type === 'CERT_REVOKED');
            if (!revoked) throw new Error('cert revocation cascade nezbehol');
            ok('SUSPENDED + cert revoked', `score=${r.data.newScore} cert=${revoked.certs[0]}`);
            
            const certStatus = await axios.get(`${BASE}/api/cert/${eliteBot.kya_id}`, { validateStatus: () => true });
            if (certStatus.status !== 410) throw new Error(`cert mal vrátiť 410 GONE, vrátil ${certStatus.status}`);
            ok('cert status GONE', `error=${certStatus.data.error}`);
        });
        
        // === [11] Admin restore → reactivate ===
        // Endpoint `/restore` má `delta` (pozitívne, aplikuje |delta|). Z aktuálneho ~100 → 900 = +800.
        console.log(c.b('\n[11] Admin restore eliteBot delta=+800 → späť do ELITE_TIER zóny'));
        await run('admin restore', async () => {
            // Najprv preverim aktuálne skóre
            const reps = await axios.get(`${BASE}/api/agent/${eliteBot.kya_id}/reputation`);
            const beforeScore = reps.data.reputation.score;
            const targetDelta = 900 - beforeScore;  // → 900
            
            const r = await axios.post(`${BASE}/api/admin/agent/${eliteBot.kya_id}/restore`, {
                delta: targetDelta,
                reason: 'Test: restore po nepravdivom obvinení',
            }, { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
            if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
            if (r.data.newScore !== 900) throw new Error(`expected 900, got ${r.data.newScore}`);
            const reactivated = r.data.sideEffects?.find(s => s.type === 'AGENT_REACTIVATED');
            if (!reactivated) throw new Error('agent reactivation cascade nezbehol');
            ok('restored & reactivated', `from ${beforeScore} → 900 zone=${r.data.newZone}`);
        });
        
        // === [12] Reissue cert ===
        console.log(c.b('\n[12] Admin reissue cert pre eliteBot'));
        await run('reissue cert', async () => {
            const r = await axios.post(`${BASE}/api/admin/agent/${eliteBot.kya_id}/reissue-cert`, {
                reason: 'Po restore, vystavujeme nový cert',
            }, { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
            if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
            if (!r.data.reissued) throw new Error('not reissued');
            if (r.data.serial === eliteCertSerialBefore) throw new Error('serial sa nezmenil');
            ok('reissued', `new serial=${r.data.serial}`);
            
            // Verify cert je teraz available
            const certNow = await axios.get(`${BASE}/api/cert/${eliteBot.kya_id}`);
            if (certNow.data.serial !== r.data.serial) throw new Error('cert/:kya_id nevracia nový serial');
            ok('new cert active', `serial=${certNow.data.serial}`);
        });
        
        // === [13] Events history endpoint ===
        console.log(c.b('\n[13] GET /api/agent/:kya_id/events'));
        await run('events history', async () => {
            const r = await axios.get(`${BASE}/api/agent/${eliteBot.kya_id}/events`);
            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
            if (r.data.count < 3) throw new Error(`málo eventov (${r.data.count}), očakával sa aspoň 3`);
            const types = r.data.events.map(e => e.event_type);
            if (!types.includes('FRAUD_PROVEN')) throw new Error('chýba FRAUD_PROVEN event');
            if (!types.includes('ADMIN_RESTORE')) throw new Error('chýba ADMIN_RESTORE event');
            ok('history correct', `${r.data.count} events: ${types.slice(0, 4).join(',')}...`);
        });
        
        // === [14] Reputation endpoint enriched ===
        console.log(c.b('\n[14] GET /api/agent/:kya_id/reputation — vrátane liveness info'));
        await run('reputation enriched', async () => {
            const r = await axios.get(`${BASE}/api/agent/${basicBot.kya_id}/reputation`);
            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
            if (!r.data.liveness) throw new Error('chýba liveness field');
            if (!r.data.liveness.last_heartbeat_at) throw new Error('chýba last_heartbeat_at');
            ok('liveness exposed', `status=${r.data.liveness.status} hbs=${r.data.liveness.heartbeat_count}`);
        });
        
        // === [15] Manual decay run ===
        console.log(c.b('\n[15] POST /api/admin/run-decay (manuálny tick)'));
        await run('decay manual run', async () => {
            const r = await axios.post(`${BASE}/api/admin/run-decay`, {}, {
                headers: { 'X-Admin-Key': ADMIN_KEY },
            });
            if (!r.data.ran) throw new Error('decay nebehol');
            if (r.data.stats.scanned < 3) throw new Error(`scan príliš málo (${r.data.stats.scanned})`);
            ok('decay ticked', `scanned=${r.data.stats.scanned} warn=${r.data.stats.decayed_warn} heavy=${r.data.stats.decayed_heavy} dormant=${r.data.stats.dormant}`);
        });
        
        // === [16] Cannot report self ===
        console.log(c.b('\n[16] Bot nemôže reportovať sám seba'));
        await run('cannot report self', async () => {
            const sig = buildReportRequest(basicBot.priv, {
                target_kya: basicBot.kya_id, report_type: 'POOR_QUALITY', description: 'self-report attempt',
            });
            const r = await axios.post(`${BASE}/api/agent/${basicBot.kya_id}/report`, {
                report_type: 'POOR_QUALITY',
                description: 'Toto by malo padnúť, nemôžem sa reportovať sám',
                reporter_kya_id: basicBot.kya_id,
                reporter_pubkey: basicBot.pubHex,
                reporter_signature: sig.signature,
            }, { validateStatus: () => true });
            if (r.status === 200) throw new Error('mal padnúť, ale prešiel');
            ok('self-report rejected', `HTTP ${r.status}: ${r.data.error}`);
        });
        
        // === [17] Bad signature rejection ===
        console.log(c.b('\n[17] Bad signature na action → 401'));
        await run('bad signature rejected', async () => {
            const fake = genKeypair();
            const body = buildActionRequest(fake.priv, {  // podpísané inou kľúčou!
                action_type: 'USER_INTERACTION',
                target: 'fake-user',
            });
            const r = await axios.post(`${BASE}/api/agent/${basicBot.kya_id}/action`, body, { validateStatus: () => true });
            if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
            ok('bad sig rejected', `error=${r.data.error}`);
        });
        
        // === [18] Idempotency: same nonce → 409 ===
        console.log(c.b('\n[18] Replay protection: ten istý nonce → 409'));
        await run('nonce reuse rejected', async () => {
            const body = buildActionRequest(eliteBot.priv, {
                action_type: 'USER_INTERACTION',
                target: 'idempotency-test',
            });
            const r1 = await axios.post(`${BASE}/api/agent/${eliteBot.kya_id}/action`, body, { validateStatus: () => true });
            if (r1.status !== 200) throw new Error(`prvý request failed: ${r1.status}`);
            const r2 = await axios.post(`${BASE}/api/agent/${eliteBot.kya_id}/action`, body, { validateStatus: () => true });
            if (r2.status !== 409) throw new Error(`expected 409 pre druhý, got ${r2.status}`);
            ok('replay rejected', `HTTP 409 ${r2.data.error}`);
        });
        
        // === [19] Zone rate-limit: PROBATION agent (score 300) má limit 1 req/min ===
        console.log(c.b('\n[19] Zone rate-limit pre PROBATION agenta (1/min)'));
        await run('PROBATION rate limit triggered', async () => {
            // Vytvor fresh BASIC bota (aby sme nezasahovali do iných testovacích botov)
            const probBot = await registerBot('BASIC');
            cleanupList.push(probBot.kya_id);
            
            // Slash na PROBATION (500 → 300)
            await axios.post(`${BASE}/api/admin/agent/${probBot.kya_id}/slash`,
                { event_type: 'NEGATIVE_PEER_REVIEW', delta: -200, reason: 'test: enter PROBATION' },
                { headers: { 'X-Admin-Key': ADMIN_KEY } });
            
            // Skontroluj že je v PROBATION
            const repCheck = await axios.get(`${BASE}/api/agent/${probBot.kya_id}/reputation`);
            if (repCheck.data.reputation.zone !== 'PROBATION') {
                throw new Error(`agent NIE je v PROBATION, je v ${repCheck.data.reputation.zone} (score ${repCheck.data.reputation.score})`);
            }
            
            // Pošli 2 heartbeat-y BEZ admin keyu (čistý klient bez globálnych defaults) → druhý musí padnúť 429
            const cleanAxios = require('axios').create();
            delete cleanAxios.defaults.headers.common['X-Admin-Key'];
            cleanAxios.defaults.headers.common['X-Admin-Key'] = undefined;
            const mkHeartbeatBody = () => {
                const nonce = crypto.randomBytes(16).toString('hex');
                const timestamp = new Date().toISOString();
                const digest = crypto.createHash('sha256').update(`${probBot.kya_id}|${nonce}|${timestamp}`).digest();
                return { signature: sign(probBot.priv, digest), nonce, timestamp };
            };
            const r1 = await cleanAxios.post(`${BASE}/api/agent/${probBot.kya_id}/heartbeat`, mkHeartbeatBody(), { validateStatus: () => true });
            if (r1.status !== 200) throw new Error(`prvý heartbeat failed: ${r1.status} ${JSON.stringify(r1.data)}`);
            
            const r2 = await cleanAxios.post(`${BASE}/api/agent/${probBot.kya_id}/heartbeat`, mkHeartbeatBody(), { validateStatus: () => true });
            if (r2.status !== 429) throw new Error(`expected 429 pre druhý, got ${r2.status}: ${JSON.stringify(r2.data)}`);
            if (r2.data.zone !== 'PROBATION') throw new Error(`expected zone=PROBATION, got ${r2.data.zone}`);
            if (r2.data.limit_per_min !== 1) throw new Error(`expected limit=1, got ${r2.data.limit_per_min}`);
            ok('PROBATION rate limit', `HTTP 429 limit=${r2.data.limit_per_min}/min zone=${r2.data.zone} retry_after=${r2.data.retry_after_sec}s`);
        });
        
        // === [20] Cert verify: SUSPENDED agent → valid: false ===
        console.log(c.b('\n[20] /api/cert/verify: SUSPENDED agent musí mať valid=false'));
        await run('SUSPENDED cert verify rejected', async () => {
            // Restore basic bota späť (z PROBATION) a potom ho dotlač do SUSPENDED
            await axios.post(`${BASE}/api/admin/agent/${basicBot.kya_id}/restore`,
                { delta: 250, reason: 'test cleanup' },
                { headers: { 'X-Admin-Key': ADMIN_KEY } });
            // Teraz ho slashni hlboko do SUSPENDED
            await axios.post(`${BASE}/api/admin/agent/${basicBot.kya_id}/slash`,
                { event_type: 'FRAUD_PROVEN', delta: -700, reason: 'test: SUSPENDED for verify check' },
                { headers: { 'X-Admin-Key': ADMIN_KEY } });
            
            // Vezmi cert z DB
            const dbp = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
            const cr = await dbp.query(`SELECT cert_body FROM certificates WHERE kya_id = $1 ORDER BY issued_at DESC LIMIT 1`, [basicBot.kya_id]);
            await dbp.end();
            if (cr.rowCount === 0) throw new Error('cert nenájdený v DB');
            const cert = cr.rows[0].cert_body;
            
            // Pošli na verify
            const r = await axios.post(`${BASE}/api/cert/verify`, { certificate: cert });
            if (r.data.valid !== false) {
                throw new Error(`expected valid=false, got valid=${r.data.valid}. reason=${r.data.reason}`);
            }
            // crypto_valid musí byť true (podpis je matematicky platný), ale runtime status zruší cert
            if (r.data.crypto_valid !== true) {
                throw new Error(`crypto_valid musí byť true, got ${r.data.crypto_valid}`);
            }
            const allowedReasons = ['CERT_REVOKED', 'AGENT_SUSPENDED', 'AGENT_INACTIVE'];
            if (!allowedReasons.includes(r.data.reason)) {
                throw new Error(`unexpected reason: ${r.data.reason}`);
            }
            ok('SUSPENDED cert invalid', `valid=false crypto_valid=true reason=${r.data.reason}`);
        });
        
    } finally {
        // Cleanup
        console.log(c.b('\n[Cleanup] Mažem testovacích botov'));
        try {
            await cleanup(cleanupList);
            ok('cleanup', `removed ${cleanupList.length} bots`);
        } catch (e) {
            fail('cleanup', e.message);
        }
    }
    
    console.log('\n' + c.b('=== SUMMARY ==='));
    console.log(`${c.g('✓ Passed:')} ${passed}`);
    console.log(`${failed > 0 ? c.r('✗ Failed:') : '✗ Failed:'} ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(c.r('FATAL:'), e); process.exit(2); });
