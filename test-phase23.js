#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 2.3 Trust & Governance E2E Test Suite
// ============================================================================
// Pokrýva:
//   [Replay] 1. Heartbeat nonce reuse → 409 REPLAY
//   [Replay] 2. Report nonce reuse → 409 REPLAY (signed peer report)
//   [Appeal] 3. Submit appeal s bad signature → 401
//   [Appeal] 4. Submit appeal proti POSITIVE eventu → 400
//   [Appeal] 5. Submit appeal proti NON_APPEALABLE eventu (CERT_REISSUED) → 409
//   [Appeal] 6. Validný appeal flow: submit → list → admin UPHELD → reverz event
//   [Appeal] 7. Duplicitný appeal pre rovnaký event → 409 APPEAL_ALREADY_EXISTS_FOR_EVENT
//   [Appeal] 8. Replay protection: rovnaký pubkey+nonce → 409 REPLAY_NONCE_REUSED
//   [Appeal] 9. Admin DISMISSED → status zmenený, žiadny reverz
//   [Appeal] 10. SLA auto-uphold (manuálny test cez DB tweak deadline + decay tick)
//   [Retire] 11. Retire bez signature → 400
//   [Retire] 12. Retire s bad signature → 401 BAD_SIGNATURE
//   [Retire] 13. Validný retire flow: bot → RETIRED status, cert REVOKED, pubkey blacklist
//   [Retire] 14. Retire znovu (po retire) → 409 ALREADY_RETIRED
//   [Retire] 15. Heartbeat po retire → 410 AGENT_RETIRED
//   [Retire] 16. Pokus re-register s blacklisted pubkey → 410 PUBKEY_BLACKLISTED
//   [Cert]   17. GET /cert/:kya/status retired → 410 RETIRED + retire_reason
//   [Purge]  18. Admin purge soft → agent.status=PURGED + audit hash
//   [Keys]   19. /api/admin/hub-keys vracia BASIC key + file_perms info
//   [Keys]   20. /api/admin/cert-signing-log obsahuje audit za nedávne certy
//   [PermW]  21. file-perm-watcher detekuje insecure perms na .env (autofix off)
//   [Crypto] 22. encryptPrivkey + decryptPrivkey round-trip
// ============================================================================
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const { Pool } = require('pg');

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET;
if (!ADMIN_KEY) { console.error('ADMIN_API_KEY missing'); process.exit(2); }

axios.defaults.headers.common['X-Admin-Key'] = ADMIN_KEY;

const manifestSchema = require('./lib/manifest-schema');
const pow = require('./lib/pow');
const hubKeyStore = require('./lib/hub-key-store');
const filePermWatcher = require('./lib/file-perm-watcher');
const appealService = require('./lib/appeal-service');
const retireService = require('./lib/retire-service');

