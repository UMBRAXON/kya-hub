#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 2.4 Resilience & Scale E2E Test Suite
// ============================================================================
// Pokrýva:
//   [Pricing]  1. GET /api/admin/pricing vracia current snapshot
//   [Pricing]  2. POST /api/admin/pricing update BASIC sats → reload + active
//   [Pricing]  3. History endpoint vráti starý+nový riadok
//   [Pricing]  4. Reload endpoint vráti aktuálny snapshot
//   [Pricing]  5. GET /api/tiers reflektuje aktualizovanú cenu
//   [Retent]   6. Retention sizes endpoint vracia table sizes
//   [Retent]   7. Retention tick manuálne (vyrobí 1 starý action_log → archive)
//   [Sybil]    8. Reciprocal review-circle: A→B+ a B→A+ trigger penalty 0.10
//   [Sybil]    9. Mladý reporter má age_weight ≤ 0.25 (váha < base)
//   [Sybil]    10. detectReviewCircle vracia reciprocal=true
//   [Sybil]    11. computeWeightedDelta s ELITE reporter má vyšší multiplier
//   [Clock]    12. TIMESTAMP_SKEW_MS=1000 → action s old ts vráti TIMESTAMP_SKEW
//   [Admin]    13. /api/admin/sybil/circles vráti detected pairs (po seedovaní)
//   [Regress]  14. Štandardný heartbeat + cert/status stále funguje
// ============================================================================
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const BTCPAY_WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET;
if (!ADMIN_KEY) { console.error('ADMIN_API_KEY missing'); process.exit(2); }
axios.defaults.headers.common['X-Admin-Key'] = ADMIN_KEY;

const manifestSchema = require('./lib/manifest-schema');
const sybilResistance = require('./lib/sybil-resistance');
const retentionWorker = require('./lib/retention-worker');

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

async function registerBot(tierRequested = 'BASIC') {
    const bot = genKeypair();
    const agentName = 'P24-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const manifest = {
        protocol_version: '1.0',
        agent: { name: agentName, version: '1.0.0', pubkey: bot.pubHex, capabilities: ['phase24_test'] },
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
        headers: { 'Content-Type': 'application/json', 'BTCPay-Sig': sigH, 'BTCPay-Delivery-Id': 'TEST-P24-' + Date.now() + Math.random() },
    });
    const p = newPool();
    const r = await p.query('SELECT kya_id, id, verified_at FROM agents WHERE agent_name = $1', [agentName]);
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
            await p.query('DELETE FROM action_log_archive WHERE kya_id = $1', [k]);
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

function signedReport(bot, { target_kya_id, report_type, description }) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify({
        target_kya: target_kya_id, report_type, description, evidence: null, nonce, timestamp,
    });
    const sig = sign(bot.priv, crypto.createHash('sha256').update(payload).digest());
    return {
        report_type, description,
        reporter_kya_id: bot.kya_id,
        reporter_pubkey: bot.pubHex,
        reporter_signature: sig,
        report_nonce: nonce,
        report_timestamp: timestamp,
    };
}

