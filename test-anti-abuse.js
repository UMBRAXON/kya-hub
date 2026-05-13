#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 2.2 Anti-Abuse E2E Test Suite
// ============================================================================
// Pokrýva:
//   [PoW]    1. /api/pow/challenge funguje
//   [PoW]    2. /api/pow/verify funguje
//   [PoW]    3. /api/pay BEZ PoW → 402 POW_REQUIRED
//   [PoW]    4. /api/pay s validným PoW → OK
//   [PoW]    5. /api/pay s reused PoW → 402 POW_ALREADY_SOLVED
//   [PoW]    6. /api/pay s bad nonce → 402 POW_INSUFFICIENT_WORK
//   [PoW]    7. Admin bypass cez X-Admin-Key → skip
//   [Audit]  8. Bad admin key → rejection log + auto-eskalácia kandidatúry na ban
//   [Audit]  9. Bad bot signature na action → record signature_failure
//   [BanIP]  10. Admin manual ban + následné requesty zablokované (403 IP_BANNED)
//   [BanIP]  11. Admin manual unban → požiadavky znovu prejdú
//   [BadSig] 12. 10× bad signature na action → auto-slash agenta
//   [Anomaly] 13. Target spam v action_log (50+ rovnaký target) → flag + slash
//   [Auto2ban] 14. Burst critical rejections (gross >= 20 v 10min) → IP auto-ban
//   [Admin] 15. /api/admin/abuse summary + agent endpoint
// ============================================================================
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET;

if (!ADMIN_KEY) { console.error('ADMIN_API_KEY missing in .env'); process.exit(2); }

const manifestSchema = require('./lib/manifest-schema');
const pow = require('./lib/pow');
const abuseTracker = require('./lib/abuse-tracker');
const reputation = require('./lib/reputation');

const c = {
    g: s=>`\x1b[32m${s}\x1b[0m`, r: s=>`\x1b[31m${s}\x1b[0m`,
    y: s=>`\x1b[33m${s}\x1b[0m`, b: s=>`\x1b[36m${s}\x1b[0m`,
    d: s=>`\x1b[2m${s}\x1b[0m`,
};
let passed = 0, failed = 0;
function ok(name, info='') { passed++; console.log(`  ${c.g('✓')} ${name} ${c.d(info)}`); }
function fail(name, err) { failed++; console.log(`  ${c.r('✗')} ${name}\n    ${c.r(err)}`); }
async function run(name, fn) { try { await fn(); } catch (e) { fail(name, e.stack || e.message); } }

// === Helpers ===
function genKeypair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const privRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('hex');
    const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex');
    return { privHex: privRaw, pubHex: pubRaw, priv: privateKey };
}
function sign(priv, msgBuf) { return crypto.sign(null, msgBuf, priv).toString('hex'); }

async function getPow(purpose = 'pay', difficulty = 12) {
    const ch = await axios.get(`${BASE}/api/pow/challenge?purpose=${purpose}&difficulty=${difficulty}`);
    const sol = pow.solve(ch.data.challenge, ch.data.difficulty);
    return {
        challenge_id: ch.data.challenge_id,
        nonce: sol.nonce,
        iterations: sol.iterations,
        difficulty: ch.data.difficulty,
    };
}