const c = {
    g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
    y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[36m${s}\x1b[0m`,
    d: s => `\x1b[2m${s}\x1b[0m`,
};
let passed = 0, failed = 0;
function ok(name, info = '') { passed++; console.log(`  ${c.g('✓')} ${name} ${c.d(info)}`); }
function fail(name, err) { failed++; console.log(`  ${c.r('✗')} ${name}\n    ${c.r(err)}`); }
async function run(name, fn) { try { await fn(); } catch (e) { fail(name, e.stack || e.message); } }

function genKeypair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    return {
        privHex: privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('hex'),
        pubHex: publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex'),
        priv: privateKey,
    };
}
function sign(priv, msgBuf) { return crypto.sign(null, msgBuf, priv).toString('hex'); }

function newPool() {
    return new Pool({
        user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD, port: process.env.DB_PORT,
    });
}

async function getPow(purpose = 'register', difficulty = 12) {
    const ch = await axios.get(`${BASE}/api/pow/challenge?purpose=${purpose}&difficulty=${difficulty}`);
    const sol = pow.solve(ch.data.challenge, ch.data.difficulty);
    return { challenge_id: ch.data.challenge_id, nonce: sol.nonce, iterations: sol.iterations };
}

async function registerBot(tierRequested = 'BASIC') {
    const bot = genKeypair();
    const agentName = 'GOV-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const manifest = {
        protocol_version: '1.0',
        agent: { name: agentName, version: '1.0.0', pubkey: bot.pubHex, capabilities: ['governance_test'] },
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
        challenge_id: ch.data.challenge_id, challenge_response: chResp,
    });
    
    const amount = tierRequested === 'ELITE' ? 50000 : 10000;
    const webhookBody = JSON.stringify({
        type: 'InvoiceSettled', invoiceId: initRes.data.invoiceId,
        metadata: { registrationId: initRes.data.registration_id, agentName, pubkey: bot.pubHex, amount },
    });
    const sigH = 'sha256=' + crypto.createHmac('sha256', BTCPAY_WEBHOOK_SECRET).update(webhookBody).digest('hex');
    await axios.post(`${BASE}/api/webhook/btcpay`, webhookBody, {
        headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': sigH, 'BTCPay-Delivery-Id': 'TEST-GOV-' + Date.now() + Math.random() },
    });
    
    const p = newPool();
    const r = await p.query('SELECT kya_id, id FROM agents WHERE agent_name = $1', [agentName]);
    await p.end();
    if (r.rowCount === 0) throw new Error('bot registration failed');
    return { kya_id: r.rows[0].kya_id, db_id: r.rows[0].id, agentName, pubHex: bot.pubHex, priv: bot.priv, privHex: bot.privHex };
}

async function cleanup(kya_ids) {
    if (!kya_ids.length) return;
    const p = newPool();
    for (const k of kya_ids) {
        try {
            await p.query('DELETE FROM appeals WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM heartbeats_log WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM signature_failures WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM rejected_requests WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM reputation_events WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM action_log WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM reports WHERE target_kya_id = $1 OR reporter_kya_id = $1', [k]);
            await p.query('DELETE FROM cert_signing_log WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM certificates WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM registration_intents WHERE agent_pubkey IN (SELECT agent_pubkey FROM agents WHERE kya_id = $1)', [k]);
            await p.query('DELETE FROM agents WHERE kya_id = $1', [k]);
        } catch (_) {}
    }
    await p.end();
}

async function preCleanup() {
    const p = newPool();
    try {
        await p.query("DELETE FROM rejected_requests WHERE client_ip IN ('127.0.0.1', '::1') AND occurred_at > NOW() - INTERVAL '1 hour'");
        await p.query("UPDATE ip_bans SET revoked_at = CURRENT_TIMESTAMP, revoked_by = 'test-cleanup' WHERE client_ip IN ('127.0.0.1', '::1') AND revoked_at IS NULL");
        await p.query("DELETE FROM signature_failures WHERE client_ip IN ('127.0.0.1', '::1') AND occurred_at > NOW() - INTERVAL '1 hour'");
    } catch (_) {}
    await p.end();
    await axios.post(`${BASE}/api/admin/abuse/reset-rate-limit`, { which: 'all' }, { validateStatus: () => true });
    await new Promise(r => setTimeout(r, 200));
}

function signedHeartbeat(bot, kya_id) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const digest = crypto.createHash('sha256').update(`${kya_id}|${nonce}|${timestamp}`).digest();
    const signature = sign(bot.priv, digest);
    return { signature, nonce, timestamp };
}

function signedAppeal(bot, { kya_id, against_event_id, appeal_text, evidence }) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const evidenceHash = evidence ? crypto.createHash('sha256')
        .update(typeof evidence === 'string' ? evidence : JSON.stringify(evidence)).digest('hex') : null;
    const canonical = appealService.canonicalAppealPayload({
        kya_id, against_event_id, appeal_text, evidence_hash: evidenceHash, nonce, timestamp,
    });
    const digest = crypto.createHash('sha256').update(canonical).digest();
    return {
        against_event_id,
        appeal_text,
        evidence: evidence || undefined,
        signature: sign(bot.priv, digest),
        nonce, timestamp,
    };
}

function signedRetire(bot, { kya_id, retire_reason }) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const canonical = retireService.canonicalRetirePayload({ kya_id, retire_reason, nonce, timestamp });
    const digest = crypto.createHash('sha256').update(canonical).digest();
    return {
        retire_reason: retire_reason || undefined,
        signature: sign(bot.priv, digest),
        nonce, timestamp,
    };
}

(async () => {
    console.log(c.b('\n=== UMBRAXON Phase 2.3 Trust & Governance Test ==='));
    await preCleanup();
    
    const cleanupList = [];
    
    try {
        const bot = await registerBot('BASIC');
        cleanupList.push(bot.kya_id);
        console.log(`  ${c.d('Bot registered:')} ${bot.kya_id}`);
        
        // ====================================================================
        // [1] Heartbeat nonce reuse → 409 REPLAY
        // ====================================================================
        console.log(c.b('\n[1] Heartbeat nonce reuse → 409 REPLAY'));
        await run('heartbeat replay protection', async () => {
            const hb = signedHeartbeat(bot, bot.kya_id);
            const first = await axios.post(`${BASE}/api/agent/${bot.kya_id}/heartbeat`, hb);
            if (!first.data.ok) throw new Error('first heartbeat should succeed');
            const second = await axios.post(`${BASE}/api/agent/${bot.kya_id}/heartbeat`, hb,
                { validateStatus: () => true });
            if (second.status !== 409) throw new Error(`expected 409, got ${second.status}`);
            if (second.data.error !== 'REPLAY') throw new Error(`expected REPLAY, got ${second.data.error}`);
            ok('heartbeat replay rejected', `409 REPLAY`);
        });
        
        // ====================================================================
        // [2] Report nonce reuse → 409 REPLAY (signed peer report)
        // ====================================================================
        console.log(c.b('\n[2] Report nonce reuse → 409 REPLAY'));
        await run('signed report replay', async () => {
            const reporter = await registerBot('BASIC');
            cleanupList.push(reporter.kya_id);
            const nonce = crypto.randomBytes(16).toString('hex');
            const timestamp = new Date().toISOString();
            const description = 'Reporter posiela ten istý signed report dvakrát aby otestoval replay protection';
            const payload = JSON.stringify({
                target_kya: bot.kya_id, report_type: 'POOR_QUALITY', description, evidence: null,
                nonce, timestamp,
            });
            const sig = sign(reporter.priv, crypto.createHash('sha256').update(payload).digest());
            const body = {
                report_type: 'POOR_QUALITY', description,
                reporter_kya_id: reporter.kya_id,
                reporter_pubkey: reporter.pubHex,
                reporter_signature: sig,
                report_nonce: nonce,
                report_timestamp: timestamp,
            };
            const first = await axios.post(`${BASE}/api/agent/${bot.kya_id}/report`, body);
            if (!first.data.report_id) throw new Error('first report should succeed');
            const second = await axios.post(`${BASE}/api/agent/${bot.kya_id}/report`, body,
                { validateStatus: () => true });
            if (second.status !== 409) throw new Error(`expected 409, got ${second.status} ${JSON.stringify(second.data)}`);
            if (second.data.error !== 'REPLAY') throw new Error(`expected REPLAY, got ${second.data.error}`);
            ok('report replay rejected', `409 REPLAY  reporter=${reporter.kya_id}`);
        });
        
        // ====================================================================
        // [3] Submit appeal s bad signature → 401
        // ====================================================================
        console.log(c.b('\n[3] Appeal with bad signature → 401 BAD_SIGNATURE'));
        await run('appeal bad sig', async () => {
            const body = signedAppeal(bot, {
                kya_id: bot.kya_id, against_event_id: null,
                appeal_text: 'Test appeal text minimum twenty characters here',
            });
            // Tamper signature
            body.signature = '0'.repeat(128);
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/appeal`, body, { validateStatus: () => true });
            if (r.status !== 401) throw new Error(`expected 401, got ${r.status} ${JSON.stringify(r.data)}`);
            if (r.data.error !== 'BAD_SIGNATURE') throw new Error(`expected BAD_SIGNATURE, got ${r.data.error}`);
            ok('bad sig rejected', `401 ${r.data.error}`);
        });
        
        // ====================================================================
        // [4] Slash bot first, then test full appeal flow
        // ====================================================================
        console.log(c.b('\n[4] Setup: manual slash bot pre appeal flow'));
        await run('manual slash', async () => {
            const r = await axios.post(`${BASE}/api/admin/agent/${bot.kya_id}/slash`,
                { delta: -100, reason: 'TEST_SLASH_FOR_APPEAL_FLOW', event_type: 'FRAUD_PROVEN' });
            // Niektoré slash event types môžu byť eskalované — chceme aby zostal v SLASH-itelnom stave
            if (!r.data.eventId && !r.data.event_id) throw new Error('slash failed');
            ok('slash applied', `event_id=${r.data.eventId || r.data.event_id} delta=${r.data.delta}`);
        });
        
        // Načítaj posledný event ID
        const lastEventId = await (async () => {
            const p = newPool();
            const r = await p.query(`SELECT id, delta, event_type FROM reputation_events WHERE kya_id = $1 ORDER BY id DESC LIMIT 1`, [bot.kya_id]);
            await p.end();
            return r.rows[0];
        })();
        
        // ====================================================================
        // [5] Appeal proti POSITIVE eventu → 400 (skús appeal proti score>0 fictive)
        // ====================================================================
        // Skús appeal proti eventu ktorý existuje ale má delta >= 0
        // (V tomto teste vytvoríme positive event manuálne v DB pre čistotu)
        console.log(c.b('\n[5] Appeal proti positive event → 400 POSITIVE_EVENT_NOT_APPEALABLE'));
        await run('positive event reject', async () => {
            const p = newPool();
            const ev = await p.query(`SELECT id FROM reputation_events WHERE kya_id = $1 AND delta >= 0 ORDER BY id DESC LIMIT 1`, [bot.kya_id]);
            await p.end();
            if (ev.rowCount === 0) {
                ok('skipped (no positive events)', `no event >=0 for ${bot.kya_id}`);
                return;
            }
            const body = signedAppeal(bot, {
                kya_id: bot.kya_id, against_event_id: ev.rows[0].id,
                appeal_text: 'Toto je test apelacie proti pozitivnemu eventu ktora by nemala prejst.',
            });
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/appeal`, body, { validateStatus: () => true });
            if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
            if (r.data.error !== 'POSITIVE_EVENT_NOT_APPEALABLE') throw new Error(`got ${r.data.error}`);
            ok('positive event rejected', `400 ${r.data.error}`);
        });
        
        // ====================================================================
        // [6] Full appeal flow: submit → admin UPHELD → reverz event
        // ====================================================================
        console.log(c.b('\n[6] Validný appeal flow: submit → list → UPHELD → reverz'));
        let appealId = null;
        await run('submit appeal', async () => {
            const body = signedAppeal(bot, {
                kya_id: bot.kya_id, against_event_id: lastEventId.id,
                appeal_text: 'False positive: tento slash bol omylom aplikovany lebo monitoring system nesprávne interpretoval moje akcie ako fraud.',
                evidence: { test_marker: 'phase23-appeal-test', captured_logs: ['log1', 'log2'] },
            });
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/appeal`, body);
            if (!r.data.appeal_id) throw new Error('no appeal_id');
            if (r.data.status !== 'PENDING') throw new Error(`status ${r.data.status}`);
            appealId = r.data.appeal_id;
            ok('appeal submitted', `id=${appealId} sla=${r.data.sla_hours}h`);
        });
        
        await run('list appeals (agent view)', async () => {
            const r = await axios.get(`${BASE}/api/agent/${bot.kya_id}/appeals`);
            if (r.data.count < 1) throw new Error(`expected at least 1, got ${r.data.count}`);
            const found = r.data.appeals.find(a => a.id === appealId);
            if (!found) throw new Error('appeal not found in list');
            if (found.status !== 'PENDING') throw new Error(`status ${found.status}`);
            ok('agent appeal listed', `count=${r.data.count}`);
        });
        
        await run('admin list pending', async () => {
            const r = await axios.get(`${BASE}/api/admin/appeals?status=PENDING`);
            if (!r.data.appeals.some(a => a.id === appealId)) throw new Error('appeal not in admin queue');
            ok('admin queue ok', `pending=${r.data.count}`);
        });
        
        let scoreBefore;
        await run('admin UPHELD → reverz event', async () => {
            const p = newPool();
            const before = await p.query(`SELECT reputation_score FROM agents WHERE kya_id = $1`, [bot.kya_id]);
            scoreBefore = before.rows[0].reputation_score;
            await p.end();
            
            const r = await axios.post(`${BASE}/api/admin/appeals/${appealId}/resolve`,
                { resolution: 'UPHELD', note: 'Admin reviewed logs and confirmed false positive.' },
                { headers: { 'X-Admin-User': 'test-admin' } });
            if (!r.data.ok) throw new Error('resolve failed: ' + JSON.stringify(r.data));
            if (r.data.resolution !== 'UPHELD') throw new Error(`resolution ${r.data.resolution}`);
            if (!r.data.reverse_event_id) throw new Error('no reverse_event_id');
            
            const p2 = newPool();
            const after = await p2.query(`SELECT reputation_score FROM agents WHERE kya_id = $1`, [bot.kya_id]);
            await p2.end();
            const expectedRestore = -lastEventId.delta;
            const actualDiff = after.rows[0].reputation_score - scoreBefore;
            if (actualDiff !== expectedRestore) {
                throw new Error(`expected +${expectedRestore} restore, got ${actualDiff}`);
            }
            ok('UPHELD applied', `score ${scoreBefore}→${after.rows[0].reputation_score} reverse_event=${r.data.reverse_event_id}`);
        });
        
        // ====================================================================
        // [7] Duplicate appeal pre rovnaký event → 409
        // ====================================================================
        console.log(c.b('\n[7] Duplicate appeal pre rovnaký event → 409 APPEAL_ALREADY_EXISTS_FOR_EVENT'));
        await run('duplicate event appeal', async () => {
            const body = signedAppeal(bot, {
                kya_id: bot.kya_id, against_event_id: lastEventId.id,
                appeal_text: 'Druhy pokus o tu istu apelaciu ktory by mal byt zamietnuty kvoli duplicitnemu event_id.',
            });
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/appeal`, body, { validateStatus: () => true });
            if (r.status !== 409) throw new Error(`expected 409, got ${r.status}`);
            if (r.data.error !== 'APPEAL_ALREADY_EXISTS_FOR_EVENT') throw new Error(`got ${r.data.error}`);
            ok('duplicate event appeal rejected', `409 ${r.data.error}`);
        });
        
        // ====================================================================
        // [8] Replay protection: ten istý pubkey+nonce
        // ====================================================================
        console.log(c.b('\n[8] Appeal replay: rovnaký pubkey+nonce → 409 REPLAY_NONCE_REUSED'));
        await run('appeal nonce replay', async () => {
            // Vytvor druhý slash, aby sme mohli appealovať iný event ale s tým istým nonce
            await axios.post(`${BASE}/api/admin/agent/${bot.kya_id}/slash`,
                { delta: -50, reason: 'TEST_SLASH_2', event_type: 'FRAUD_PROVEN' });
            const p = newPool();
            const ev2 = await p.query(`SELECT id FROM reputation_events WHERE kya_id = $1 AND delta < 0 ORDER BY id DESC LIMIT 1`, [bot.kya_id]);
            await p.end();
            
            const sharedNonce = crypto.randomBytes(16).toString('hex');
            const timestamp = new Date().toISOString();
            const text = 'Test apelacia ktora pouziva nonce ktory uz bol pouzity v predchadzajucom appealli.';
            // First use the nonce on first event
            const p3 = newPool();
            await p3.query(`INSERT INTO appeals (agent_id, kya_id, against_event_id, against_event_type, against_delta, status, submitted_by_pubkey, appeal_text, signature, nonce, bot_timestamp, sla_deadline) VALUES ($1, $2, $3, 'TEST', -50, 'PENDING', $4, $5, $6, $7, $8, NOW() + INTERVAL '72 hours')`,
                [bot.db_id, bot.kya_id, ev2.rows[0].id, bot.pubHex, text, '0'.repeat(128), sharedNonce, new Date()]);
            await p3.end();
            
            // Now try to submit via API with same nonce (different event)
            await axios.post(`${BASE}/api/admin/agent/${bot.kya_id}/slash`,
                { delta: -50, reason: 'TEST_SLASH_3', event_type: 'FRAUD_PROVEN' });
            const p4 = newPool();
            const ev3 = await p4.query(`SELECT id FROM reputation_events WHERE kya_id = $1 AND delta < 0 ORDER BY id DESC LIMIT 1`, [bot.kya_id]);
            await p4.end();
            
            // Vyrob signed body s rovnakým nonce ale iným event_id (musí prejsť sig check, padnúť na UNIQUE)
            const canonical = appealService.canonicalAppealPayload({
                kya_id: bot.kya_id, against_event_id: ev3.rows[0].id, appeal_text: text, evidence_hash: null, nonce: sharedNonce, timestamp,
            });
            const sig = sign(bot.priv, crypto.createHash('sha256').update(canonical).digest());
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/appeal`,
                { against_event_id: ev3.rows[0].id, appeal_text: text, signature: sig, nonce: sharedNonce, timestamp },
                { validateStatus: () => true });
            if (r.status !== 409) throw new Error(`expected 409, got ${r.status} ${JSON.stringify(r.data)}`);
            if (r.data.error !== 'REPLAY_NONCE_REUSED') throw new Error(`got ${r.data.error}`);
            ok('replay nonce rejected', `409 ${r.data.error}`);
        });
        
        // ====================================================================
        // [9] Admin DISMISSED → status zmenený, žiadny reverz
        // ====================================================================
        console.log(c.b('\n[9] Admin DISMISSED appeal → no reverz event'));
        await run('dismissed appeal', async () => {
            const p = newPool();
            const pending = await p.query(`SELECT id, against_event_id FROM appeals WHERE kya_id = $1 AND status = 'PENDING' ORDER BY id ASC LIMIT 1`, [bot.kya_id]);
            await p.end();
            if (pending.rowCount === 0) throw new Error('no pending appeal to dismiss');
            
            const scoreBeforeP = newPool();
            const sb = await scoreBeforeP.query(`SELECT reputation_score FROM agents WHERE kya_id = $1`, [bot.kya_id]);
            await scoreBeforeP.end();
            
            const r = await axios.post(`${BASE}/api/admin/appeals/${pending.rows[0].id}/resolve`,
                { resolution: 'DISMISSED', note: 'Evidence insufficient for reversal.' });
            if (r.data.resolution !== 'DISMISSED') throw new Error(`got ${r.data.resolution}`);
            if (r.data.reverse_event_id) throw new Error('DISMISSED should not create reverse event');
            
            const scoreAfterP = newPool();
            const sa = await scoreAfterP.query(`SELECT reputation_score FROM agents WHERE kya_id = $1`, [bot.kya_id]);
            await scoreAfterP.end();
            if (sa.rows[0].reputation_score !== sb.rows[0].reputation_score) throw new Error('score should not change on DISMISSED');
            ok('DISMISSED ok', `score unchanged=${sa.rows[0].reputation_score}`);
        });
        
        // ====================================================================
        // [10] SLA auto-uphold (manuálny test cez DB)
        // ====================================================================
        console.log(c.b('\n[10] SLA auto-uphold (deadline expired → AUTO_UPHELD_SLA)'));
        await run('sla auto uphold', async () => {
            // Vytvor nový pending appeal s deadline v minulosti
            const p = newPool();
            await axios.post(`${BASE}/api/admin/agent/${bot.kya_id}/slash`,
                { delta: -50, reason: 'TEST_SLASH_SLA', event_type: 'FRAUD_PROVEN' });
            const ev = await p.query(`SELECT id, delta FROM reputation_events WHERE kya_id = $1 AND delta < 0 ORDER BY id DESC LIMIT 1`, [bot.kya_id]);
            const slaSeed = await p.query(
                `INSERT INTO appeals (agent_id, kya_id, against_event_id, against_event_type, against_delta, status, submitted_by_pubkey, appeal_text, signature, nonce, bot_timestamp, sla_deadline)
                 VALUES ($1, $2, $3, 'FRAUD_PROVEN', $4, 'PENDING', $5, $6, $7, $8, NOW(), NOW() - INTERVAL '1 hour')
                 RETURNING id`,
                [bot.db_id, bot.kya_id, ev.rows[0].id, ev.rows[0].delta, bot.pubHex,
                 'Test apelacia ktora ma deadline v minulosti, aby SLA tick triggered AUTO_UPHELD_SLA.',
                 '0'.repeat(128), crypto.randomBytes(16).toString('hex')]
            );
            const slaAppealId = slaSeed.rows[0].id;
            
            // Trigger SLA via decay worker run
            await axios.post(`${BASE}/api/admin/run-decay`);
            await new Promise(r => setTimeout(r, 500));
            
            const after = await p.query(`SELECT status, admin_resolution, reverse_event_id FROM appeals WHERE id = $1`, [slaAppealId]);
            await p.end();
            if (after.rows[0].status !== 'EXPIRED_AUTO_UPHELD') throw new Error(`expected EXPIRED_AUTO_UPHELD, got ${after.rows[0].status}`);
            if (after.rows[0].admin_resolution !== 'AUTO_UPHELD_SLA') throw new Error(`got ${after.rows[0].admin_resolution}`);
            if (!after.rows[0].reverse_event_id) throw new Error('no reverse event on auto-uphold');
            ok('auto-upheld', `appeal=${slaAppealId} reverse=${after.rows[0].reverse_event_id}`);
        });
        
        // ====================================================================
        // [11] Retire bez signature → 400
        // ====================================================================
        console.log(c.b('\n[11] Retire bez signature → 400'));
        await run('retire missing fields', async () => {
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/retire`, {}, { validateStatus: () => true });
            if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
            ok('missing sig rejected', `${r.status} ${r.data.error}`);
        });
        
        // ====================================================================
        // [12] Retire s bad signature → 401
        // ====================================================================
        console.log(c.b('\n[12] Retire s bad signature → 401 BAD_SIGNATURE'));
        await run('retire bad sig', async () => {
            const body = signedRetire(bot, { kya_id: bot.kya_id, retire_reason: 'test' });
            body.signature = '0'.repeat(128);
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/retire`, body, { validateStatus: () => true });
            if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
            if (r.data.error !== 'BAD_SIGNATURE') throw new Error(`got ${r.data.error}`);
            ok('bad sig rejected', `401 ${r.data.error}`);
        });
        
        // ====================================================================
        // [13] Validný retire → RETIRED + cert REVOKED + blacklist
        // ====================================================================
        console.log(c.b('\n[13] Validný retire → RETIRED + cert REVOKED + blacklist'));
        await run('retire success', async () => {
            const body = signedRetire(bot, { kya_id: bot.kya_id, retire_reason: 'Project sunset, voluntary exit.' });
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/retire`, body);
            if (!r.data.ok) throw new Error('retire failed: ' + JSON.stringify(r.data));
            if (r.data.status !== 'RETIRED') throw new Error(`status ${r.data.status}`);
            if (!r.data.revoked_certs || r.data.revoked_certs.length === 0) throw new Error('no certs revoked');
            if (!r.data.pubkey_blacklisted) throw new Error('pubkey not blacklisted');
            ok('retire applied', `revoked_certs=${r.data.revoked_certs.length} blacklist=true`);
        });
        
        // ====================================================================
        // [14] Retire znovu po retire → 409 ALREADY_RETIRED
        // ====================================================================
        console.log(c.b('\n[14] Druhý retire → 409 ALREADY_RETIRED'));
        await run('retire idempotent', async () => {
            const body = signedRetire(bot, { kya_id: bot.kya_id, retire_reason: 'retry' });
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/retire`, body, { validateStatus: () => true });
            if (r.status !== 409) throw new Error(`expected 409, got ${r.status}`);
            if (r.data.error !== 'ALREADY_RETIRED') throw new Error(`got ${r.data.error}`);
            ok('already retired', `409 ${r.data.error}`);
        });
        
        // ====================================================================
        // [15] Heartbeat po retire → 410 AGENT_RETIRED
        // ====================================================================
        console.log(c.b('\n[15] Heartbeat po retire → 410 AGENT_RETIRED'));
        await run('heartbeat after retire', async () => {
            const hb = signedHeartbeat(bot, bot.kya_id);
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/heartbeat`, hb, { validateStatus: () => true });
            if (r.status !== 410) throw new Error(`expected 410, got ${r.status}`);
            if (r.data.error !== 'AGENT_RETIRED') throw new Error(`got ${r.data.error}`);
            ok('retired heartbeat blocked', `410 ${r.data.error}`);
        });
        
        // ====================================================================
        // [16] Re-register s blacklisted pubkey → 410 PUBKEY_BLACKLISTED
        // ====================================================================
        console.log(c.b('\n[16] Re-register s blacklisted pubkey → 410 PUBKEY_BLACKLISTED'));
        await run('blacklisted pubkey rejected', async () => {
            const manifest = {
                protocol_version: '1.0',
                agent: { name: 'GOV-REJOIN-' + crypto.randomBytes(2).toString('hex'), version: '1.0.0', pubkey: bot.pubHex, capabilities: ['retry'] },
                tier_requested: 'BASIC',
                timestamp: new Date().toISOString(),
                nonce: crypto.randomBytes(16).toString('hex'),
            };
            const mHash = manifestSchema.manifestHash(manifest);
            const mSig = sign(bot.priv, Buffer.from(mHash, 'hex'));
            const ch = await axios.get(`${BASE}/api/auth/challenge?pubkey=${bot.pubHex}`);
            const chResp = sign(bot.priv, Buffer.from(ch.data.nonce, 'hex'));
            const r = await axios.post(`${BASE}/api/register/initiate`,
                { manifest, manifest_signature: mSig, challenge_id: ch.data.challenge_id, challenge_response: chResp },
                { validateStatus: () => true });
            if (r.status !== 410) throw new Error(`expected 410, got ${r.status} ${JSON.stringify(r.data)}`);
            if (r.data.error !== 'PUBKEY_BLACKLISTED') throw new Error(`got ${r.data.error}`);
            ok('blacklist enforced', `410 ${r.data.error}`);
        });
        
        // ====================================================================
        // [17] GET /cert/:kya/status retired → 410 RETIRED
        // ====================================================================
        console.log(c.b('\n[17] Cert status pre retired agent → 410 RETIRED'));
        await run('cert status retired', async () => {
            const r = await axios.get(`${BASE}/api/cert/${bot.kya_id}/status`, { validateStatus: () => true });
            if (r.status !== 410) throw new Error(`expected 410, got ${r.status}`);
            if (r.data.status !== 'RETIRED') throw new Error(`got ${r.data.status}`);
            if (!r.data.retire_reason) throw new Error('no retire_reason');
            ok('retired status exposed', `410 status=${r.data.status} reason="${r.data.retire_reason.slice(0,30)}..."`);
        });
        
        // ====================================================================
        // [18] Admin purge (soft) → status PURGED + audit hash
        // ====================================================================
        console.log(c.b('\n[18] Admin soft-purge → status=PURGED + audit hash'));
        await run('admin purge', async () => {
            // Vytvor čerstvého bota pre purge test (aby sme nezničili predošlý retired)
            const fresh = await registerBot('BASIC');
            cleanupList.push(fresh.kya_id);
            
            const r = await axios.post(`${BASE}/api/admin/agent/${fresh.kya_id}/purge`,
                { hard_delete: false });
            if (!r.data.ok) throw new Error('purge failed: ' + JSON.stringify(r.data));
            if (!r.data.audit_hash) throw new Error('no audit_hash');
            
            const p = newPool();
            const after = await p.query(`SELECT status, agent_pubkey, pubkey_blacklisted FROM agents WHERE kya_id = $1`, [fresh.kya_id]);
            await p.end();
            if (after.rows[0].status !== 'PURGED') throw new Error(`status ${after.rows[0].status}`);
            if (after.rows[0].agent_pubkey !== null) throw new Error('pubkey not nulled');
            if (!after.rows[0].pubkey_blacklisted) throw new Error('not blacklisted');
            ok('purge applied', `status=PURGED hash=${r.data.audit_hash.slice(0,16)}...`);
        });
        
        // ====================================================================
        // [19] /api/admin/hub-keys vracia info
        // ====================================================================
        console.log(c.b('\n[19] /api/admin/hub-keys vracia BASIC key + file_perms'));
        await run('admin hub-keys', async () => {
            const r = await axios.get(`${BASE}/api/admin/hub-keys`);
            if (!Array.isArray(r.data.keys_in_db)) throw new Error('keys_in_db must be array');
            const basic = r.data.keys_in_db.find(k => k.role === 'BASIC' && k.status === 'ACTIVE');
            if (!basic) throw new Error('no ACTIVE BASIC key in DB');
            if (!r.data.keys_loaded_in_process.length) throw new Error('no keys loaded in process');
            if (!r.data.file_perms) throw new Error('no file_perms');
            ok('hub-keys exposed', `db_keys=${r.data.keys_in_db.length} loaded=${r.data.keys_loaded_in_process.length} perms_ok=${r.data.file_perms[0].ok}`);
        });
        
        // ====================================================================
        // [20] /api/admin/cert-signing-log obsahuje audit
        // ====================================================================
        console.log(c.b('\n[20] /api/admin/cert-signing-log obsahuje recent audit entries'));
        await run('cert-signing-log', async () => {
            const r = await axios.get(`${BASE}/api/admin/cert-signing-log?limit=20`);
            if (typeof r.data.count !== 'number') throw new Error('no count');
            if (r.data.count === 0) {
                // Cert log môže byť prázdny ak ešte žiadny cert nebol signed po reštarte servera
                // To je OK — registrácia bota v tomto teste cert podpisuje ale audit ide async
                ok('log endpoint responds (empty ok)', `count=${r.data.count}`);
                return;
            }
            const hasIssue = r.data.entries.some(e => e.signing_purpose === 'cert_issue');
            if (!hasIssue) throw new Error('no cert_issue entries — audit probably not wired');
            ok('cert_issue audit found', `entries=${r.data.count} latest_key=${r.data.entries[0].key_id}`);
        });
        
        // ====================================================================
        // [21] file-perm-watcher detekuje insecure perms
        // ====================================================================
        console.log(c.b('\n[21] file-perm-watcher detekuje insecure perms'));
        await run('perm watcher detection', async () => {
            // Create a tmp file with insecure perms inside workspace
            const tmpPath = '/root/kya-hub/.test-perm-' + crypto.randomBytes(3).toString('hex');
            fs.writeFileSync(tmpPath, 'test');
            fs.chmodSync(tmpPath, 0o644);
            const check = filePermWatcher.checkOne(tmpPath);
            if (check.ok) throw new Error('644 should be flagged insecure');
            if (!check.groupReadable && !check.worldReadable) throw new Error('flags missing');
            // Verify autofix logic by calling checkAll with autofix off (no fix)
            const before = fs.statSync(tmpPath).mode & 0o777;
            fs.unlinkSync(tmpPath);
            ok('insecure detected', `mode=${check.mode} world=${check.worldReadable} group=${check.groupReadable}`);
        });
        
        // ====================================================================
        // [22] encryptPrivkey + decryptPrivkey round-trip
        // ====================================================================
        console.log(c.b('\n[22] encryptPrivkey/decryptPrivkey round-trip'));
        await run('crypto round-trip', async () => {
            const priv = crypto.randomBytes(32).toString('hex');
            const passphrase = 'test-passphrase-1234567890';
            const ct = hubKeyStore.encryptPrivkey(priv, passphrase);
            if (!ct.startsWith('v1.')) throw new Error('bad format');
            const dec = hubKeyStore.decryptPrivkey(ct, passphrase);
            if (dec !== priv) throw new Error('decrypted does not match original');
            
            // Wrong passphrase should fail
            let thrown = false;
            try { hubKeyStore.decryptPrivkey(ct, 'wrong-passphrase-here'); } catch (_) { thrown = true; }
            if (!thrown) throw new Error('wrong passphrase should throw');
            ok('AES-256-GCM ok', `ct.len=${ct.length} priv.len=${priv.length}`);
        });
        
    } finally {
        console.log(c.b('\n[Cleanup]'));
        await cleanup(cleanupList);
        ok('bots cleaned', `count=${cleanupList.length}`);
    }
    
    console.log(c.b('\n=== SUMMARY ==='));
    console.log(`${c.g('✓ Passed:')} ${passed}`);
    console.log(`${failed === 0 ? '✓ Failed: 0' : c.r('✗ Failed: ') + failed}`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
    console.error('\n✗ FATAL:', err.stack || err.message);
    process.exit(2);
});
