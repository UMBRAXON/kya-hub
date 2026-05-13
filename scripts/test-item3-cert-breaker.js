#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 3 smoke test
// ----------------------------------------------------------------------------
// In-process unit tests of lib/cert-issuance-breaker.js + end-to-end check
// of admin endpoints (GET /state, POST /reset).
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });
const axios = require('axios');

process.env.NOTIF_ENABLED = 'false';

// Lower thresholds for fast tests
process.env.CERT_BREAKER_WINDOW_MS = '5000';
process.env.CERT_BREAKER_MIN_SAMPLES = '20';
process.env.CERT_BREAKER_WARN_PCT = '3';
process.env.CERT_BREAKER_HALT_PCT = '8';

const breaker = require('../lib/cert-issuance-breaker');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
    console.log('=== 1) initial state ===');
    breaker._resetForTests();
    const s0 = breaker.state();
    assert('hard_halt=false initially', s0.hard_halt === false);
    assert('window_total=0 initially', s0.window_total === 0);
    assert('canIssue() = true', breaker.canIssue());
    assert('isMaintenanceMode() = false', !breaker.isMaintenanceMode());

    console.log('=== 2) below MIN_SAMPLES — no trip even at 100% fail ===');
    for (let i = 0; i < 10; i++) breaker.recordFailure(new Error('test ' + i));
    const s1 = breaker.state();
    assert('still not halted (samples < MIN_SAMPLES)', !s1.hard_halt);
    assert('window_total = 10', s1.window_total === 10);
    assert('window_failures = 10', s1.window_failures === 10);

    console.log('=== 3) reach MIN_SAMPLES with low fail% — soft warn but no halt ===');
    breaker._resetForTests();
    // 20 samples, 1 fail = 5% (above 3% WARN, below 8% HALT)
    for (let i = 0; i < 19; i++) breaker.recordSuccess();
    breaker.recordFailure(new Error('soft-warn-trigger'));
    const s2 = breaker.state();
    assert('window_total = 20', s2.window_total === 20);
    assert('window_failures = 1', s2.window_failures === 1);
    assert('window_fail_pct = 5', s2.window_fail_pct === 5);
    assert('still not HALTED', !s2.hard_halt);
    assert('canIssue() = true', breaker.canIssue());

    console.log('=== 4) cross HALT threshold (8%) ===');
    breaker._resetForTests();
    // 20 samples, 2 fails = 10% > 8% HALT
    for (let i = 0; i < 18; i++) breaker.recordSuccess();
    breaker.recordFailure(new Error('halt-1'));
    breaker.recordFailure(new Error('halt-2'));
    const s3 = breaker.state();
    assert('window_fail_pct = 10', s3.window_fail_pct === 10);
    assert('HARD HALT engaged', s3.hard_halt === true);
    assert('canIssue() = false', !breaker.canIssue());
    assert('isMaintenanceMode() = true', breaker.isMaintenanceMode());

    console.log('=== 5) wrap() throws CERT_ISSUANCE_HALTED while halted ===');
    let caught = null;
    try { await breaker.wrap(async () => 'never reached'); }
    catch (e) { caught = e; }
    assert('wrap() threw', !!caught);
    assert('error code is CERT_ISSUANCE_HALTED', caught && caught.code === 'CERT_ISSUANCE_HALTED');
    assert('retryAfterSec=300', caught && caught.retryAfterSec === 300);

    console.log('=== 6) admin reset clears halt ===');
    const r = breaker.reset({ admin: 'test-admin', reason: 'unit test reset' });
    assert('reset returned ok', r.ok);
    assert('was_halted in result', r.was_halted === true);
    const s4 = breaker.state();
    assert('hard_halt = false after reset', !s4.hard_halt);
    assert('canIssue() = true after reset', breaker.canIssue());
    assert('reset_history has 1 entry', s4.reset_history.length === 1);
    assert('reset_history admin = test-admin', s4.reset_history[0].admin === 'test-admin');

    console.log('=== 7) sample window slide (>WINDOW_MS old samples purged) ===');
    breaker._resetForTests();
    for (let i = 0; i < 20; i++) breaker.recordSuccess();
    const sBefore = breaker.state();
    assert('20 samples in window', sBefore.window_total === 20);
    await new Promise(r => setTimeout(r, 5200)); // > WINDOW_MS=5000
    breaker.recordSuccess(); // forces a purge inside record()
    const sAfter = breaker.state();
    assert('old samples purged (only 1 remains)', sAfter.window_total === 1);

    console.log('=== 8) wrap() records outcomes ===');
    breaker._resetForTests();
    await breaker.wrap(async () => 'ok');
    await breaker.wrap(async () => 'ok');
    try { await breaker.wrap(async () => { throw new Error('boom'); }); } catch (_) {}
    const s5 = breaker.state();
    assert('lifetime_successes=2', s5.lifetime_successes === 2);
    assert('lifetime_failures=1', s5.lifetime_failures === 1);

    console.log('=== 9) admin endpoints (live server) ===');
    const BASE = process.env.HUB_URL || 'http://127.0.0.1:' + (process.env.PORT || '3000');
    const ADMIN_KEY = process.env.ADMIN_API_KEY;
    if (!ADMIN_KEY) {
        console.log('  -- skipping live endpoint tests (ADMIN_API_KEY not set)');
    } else {
        try {
            const g = await axios.get(`${BASE}/api/admin/breaker/cert-issuance/state`, {
                headers: { 'X-Admin-Key': ADMIN_KEY }, timeout: 4000, validateStatus: () => true,
            });
            assert(`GET /state http=${g.status}`, g.status === 200);
            assert('state.config returned', !!g.data?.config);
            assert('state.state has hard_halt boolean', typeof g.data?.state?.hard_halt === 'boolean');

            const p = await axios.post(`${BASE}/api/admin/breaker/cert-issuance/reset`,
                { reason: 'item3 smoke test reset' },
                { headers: { 'X-Admin-Key': ADMIN_KEY }, timeout: 4000, validateStatus: () => true });
            assert(`POST /reset http=${p.status}`, p.status === 200);
            assert('reset returned ok', p.data?.ok === true);

            const g2 = await axios.get(`${BASE}/api/admin/breakers`, {
                headers: { 'X-Admin-Key': ADMIN_KEY }, timeout: 4000, validateStatus: () => true,
            });
            assert(`GET /api/admin/breakers includes cert_issuance http=${g2.status}`,
                g2.status === 200 && !!g2.data?.cert_issuance);

            // Bad admin key
            const bad = await axios.get(`${BASE}/api/admin/breaker/cert-issuance/state`, {
                headers: { 'X-Admin-Key': 'wrong-key' }, timeout: 4000, validateStatus: () => true,
            });
            assert(`GET /state with bad key → 401 (got ${bad.status})`, bad.status === 401);
        } catch (e) {
            console.log(`  -- live endpoint check FAILED: ${e.message}`);
            failed++;
        }
    }

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