(async () => {
    console.log(c.b('\n=== UMBRAXON Phase 2.4 Resilience & Scale Test ==='));
    await preCleanup();
    const cleanupList = [];
    let originalBasicSats = null;
    
    try {
        // ====================================================================
        // [1] GET /api/admin/pricing — current snapshot
        // ====================================================================
        console.log(c.b('\n[1] GET /api/admin/pricing → current snapshot'));
        await run('pricing fetch', async () => {
            const r = await axios.get(`${BASE}/api/admin/pricing`);
            if (!r.data.current || !r.data.current.BASIC || !r.data.current.ELITE) {
                throw new Error('missing current.BASIC or current.ELITE');
            }
            originalBasicSats = r.data.current.BASIC.amount_sats;
            ok('pricing snapshot OK', `BASIC=${r.data.current.BASIC.amount_sats} ELITE=${r.data.current.ELITE.amount_sats}`);
        });
        
        // ====================================================================
        // [2] POST /api/admin/pricing — update BASIC
        // ====================================================================
        console.log(c.b('\n[2] POST /api/admin/pricing → update BASIC'));
        await run('pricing live update', async () => {
            const newSats = 11000;
            const r = await axios.post(`${BASE}/api/admin/pricing`, {
                tier_name: 'BASIC', amount_sats: newSats,
                change_reason: 'phase24 test bump',
            });
            if (!r.data.ok) throw new Error('not ok');
            if (r.data.current.amount_sats !== newSats) throw new Error('current not updated');
            if (r.data.active_snapshot.BASIC.amount_sats !== newSats) throw new Error('snapshot not reloaded');
            ok('pricing updated live', `${originalBasicSats} → ${newSats}`);
        });
        
        // ====================================================================
        // [3] History endpoint vráti starý + nový riadok
        // ====================================================================
        console.log(c.b('\n[3] GET /api/admin/pricing?history=true → history'));
        await run('pricing history', async () => {
            const r = await axios.get(`${BASE}/api/admin/pricing?history=true&tier=BASIC`);
            if (!Array.isArray(r.data.history) || r.data.history.length < 2) {
                throw new Error(`expected ≥2 history entries, got ${r.data.history?.length}`);
            }
            const active = r.data.history.filter(h => !h.effective_until);
            const expired = r.data.history.filter(h => h.effective_until);
            if (active.length !== 1) throw new Error('expected 1 active row');
            if (expired.length < 1) throw new Error('expected ≥1 expired row');
            ok('history correct', `active=${active.length} expired=${expired.length}`);
        });
        
        // ====================================================================
        // [4] Force reload endpoint
        // ====================================================================
        console.log(c.b('\n[4] POST /api/admin/pricing/reload'));
        await run('pricing reload', async () => {
            const r = await axios.post(`${BASE}/api/admin/pricing/reload`);
            if (!r.data.ok) throw new Error('reload not ok');
            if (r.data.snapshot.BASIC.amount_sats !== 11000) throw new Error('reload snapshot wrong');
            ok('reload OK', `BASIC=${r.data.snapshot.BASIC.amount_sats}`);
        });
        
        // ====================================================================
        // [5] Vráti BASIC pricing späť (cleanup)
        // ====================================================================
        await axios.post(`${BASE}/api/admin/pricing`, {
            tier_name: 'BASIC', amount_sats: originalBasicSats,
            change_reason: 'phase24 test restore',
        });
        
        console.log(c.b('\n[5] GET /api/tiers reflektuje aktualizovanú cenu'));
        await run('public /api/tiers reflects', async () => {
            const r = await axios.get(`${BASE}/api/tiers`);
            // /api/tiers vracia priamo { BASIC: { total, ...}, ELITE: {...}, ... }
            if (!r.data.BASIC || typeof r.data.BASIC.total !== 'number') {
                throw new Error('no BASIC tier in response');
            }
            if (r.data.BASIC.total !== originalBasicSats) {
                throw new Error(`expected BASIC.total=${originalBasicSats}, got ${r.data.BASIC.total}`);
            }
            ok('/api/tiers reflects pricing', `BASIC.total=${r.data.BASIC.total}`);
        });
        
        // ====================================================================
        // [6] Retention sizes endpoint
        // ====================================================================
        console.log(c.b('\n[6] GET /api/admin/retention/sizes'));
        await run('retention sizes', async () => {
            const r = await axios.get(`${BASE}/api/admin/retention/sizes`);
            if (!Array.isArray(r.data.tables)) throw new Error('no tables array');
            const names = r.data.tables.map(t => t.table_name);
            const expected = ['action_log', 'action_log_archive', 'reports', 'reports_archive', 'cert_signing_log'];
            for (const e of expected) {
                if (!names.includes(e)) throw new Error(`missing ${e} in sizes`);
            }
            if (!r.data.retention_config) throw new Error('missing retention_config');
            ok('retention sizes returned', `tables=${r.data.tables.length}`);
        });
        
        // ====================================================================
        // [7] Retention tick: vyrob starý action_log → archive
        // ====================================================================
        console.log(c.b('\n[7] Retention tick — archive starý action_log'));
        await run('retention archive cycle', async () => {
            const bot = await registerBot('BASIC');
            cleanupList.push(bot.kya_id);
            
            const p = newPool();
            try {
                // Vlož 3 staré action_log entries (received_at v minulosti pred RETENTION_ACTION_LOG_DAYS)
                for (let i = 0; i < 3; i++) {
                    await p.query(
                        `INSERT INTO action_log (agent_id, kya_id, action_type, signature, nonce, score_delta, received_at, bot_timestamp)
                         VALUES ($1, $2, 'USER_INTERACTION', $3, $4, 0,
                                 NOW() - INTERVAL '120 days', NOW() - INTERVAL '120 days')`,
                        [bot.db_id, bot.kya_id, 'sig-' + crypto.randomBytes(16).toString('hex'), 'nonce-' + crypto.randomBytes(8).toString('hex')]
                    );
                }
                
                // Skontroluj že INSERT prebol
                const ins = await p.query(`SELECT COUNT(*) FROM action_log WHERE kya_id = $1`, [bot.kya_id]);
                if (parseInt(ins.rows[0].count, 10) !== 3) {
                    throw new Error(`INSERT failed: expected 3 rows, got ${ins.rows[0].count}`);
                }
                
                // Spusti retention tick
                const r = await axios.post(`${BASE}/api/admin/retention/run`);
                if (!r.data.ok) throw new Error('retention run failed');
                if (!r.data.stats.archived) throw new Error(`no .archived in stats: ${JSON.stringify(r.data.stats)}`);
                if (typeof r.data.stats.archived.action_log !== 'number') {
                    throw new Error(`action_log not in stats: ${JSON.stringify(r.data.stats)}`);
                }
                
                // Overí že 3 záznamy sú v archive
                const arch = await p.query(
                    'SELECT COUNT(*) FROM action_log_archive WHERE kya_id = $1',
                    [bot.kya_id]
                );
                if (parseInt(arch.rows[0].count, 10) < 3) {
                    throw new Error(`expected ≥3 archived, got ${arch.rows[0].count}`);
                }
                
                // Overí že už nie sú v origin
                const orig = await p.query(
                    `SELECT COUNT(*) FROM action_log WHERE kya_id = $1 AND received_at < NOW() - INTERVAL '90 days'`,
                    [bot.kya_id]
                );
                if (parseInt(orig.rows[0].count, 10) !== 0) {
                    throw new Error('origin still has old rows');
                }
                
                ok('retention archive-then-delete works', `archived ${r.data.stats.archived.action_log} rows`);
            } finally {
                await p.end();
            }
        });
        
        // ====================================================================
        // [8] Sybil reciprocal circle detection (E2E)
        // ====================================================================
        console.log(c.b('\n[8] Sybil reciprocal review circle → 0.10 penalty'));
        await run('sybil circle penalty', async () => {
            const A = await registerBot('BASIC');
            const B = await registerBot('BASIC');
            cleanupList.push(A.kya_id, B.kya_id);
            
            const r1 = await axios.post(`${BASE}/api/agent/${B.kya_id}/report`,
                signedReport(A, { target_kya_id: B.kya_id, report_type: 'POOR_QUALITY',
                    description: 'Bot odpovedá pomaly a často sa myli, low quality output'.repeat(3) }),
                { validateStatus: () => true });
            if (r1.status !== 200) throw new Error(`r1 status=${r1.status} body=${JSON.stringify(r1.data)}`);
            if (r1.data.status !== 'AUTO_APPLIED') throw new Error(`r1 not auto applied: ${r1.data.status}`);
            
            // Wait short moment, lebo report potrebuje byť plnohodnotne committed predtým
            await new Promise(s => setTimeout(s, 250));
            
            const r2 = await axios.post(`${BASE}/api/agent/${A.kya_id}/report`,
                signedReport(B, { target_kya_id: A.kya_id, report_type: 'POOR_QUALITY',
                    description: 'Bot vracia chybné výsledky, nespoľahlivý'.repeat(3) }),
                { validateStatus: () => true });
            if (r2.status !== 200) throw new Error(`r2 status=${r2.status} body=${JSON.stringify(r2.data)}`);
            if (r2.data.status !== 'AUTO_APPLIED') throw new Error(`r2 not auto applied: ${r2.data.status} body=${JSON.stringify(r2.data)}`);
            
            const sw = r2.data.sybil_weighting;
            if (!sw) throw new Error(`sybil_weighting chýba: full=${JSON.stringify(r2.data)}`);
            if (!sw.circle || sw.circle.reciprocal !== true) {
                throw new Error(`expected reciprocal=true, got ${JSON.stringify(sw.circle)} full=${JSON.stringify(sw)}`);
            }
            if (sw.circle_weight !== 0.10) {
                throw new Error(`expected circle_weight=0.10, got ${sw.circle_weight}`);
            }
            ok('reciprocal sybil circle penalty', `circle_weight=${sw.circle_weight} total=${sw.total_weight}`);
        });
        
        // ====================================================================
        // [9] Mladý reporter age_weight ≤ 0.25
        // ====================================================================
        console.log(c.b('\n[9] Sybil age weighting → mladý reporter má 0.25× váhu'));
        await run('sybil age weight young', async () => {
            const A = await registerBot('BASIC');
            const B = await registerBot('BASIC');
            cleanupList.push(A.kya_id, B.kya_id);
            // A je len pár sekúnd starý → ageWeight = 0.25
            const r = await axios.post(`${BASE}/api/agent/${B.kya_id}/report`,
                signedReport(A, { target_kya_id: B.kya_id, report_type: 'POOR_QUALITY',
                    description: 'Bot vracia výsledky s chybami, kvalita nedostatočná'.repeat(3) }));
            const sw = r.data.sybil_weighting;
            if (!sw) throw new Error('no sybil_weighting');
            if (sw.age_weight !== 0.25) {
                throw new Error(`expected age_weight=0.25, got ${sw.age_weight} (age_days=${sw.reporter_age_days})`);
            }
            ok('young reporter age weight', `age_days=${sw.reporter_age_days} age_weight=${sw.age_weight}`);
        });
        
        // ====================================================================
        // [10] detectReviewCircle priamy unit-style test cez DB
        // ====================================================================
        console.log(c.b('\n[10] sybilResistance.detectReviewCircle direct'));
        await run('detectReviewCircle direct', async () => {
            // Vyrob fresh pair s reciprocal reports → potom direct call
            const X = await registerBot('BASIC');
            const Y = await registerBot('BASIC');
            cleanupList.push(X.kya_id, Y.kya_id);
            
            await axios.post(`${BASE}/api/agent/${Y.kya_id}/report`,
                signedReport(X, { target_kya_id: Y.kya_id, report_type: 'POOR_QUALITY',
                    description: 'Test report A->Y for direct detection'.repeat(2) }),
                { validateStatus: () => true });
            await new Promise(s => setTimeout(s, 200));
            
            const p = newPool();
            try {
                const client = await p.connect();
                try {
                    // Test reciprocal: Y → X smer (a X už predtým reportoval Y)
                    const d = await sybilResistance.detectReviewCircle(client, {
                        reporter_kya_id: Y.kya_id, target_kya_id: X.kya_id,
                    });
                    if (typeof d.count !== 'number') throw new Error('no count returned');
                    if (!d.reciprocal || d.count < 1) {
                        throw new Error(`expected reciprocal=true count≥1, got ${JSON.stringify(d)}`);
                    }
                    ok('detectReviewCircle returns reciprocal info', `reciprocal=${d.reciprocal} count=${d.count}`);
                } finally {
                    client.release();
                }
            } finally {
                await p.end();
            }
        });
        
        // ====================================================================
        // [11] computeWeightedDelta s ELITE multiplier
        // ====================================================================
        console.log(c.b('\n[11] sybilResistance ELITE multiplier > BASIC'));
        await run('elite reporter higher weight', async () => {
            const p = newPool();
            try {
                const client = await p.connect();
                try {
                    // Vyrob ELITE reportera "naoko" — update existing bota na ELITE tier + posun verified_at
                    const elite = await registerBot('BASIC');
                    cleanupList.push(elite.kya_id);
                    await client.query(
                        `UPDATE agents SET tier = 'ELITE', verified_at = NOW() - INTERVAL '365 days' WHERE kya_id = $1`,
                        [elite.kya_id]
                    );
                    const basic = await registerBot('BASIC');
                    cleanupList.push(basic.kya_id);
                    await client.query(
                        `UPDATE agents SET verified_at = NOW() - INTERVAL '365 days' WHERE kya_id = $1`,
                        [basic.kya_id]
                    );
                    const target = await registerBot('BASIC');
                    cleanupList.push(target.kya_id);
                    
                    const wElite = await sybilResistance.computeWeightedDelta(client, {
                        base_delta: -20, reporter_kya_id: elite.kya_id, target_kya_id: target.kya_id,
                    });
                    const wBasic = await sybilResistance.computeWeightedDelta(client, {
                        base_delta: -20, reporter_kya_id: basic.kya_id, target_kya_id: target.kya_id,
                    });
                    
                    if (wElite.breakdown.tier_weight <= wBasic.breakdown.tier_weight) {
                        throw new Error(`expected ELITE > BASIC, got E=${wElite.breakdown.tier_weight} B=${wBasic.breakdown.tier_weight}`);
                    }
                    if (Math.abs(wElite.weighted_delta) <= Math.abs(wBasic.weighted_delta)) {
                        throw new Error(`expected |E|>|B|, got E=${wElite.weighted_delta} B=${wBasic.weighted_delta}`);
                    }
                    ok('ELITE > BASIC delta', `Edelta=${wElite.weighted_delta} Bdelta=${wBasic.weighted_delta}`);
                } finally {
                    client.release();
                }
            } finally {
                await p.end();
            }
        });
        
        // ====================================================================
        // [12] Clock skew: skús action s 10-min starým timestamp
        // ====================================================================
        console.log(c.b('\n[12] TIMESTAMP_SKEW_MS — old timestamp rejected'));
        await run('timestamp skew rejected', async () => {
            const bot = await registerBot('BASIC');
            cleanupList.push(bot.kya_id);
            const nonce = crypto.randomBytes(16).toString('hex');
            const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const signedPayload = JSON.stringify({
                action_type: 'USER_INTERACTION', target: null, context: null,
                evidence_hash: null, nonce, timestamp: oldTs,
            });
            const digest = crypto.createHash('sha256').update(signedPayload).digest();
            const sig = sign(bot.priv, digest);
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/action`, {
                action_type: 'USER_INTERACTION', signature: sig, nonce, timestamp: oldTs,
            }, { validateStatus: () => true });
            if (r.status !== 400 || r.data.error !== 'TIMESTAMP_SKEW') {
                throw new Error(`expected 400 TIMESTAMP_SKEW, got ${r.status} ${JSON.stringify(r.data)}`);
            }
            if (!r.data.skew_ms_allowed) throw new Error('missing skew_ms_allowed in response');
            ok('TS skew enforced', `allowed=${r.data.skew_ms_allowed}ms`);
        });
        
        // ====================================================================
        // [13] /api/admin/sybil/circles
        // ====================================================================
        console.log(c.b('\n[13] /api/admin/sybil/circles detects pairs'));
        await run('sybil circles admin', async () => {
            const r = await axios.get(`${BASE}/api/admin/sybil/circles?days=30&min_pairs=1`);
            if (!Array.isArray(r.data.suspect_pairs)) throw new Error('no suspect_pairs array');
            // Test 8 vytvoril aspoň 1 pair
            if (r.data.suspect_pairs.length < 1) throw new Error('expected ≥1 suspect pair');
            ok('sybil circles detected', `pairs=${r.data.suspect_pairs.length}`);
        });
        
        // ====================================================================
        // [14] Regression: heartbeat + status stále funguje
        // ====================================================================
        console.log(c.b('\n[14] Regression: heartbeat + cert/status'));
        await run('regression heartbeat ok', async () => {
            const bot = await registerBot('BASIC');
            cleanupList.push(bot.kya_id);
            const nonce = crypto.randomBytes(16).toString('hex');
            const timestamp = new Date().toISOString();
            const digest = crypto.createHash('sha256').update(`${bot.kya_id}|${nonce}|${timestamp}`).digest();
            const sig = sign(bot.priv, digest);
            const r = await axios.post(`${BASE}/api/agent/${bot.kya_id}/heartbeat`, {
                signature: sig, nonce, timestamp,
            });
            if (!r.data.ok) throw new Error('heartbeat failed');
            const s = await axios.get(`${BASE}/api/cert/${bot.kya_id}/status`);
            if (s.data.status !== 'ACTIVE') throw new Error(`expected ACTIVE, got ${s.data.status}`);
            ok('heartbeat + status OK');
        });
        
    } finally {
        // Cleanup
        try { await cleanup(cleanupList); } catch (_) {}
        if (originalBasicSats) {
            try {
                await axios.post(`${BASE}/api/admin/pricing`, {
                    tier_name: 'BASIC', amount_sats: originalBasicSats,
                    change_reason: 'phase24 test cleanup restore',
                });
            } catch (_) {}
        }
    }
    
    console.log(c.b('\n=== RESULT ==='));
    console.log(`  Passed: ${c.g(passed)}`);
    console.log(`  Failed: ${failed ? c.r(failed) : c.g(failed)}`);
    process.exit(failed ? 1 : 0);
})();