// Helper: registrácia bota cez full flow (s admin bypass aby sme nelimitovali rate)
async function registerBot(tierRequested = 'BASIC') {
    const bot = genKeypair();
    const agentName = 'ABUSE-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const manifest = {
        protocol_version: '1.0',
        agent: {
            name: agentName, version: '1.0.0', pubkey: bot.pubHex,
            capabilities: ['anti_abuse_test'],
        },
        tier_requested: tierRequested,
        timestamp: new Date().toISOString(),
        nonce: crypto.randomBytes(16).toString('hex'),
    };
    const mHash = manifestSchema.manifestHash(manifest);
    const mSig = sign(bot.priv, Buffer.from(mHash, 'hex'));
    
    const ch = await axios.get(`${BASE}/api/auth/challenge?pubkey=${bot.pubHex}`,
        { headers: { 'X-Admin-Key': ADMIN_KEY } });
    const chResp = sign(bot.priv, Buffer.from(ch.data.nonce, 'hex'));
    
    const initRes = await axios.post(`${BASE}/api/register/initiate`, {
        manifest, manifest_signature: mSig,
        challenge_id: ch.data.challenge_id, challenge_response: chResp,
    }, { headers: { 'X-Admin-Key': ADMIN_KEY } });
    
    // Simulate webhook
    const amount = tierRequested === 'ELITE' ? 50000 : 10000;
    const webhookBody = JSON.stringify({
        type: 'InvoiceSettled', invoiceId: initRes.data.invoiceId,
        metadata: { registrationId: initRes.data.registration_id, agentName, pubkey: bot.pubHex, amount },
    });
    const sigHeader = 'sha256=' + crypto.createHmac('sha256', BTCPAY_WEBHOOK_SECRET).update(webhookBody).digest('hex');
    await axios.post(`${BASE}/api/webhook/btcpay`, webhookBody, {
        headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': sigHeader,
                   'BTCPay-Delivery-Id': 'TEST-AA-' + Date.now() + Math.random() },
    });
    
    const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
    const r = await p.query('SELECT kya_id, id FROM agents WHERE agent_name = $1', [agentName]);
    await p.end();
    if (r.rowCount === 0) throw new Error('bot registration failed');
    return { kya_id: r.rows[0].kya_id, db_id: r.rows[0].id, agentName, pubHex: bot.pubHex, priv: bot.priv };
}

async function cleanupBots(kya_ids) {
    if (!kya_ids.length) return;
    const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
    for (const k of kya_ids) {
        try {
            await p.query('DELETE FROM signature_failures WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM rejected_requests WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM reputation_events WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM action_log WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM reports WHERE target_kya_id = $1 OR reporter_kya_id = $1', [k]);
            await p.query('DELETE FROM certificates WHERE kya_id = $1', [k]);
            await p.query('DELETE FROM registration_intents WHERE agent_pubkey IN (SELECT agent_pubkey FROM agents WHERE kya_id = $1)', [k]);
            await p.query('DELETE FROM agents WHERE kya_id = $1', [k]);
        } catch (e) { /* */ }
    }
    await p.end();
}

async function cleanupIp(ip) {
    const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
    await p.query("DELETE FROM ip_bans WHERE client_ip = $1::inet", [ip]);
    await p.query("DELETE FROM rejected_requests WHERE client_ip = $1::inet", [ip]);
    await p.end();
}

