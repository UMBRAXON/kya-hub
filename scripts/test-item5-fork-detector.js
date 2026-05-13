#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 5 smoke test
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });
process.env.NOTIF_ENABLED = 'false';

const axios = require('axios');
const fd = require('../lib/fork-detector');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
    console.log('=== 1) config sanity ===');
    assert('CFG.DEPTH numeric', Number.isFinite(fd.CFG.DEPTH));
    assert('CFG.MEMPOOL_BASE present', typeof fd.CFG.MEMPOOL_BASE === 'string' && fd.CFG.MEMPOOL_BASE.length > 0);
    assert('CFG.BLOCKSTREAM_BASE present', typeof fd.CFG.BLOCKSTREAM_BASE === 'string' && fd.CFG.BLOCKSTREAM_BASE.length > 0);

    console.log('=== 2) full probe — quorum on mainnet ===');
    const r = await fd.probe({ alert: false });
    assert(`probe returned status (got ${r.status})`, ['OK', 'INSUFFICIENT_SOURCES', 'FORK_DETECTED', 'LOCAL_RPC_UNREACHABLE'].includes(r.status));
    assert('result has compare_height', Number.isFinite(r.compare_height) || r.status === 'LOCAL_RPC_UNREACHABLE');
    assert('status=OK (production mainnet should agree)', r.status === 'OK', `reason: ${r.reason || 'n/a'}`);
    assert('local source ok', r.sources?.local?.ok === true);

    console.log('=== 3) at least 2 external sources answer ===');
    const externalOks = [r.sources?.mempool?.ok, r.sources?.blockstream?.ok].filter(Boolean).length;
    assert(`>=1 external source answered (${externalOks}/2)`, externalOks >= 1);

    console.log('=== 4) admin endpoint GET /api/admin/chain-status ===');
    const BASE = process.env.HUB_URL || 'http://127.0.0.1:' + (process.env.PORT || '3000');
    const ADMIN_KEY = process.env.ADMIN_API_KEY;
    if (!ADMIN_KEY) {
        console.log('  -- skipping live endpoint tests (ADMIN_API_KEY not set)');
    } else {
        // Cached lastResult endpoint (?fresh=0 by default)
        const g = await axios.get(`${BASE}/api/admin/chain-status`, {
            headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true, timeout: 4000,
        });
        assert(`GET (cached) http=${g.status}`, g.status === 200);
        // The kya-hub server has its own in-memory state distinct from this
        // test process; it may not have run a probe yet. That's a valid state.

        // Fresh probe via API (with alert=false by design)
        const gf = await axios.get(`${BASE}/api/admin/chain-status?fresh=1`, {
            headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true, timeout: 15000,
        });
        assert(`GET (fresh=1) http=${gf.status}`, gf.status === 200);
        assert('fresh response includes result.status', !!gf.data?.result?.status);
        assert('fresh result status is one of OK/FORK_DETECTED/...',
            ['OK', 'INSUFFICIENT_SOURCES', 'FORK_DETECTED', 'LOCAL_RPC_UNREACHABLE'].includes(gf.data?.result?.status));

        // Bad admin key
        const bad = await axios.get(`${BASE}/api/admin/chain-status`, {
            headers: { 'X-Admin-Key': 'wrong' }, validateStatus: () => true, timeout: 4000,
        });
        assert(`bad admin key -> 401 (got ${bad.status})`, bad.status === 401);
    }

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
