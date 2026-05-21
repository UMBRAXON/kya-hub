#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 6 smoke test
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });
process.env.NOTIF_ENABLED = 'false';

const axios = require('axios');
const liquidity = require('./lightning-liquidity-monitor');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
    console.log('=== 1) config defaults ===');
    assert('WARN_INBOUND_SATS default 500000', liquidity.CFG.WARN_INBOUND_SATS === 500000);
    assert('CRITICAL_INBOUND_SATS default 200000', liquidity.CFG.CRITICAL_INBOUND_SATS === 200000);
    assert('LSP_RECOMMENDED_FEE_SATS default 9000', liquidity.CFG.LSP_RECOMMENDED_FEE_SATS === 9000);

    console.log('=== 2) runOnce() returns a probe ===');
    const r = await liquidity.runOnce();
    assert(`runOnce exit code in {0,2,3,4} (got ${r.exit})`, [0, 2, 3, 4].includes(r.exit));
    assert('result has source field', typeof r.result?.source === 'string');

    if (r.result.source === 'nwc-fallback') {
        assert('inbound_unknown flag set on fallback', r.result.inbound_unknown === true);
        assert('outbound_sats present', Number.isFinite(r.result.outbound_sats));
        if (r.result.warn_no_unlock_password) {
            assert('warn_no_unlock_password only when no unlock pw', r.result.warn_no_unlock_password === true);
            console.log(`  -- alby-http path not available (no unlock pw); outbound: ${r.result.outbound_sats} sats`);
        } else {
            console.log(`  -- nwc fallback with unlock pw configured (${r.result.alby_http_reason}); outbound: ${r.result.outbound_sats} sats`);
        }
    } else if (r.result.source === 'alby-http') {
        assert('inbound_sats finite number', Number.isFinite(r.result.inbound_sats));
        assert('outbound_sats finite number', Number.isFinite(r.result.outbound_sats));
        assert('channels array present', Array.isArray(r.result.channels));
    }

    console.log('=== 3) admin endpoint GET /api/admin/lightning/liquidity ===');
    const BASE = process.env.HUB_URL || 'http://127.0.0.1:' + (process.env.PORT || '3000');
    const ADMIN_KEY = process.env.ADMIN_API_KEY;
    if (!ADMIN_KEY) {
        console.log('  -- skipping live endpoint tests (ADMIN_API_KEY not set)');
    } else {
        const g = await axios.get(`${BASE}/api/admin/lightning/liquidity`, {
            headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true, timeout: 5000,
        });
        assert(`GET (cached) http=${g.status}`, g.status === 200);

        const gf = await axios.get(`${BASE}/api/admin/lightning/liquidity?fresh=1`, {
            headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true, timeout: 20000,
        });
        assert(`GET (fresh=1) http=${gf.status}`, gf.status === 200);
        assert('fresh response has result', !!gf.data?.result);
        assert('result has source field', typeof gf.data?.result?.result?.source === 'string' || typeof gf.data?.result?.source === 'string');

        const bad = await axios.get(`${BASE}/api/admin/lightning/liquidity`, {
            headers: { 'X-Admin-Key': 'wrong' }, validateStatus: () => true, timeout: 4000,
        });
        assert(`bad admin key -> 401 (got ${bad.status})`, bad.status === 401);
    }

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