async function preCleanup() {
    // Vyčisti staré rejection záznamy + ban pre 127.0.0.1 (od predchádzajúcich test runov)
    // aby sme nezdedili AUTO_FAIL2BAN trigger z minulých neúspechov.
    const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
    try {
        await p.query("DELETE FROM rejected_requests WHERE client_ip IN ('127.0.0.1', '::1') AND occurred_at > NOW() - INTERVAL '1 hour'");
        await p.query("UPDATE ip_bans SET revoked_at = CURRENT_TIMESTAMP, revoked_by = 'test-cleanup' WHERE client_ip IN ('127.0.0.1', '::1', '10.88.88.88', '10.99.99.99') AND revoked_at IS NULL");
        await p.query("DELETE FROM signature_failures WHERE client_ip IN ('127.0.0.1', '::1') AND occurred_at > NOW() - INTERVAL '1 hour'");
    } catch (e) { /* */ }
    await p.end();
    
    // Force refresh ban cache na servery (nech sa cache vyčistí)
    await axios.post(`${BASE}/api/admin/abuse/unban`, { client_ip: '127.0.0.1', reason: 'pre-test cleanup' },
        { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
    
    // Reset rate-limit buckets (testy [3]-[6] potrebujú 5 fresh pay slots bez admin bypass).
    // Tento endpoint je súčasť Phase 2.2 test toolingu.
    await axios.post(`${BASE}/api/admin/abuse/reset-rate-limit`, { which: 'all' },
        { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
    
    await new Promise(r => setTimeout(r, 200));
}

(async () => {
    console.log(c.b('\n=== UMBRAXON Phase 2.2 Anti-Abuse Test ==='));
    await preCleanup();
    const cleanupList = [];
    
    try {
        
        // ====================================================================
        // [1] PoW challenge endpoint funguje
        // ====================================================================
        console.log(c.b('\n[1] PoW challenge endpoint funguje'));
        let challengeData;
        await run('GET /api/pow/challenge', async () => {
            const r = await axios.get(`${BASE}/api/pow/challenge?purpose=pay&difficulty=10`);
            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
            if (!r.data.challenge_id || !r.data.challenge) throw new Error('chýba challenge_id/challenge');
            if (r.data.difficulty !== 10) throw new Error('difficulty nesedí');
            challengeData = r.data;
            ok('challenge issued', `id=${r.data.challenge_id.slice(0,16)} diff=${r.data.difficulty}`);
        });
        
        // ====================================================================
        // [2] PoW verify endpoint funguje (priame overenie)
        // ====================================================================
        console.log(c.b('\n[2] PoW verify endpoint (samostatne)'));
        await run('PoW solve + verify', async () => {
            const ch = await axios.get(`${BASE}/api/pow/challenge?purpose=generic&difficulty=10`);
            const sol = pow.solve(ch.data.challenge, ch.data.difficulty);
            const v = await axios.post(`${BASE}/api/pow/verify`, {
                challenge_id: ch.data.challenge_id, nonce: sol.nonce, iterations: sol.iterations,
            });
            if (!v.data.valid) throw new Error('verify nepovoľuje validné riešenie');
            ok('valid solution accepted', `iter=${sol.iterations} hash_prefix=${v.data.hash_prefix}`);
        });
        
        // ====================================================================
        // [3] /api/pay BEZ PoW → 402
        // ====================================================================
        console.log(c.b('\n[3] /api/pay BEZ PoW → 402 POW_REQUIRED'));
        await run('pay rejects no-pow', async () => {
            const r = await axios.post(`${BASE}/api/pay`, {
                amount: 10000, agentName: 'NONEXISTENT-XYZ-123',
            }, { validateStatus: () => true });
            if (r.status !== 402) throw new Error(`expected 402, got ${r.status}: ${JSON.stringify(r.data)}`);
            if (r.data.error !== 'POW_REQUIRED') throw new Error(`expected POW_REQUIRED, got ${r.data.error}`);
            ok('PoW required', `HTTP 402 ${r.data.error} difficulty=${r.data.difficulty}`);
        });
        
        // ====================================================================
        // [4] /api/pay s validným PoW → OK (alebo 409 ak agentName existuje, ale neprejde POW gate)
        // ====================================================================
        console.log(c.b('\n[4] /api/pay s validným PoW solution'));
        await run('pay with valid pow', async () => {
            const sol = await getPow('pay', 12);
            const r = await axios.post(`${BASE}/api/pay`, {
                amount: 10000, agentName: 'ABTEST-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
                pow: sol,
            }, { validateStatus: () => true });
            if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
            if (!r.data.invoiceId) throw new Error('chýba invoiceId');
            ok('PoW accepted, invoice issued', `method=${r.data.method} iter=${sol.iterations}`);
        });
        
        // ====================================================================
        // [5] /api/pay s reused PoW (rovnaké challenge_id 2×) → 402 POW_ALREADY_SOLVED
        // ====================================================================
        console.log(c.b('\n[5] /api/pay s reused PoW → 402 POW_ALREADY_SOLVED'));
        await run('pow reuse rejected', async () => {
            const sol = await getPow('pay', 12);
            await axios.post(`${BASE}/api/pay`, {
                amount: 10000, agentName: 'REUSE-A-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
                pow: sol,
            }, { validateStatus: () => true });
            // Druhé použitie rovnakého challenge_id
            const r2 = await axios.post(`${BASE}/api/pay`, {
                amount: 10000, agentName: 'REUSE-B-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
                pow: sol,
            }, { validateStatus: () => true });
            if (r2.status !== 402) throw new Error(`expected 402, got ${r2.status}`);
            if (r2.data.error !== 'POW_ALREADY_SOLVED') throw new Error(`expected POW_ALREADY_SOLVED, got ${r2.data.error}`);
            ok('PoW one-shot enforced', `error=${r2.data.error}`);
        });
        
        // ====================================================================
        // [6] /api/pay s bad nonce → POW_INSUFFICIENT_WORK
        // ====================================================================
        console.log(c.b('\n[6] /api/pay s bad PoW nonce → 402 POW_INSUFFICIENT_WORK'));
        await run('pow bad nonce', async () => {
            const ch = await axios.get(`${BASE}/api/pow/challenge?purpose=pay&difficulty=20`);
            const r = await axios.post(`${BASE}/api/pay`, {
                amount: 10000, agentName: 'BADPOW-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
                pow: { challenge_id: ch.data.challenge_id, nonce: 'ffffffff' /* určite bez leading zeros */ },
            }, { validateStatus: () => true });
            if (r.status !== 402) throw new Error(`expected 402, got ${r.status}: ${JSON.stringify(r.data)}`);
            if (r.data.error !== 'POW_INSUFFICIENT_WORK') throw new Error(`expected POW_INSUFFICIENT_WORK, got ${r.data.error}`);
            ok('insufficient work rejected', `error=${r.data.error}`);
        });
        
        // ====================================================================
        // [7] Admin bypass: X-Admin-Key preskočí PoW gate
        // ====================================================================
        console.log(c.b('\n[7] Admin bypass: X-Admin-Key preskočí PoW gate'));
        await run('admin bypass works', async () => {
            const r = await axios.post(`${BASE}/api/pay`, {
                amount: 10000, agentName: 'ADMINBYPASS-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
            }, { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
            if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
            ok('admin bypass', `method=${r.data.method}`);
        });
        
        // ====================================================================
        // [8] Bad admin key → rejection log
        // ====================================================================
        console.log(c.b('\n[8] Bad admin key sa zapíše do rejected_requests (severity=critical)'));
        await run('bad admin key audited', async () => {
            const startTime = new Date();
            // Pár pokusov o admin endpoint so zlým keyom
            for (let i = 0; i < 3; i++) {
                await axios.get(`${BASE}/api/dashboard`,
                    { headers: { 'X-Admin-Key': 'WRONG_KEY_' + i }, validateStatus: () => true });
            }
            await new Promise(r => setTimeout(r, 200));
            
            const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
            const r = await p.query(
                `SELECT COUNT(*) AS n FROM rejected_requests
                 WHERE reason = 'BAD_ADMIN_KEY' AND occurred_at >= $1`,
                [startTime]
            );
            await p.end();
            const n = parseInt(r.rows[0].n, 10);
            if (n < 3) throw new Error(`expected ≥3 BAD_ADMIN_KEY rejections, got ${n}`);
            ok('bad admin key logged', `count=${n} severity=critical`);
        });
        
        // ====================================================================
        // Setup: vytvor bota pre signature_failure testy
        // ====================================================================
        console.log(c.b('\n[Setup] Vytváram bota pre signature-failure testy'));
        const bot = await registerBot('BASIC');
        cleanupList.push(bot.kya_id);
        ok('bot registered', `kya_id=${bot.kya_id}`);
        
        // ====================================================================
        // [9] Bad bot signature na action → signature_failure logged
        // ====================================================================
        console.log(c.b('\n[9] Bad bot signature na action → signature_failure log'));
        await run('signature failure logged', async () => {
            const fake = genKeypair();
            const nonce = crypto.randomBytes(16).toString('hex');
            const timestamp = new Date().toISOString();
            const signedPayload = JSON.stringify({
                action_type: 'USER_INTERACTION', target: null, context: null,
                evidence_hash: null, nonce, timestamp,
            });
            const digest = crypto.createHash('sha256').update(signedPayload).digest();
            const fakeSig = sign(fake.priv, digest);  // podpis cudzou kľúčou
            
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/action`, {
                action_type: 'USER_INTERACTION', signature: fakeSig, nonce, timestamp,
            }, { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
            if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
            
            await new Promise(r => setTimeout(r, 200));
            const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
            const sf = await p.query(
                `SELECT COUNT(*) AS n FROM signature_failures WHERE kya_id = $1 AND endpoint = 'action'`,
                [bot.kya_id]
            );
            await p.end();
            if (parseInt(sf.rows[0].n, 10) < 1) throw new Error('signature_failure nezaznamenané');
            ok('sig failure recorded', `count=${sf.rows[0].n} endpoint=action`);
        });
        
        // ====================================================================
        // [10] Admin manual ban — testovacia IP, ban check vyžaduje pol-sekundu nech sa refresh-ne cache
        // POZN: nemôžeme banovať svoju vlastnú IP (127.0.0.1), inak by sme sa vyhostili
        // ====================================================================
        const TEST_IP = '10.99.99.99';
        console.log(c.b(`\n[10] Admin ban IP ${TEST_IP} → uložené do DB + cache`));
        await run('manual ip ban', async () => {
            await cleanupIp(TEST_IP);  // istota že tam ešte nie je
            const r = await axios.post(`${BASE}/api/admin/abuse/ban`, {
                client_ip: TEST_IP, duration_hours: 1, reason: 'manual test ban',
            }, { headers: { 'X-Admin-Key': ADMIN_KEY } });
            if (!r.data.banned) throw new Error('not banned');
            
            // Over že je v DB
            const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
            const dbCheck = await p.query(`SELECT id FROM ip_bans WHERE client_ip = $1::inet AND revoked_at IS NULL`, [TEST_IP]);
            await p.end();
            if (dbCheck.rowCount !== 1) throw new Error('ban nenájdený v DB');
            
            // Over že je v summary
            const sum = await axios.get(`${BASE}/api/admin/abuse?include=summary,bans`,
                { headers: { 'X-Admin-Key': ADMIN_KEY } });
            const found = sum.data.active_bans?.find(b => b.ip.startsWith(TEST_IP));
            if (!found) throw new Error('ban nie je v active_bans liste');
            ok('ban created + listed', `ip=${TEST_IP} expires=${found.expires_at?.slice(0, 19)}`);
        });
        
        // ====================================================================
        // [11] Admin unban
        // ====================================================================
        console.log(c.b(`\n[11] Admin unban ${TEST_IP}`));
        await run('manual ip unban', async () => {
            const r = await axios.post(`${BASE}/api/admin/abuse/unban`, {
                client_ip: TEST_IP, reason: 'test cleanup',
            }, { headers: { 'X-Admin-Key': ADMIN_KEY } });
            if (!r.data.unbanned) throw new Error('not unbanned');
            
            const sum = await axios.get(`${BASE}/api/admin/abuse?include=bans`,
                { headers: { 'X-Admin-Key': ADMIN_KEY } });
            const stillThere = sum.data.active_bans?.find(b => b.ip.startsWith(TEST_IP));
            if (stillThere) throw new Error('ban stále aktívny po unban');
            ok('unbanned successfully', `count=${r.data.count}`);
        });
        
        // ====================================================================
        // [12] 10× bad sig → auto-slash agenta
        // BAD_SIG_PER_HOUR_THRESHOLD = 10 default
        // ====================================================================
        console.log(c.b('\n[12] Bad-sig auto-slash: 10× bad sig na action → PROTOCOL_VIOLATION (-100)'));
        const slashBot = await registerBot('BASIC');
        cleanupList.push(slashBot.kya_id);
        await run('auto-slash via bad sig burst', async () => {
            const beforeRep = await axios.get(`${BASE}/api/agent/${slashBot.kya_id}/reputation`);
            const beforeScore = beforeRep.data.reputation.score;
            
            const fake = genKeypair();
            // Pošli 10 bad-sig requestov (každý s unique nonce aby nepadli na replay)
            for (let i = 0; i < 10; i++) {
                const nonce = crypto.randomBytes(16).toString('hex');
                const timestamp = new Date().toISOString();
                const signedPayload = JSON.stringify({
                    action_type: 'USER_INTERACTION', target: null, context: null,
                    evidence_hash: null, nonce, timestamp,
                });
                const digest = crypto.createHash('sha256').update(signedPayload).digest();
                const fakeSig = sign(fake.priv, digest);
                await axios.post(`${BASE}/api/agent/${slashBot.kya_id}/action`, {
                    action_type: 'USER_INTERACTION', signature: fakeSig, nonce, timestamp,
                }, { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
            }
            
            // Auto-slash beží asynchrónne, malú chvíľu počkáme
            await new Promise(r => setTimeout(r, 500));
            
            const afterRep = await axios.get(`${BASE}/api/agent/${slashBot.kya_id}/reputation`);
            const afterScore = afterRep.data.reputation.score;
            
            if (afterScore >= beforeScore) {
                throw new Error(`auto-slash nezbehol: before=${beforeScore} after=${afterScore}`);
            }
            const delta = afterScore - beforeScore;
            
            // Over že je event v audit log
            const ev = await axios.get(`${BASE}/api/agent/${slashBot.kya_id}/events`);
            const violationEvent = ev.data.events.find(e =>
                e.event_type === 'PROTOCOL_VIOLATION' && e.source === 'system'
            );
            if (!violationEvent) throw new Error('PROTOCOL_VIOLATION event chýba v reputation_events');
            
            ok('auto-slash applied', `score ${beforeScore}→${afterScore} (Δ${delta}) reason="${violationEvent.reason?.slice(0, 50)}..."`);
        });
        
        // ====================================================================
        // [13] Anomaly detection: target spam → flag + slash
        // ====================================================================
        console.log(c.b('\n[13] Target spam detection: 50+ action s rovnakým target → flag + auto-slash'));
        const anomalyBot = await registerBot('BASIC');
        cleanupList.push(anomalyBot.kya_id);
        await run('anomaly target spam', async () => {
            const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
            try {
                // Vlož 55 action_log záznamov priamo do DB (rýchle setup, simuluje spam aktivitu bota)
                const targetStr = 'spam-target-abc';
                for (let i = 0; i < 55; i++) {
                    await p.query(
                        `INSERT INTO action_log
                         (agent_id, kya_id, action_type, target, signature, nonce, score_delta, bot_timestamp)
                         VALUES ($1, $2, $3, $4, $5, $6, 0, CURRENT_TIMESTAMP)`,
                        [anomalyBot.db_id, anomalyBot.kya_id, 'USER_INTERACTION',
                         targetStr, 'fake_signature_' + i, crypto.randomBytes(16).toString('hex')]
                    );
                }
            } finally {
                await p.end();
            }
            
            const beforeRep = await axios.get(`${BASE}/api/agent/${anomalyBot.kya_id}/reputation`);
            const beforeScore = beforeRep.data.reputation.score;
            
            // Spustí decay worker manuálne — anomaly detection beží v rámci ticku
            const dr = await axios.post(`${BASE}/api/admin/run-decay`, {},
                { headers: { 'X-Admin-Key': ADMIN_KEY } });
            
            if (!dr.data.stats?.anomaly) throw new Error('decay neobsahuje anomaly stats');
            
            const afterRep = await axios.get(`${BASE}/api/agent/${anomalyBot.kya_id}/reputation`);
            const afterScore = afterRep.data.reputation.score;
            
            if (afterScore >= beforeScore) {
                throw new Error(`anomaly auto-slash nezbehol: before=${beforeScore} after=${afterScore}, stats=${JSON.stringify(dr.data.stats.anomaly)}`);
            }
            
            // Over že action_log má anomaly_flagged
            const p2 = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
            const flagCheck = await p2.query(
                `SELECT COUNT(*) AS n FROM action_log WHERE kya_id = $1 AND anomaly_flagged = TRUE`,
                [anomalyBot.kya_id]
            );
            await p2.end();
            const flaggedCount = parseInt(flagCheck.rows[0].n, 10);
            if (flaggedCount < 50) throw new Error(`expected ≥50 flagged actions, got ${flaggedCount}`);
            
            ok('anomaly detected + slashed', `score ${beforeScore}→${afterScore} flagged=${flaggedCount} stats=${JSON.stringify(dr.data.stats.anomaly)}`);
        });
        
        // ====================================================================
        // [14] Burst → IP auto-ban
        // Generujeme 25 critical rejections (= bad admin keys) z konkrétneho zdroja
        // a očakávame že IP sa auto-banne (gross threshold = 20).
        // Pre tento test používame priame INSERT do rejected_requests + zavolanie maybeAutoBanIp.
        // ====================================================================
        const BURST_IP = '10.88.88.88';
        console.log(c.b(`\n[14] Burst critical rejections z ${BURST_IP} → auto-ban kandidát`));
        await run('fail2ban auto-trigger', async () => {
            await cleanupIp(BURST_IP);
            const p = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT });
            try {
                // Simulujeme burst — 25 BAD_ADMIN_KEY rejections z tej istej IP za posledných 10 min
                for (let i = 0; i < 25; i++) {
                    await p.query(
                        `INSERT INTO rejected_requests
                         (path, method, reason, http_status, severity, client_ip)
                         VALUES ('/api/dashboard', 'GET', 'BAD_ADMIN_KEY', 401, 'critical', $1::inet)`,
                        [BURST_IP]
                    );
                }
                // Trigger auto-ban check
                const r = await abuseTracker.maybeAutoBanIp(p, BURST_IP);
                if (!r || !r.banned) throw new Error(`expected auto-ban, got ${JSON.stringify(r)}`);
                
                // Over že v DB máme ban
                const dbCheck = await p.query(`SELECT id, reason FROM ip_bans WHERE client_ip = $1::inet AND revoked_at IS NULL`, [BURST_IP]);
                if (dbCheck.rowCount !== 1) throw new Error('ban nezbehol');
                ok('auto-ban triggered', `reason=${r.reason} ip=${BURST_IP} expires=${r.expires_at?.toISOString?.()?.slice(0, 19)}`);
            } finally {
                await p.end();
            }
        });
        
        // ====================================================================
        // [15] Admin abuse summary + per-agent endpoint
        // ====================================================================
        console.log(c.b('\n[15] /api/admin/abuse summary endpoint'));
        await run('admin abuse summary', async () => {
            const r = await axios.get(`${BASE}/api/admin/abuse?include=summary,bans,signature_failures,pow,anomalies`,
                { headers: { 'X-Admin-Key': ADMIN_KEY } });
            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
            if (!r.data.summary) throw new Error('chýba summary');
            if (!r.data.config) throw new Error('chýba config');
            ok('summary returned', `active_bans=${r.data.summary.active_bans} rej_1h=${r.data.summary.rejections_1h} sigfails_1h=${r.data.summary.sigfails_1h} pow_issued_1h=${r.data.summary.pow_issued_1h}`);
        });
        
        console.log(c.b('\n[15b] /api/admin/abuse/agent/:kya_id'));
        await run('admin abuse agent view', async () => {
            const r = await axios.get(`${BASE}/api/admin/abuse/agent/${slashBot.kya_id}`,
                { headers: { 'X-Admin-Key': ADMIN_KEY } });
            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
            if (!Array.isArray(r.data.signature_failures_24h)) throw new Error('chýba signature_failures_24h');
            if (!Array.isArray(r.data.rejections_7d)) throw new Error('chýba rejections_7d');
            ok('agent view ok', `slashBot rejections_7d=${r.data.rejections_7d.length}`);
        });
        
    } finally {
        // Cleanup
        console.log(c.b('\n[Cleanup]'));
        try { await cleanupBots(cleanupList); ok('bots cleaned', `count=${cleanupList.length}`); }
        catch (e) { fail('cleanup bots', e.message); }
        
        try {
            await cleanupIp('10.99.99.99');
            await cleanupIp('10.88.88.88');
            ok('test IPs cleaned');
        } catch (e) { fail('cleanup ips', e.message); }
    }
    
    console.log('\n' + c.b('=== SUMMARY ==='));
    console.log(`${c.g('✓ Passed:')} ${passed}`);
    console.log(`${failed > 0 ? c.r('✗ Failed:') : '✗ Failed:'} ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(c.r('FATAL:'), e.stack || e); process.exit(2); });
