#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 4 smoke test
// ----------------------------------------------------------------------------
// Inserts events into volumetric_counters via the lib + via API, asserts
// rolling-window enforcement, exercises admin endpoints. Cleans up after.
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });
process.env.NOTIF_ENABLED = 'false';

const axios = require('axios');
const { Pool } = require('pg');
const vol = require('../lib/volumetric-limits');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
    const pool = new Pool({
        host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    const TEST_KEY = 'test:item4:per_agent_sats';
    const TEST_KEY_GLOBAL = 'test:item4:global_count';
    const TEST_SUBJECT = 'UMBRA-TEST01';

    // 0) clean slate (idempotent)
    await pool.query(`DELETE FROM volumetric_counters WHERE limit_key LIKE 'test:item4:%'`);
    await pool.query(`DELETE FROM volumetric_limits   WHERE limit_key LIKE 'test:item4:%'`);
    vol._invalidateCache();

    console.log('=== 1) seed two test limits ===');
    const r1 = await vol.upsertLimit(pool, {
        limit_key: TEST_KEY, threshold_value: 1000, window_seconds: 3600,
        unit: 'sats', scope: 'per_agent',
        description: 'unit test per-agent cap', change_reason: 'item4 smoke test',
        admin_user: 'item4-test',
    });
    assert('seeded per_agent limit', r1.ok === true);
    const r2 = await vol.upsertLimit(pool, {
        limit_key: TEST_KEY_GLOBAL, threshold_value: 3, window_seconds: 3600,
        unit: 'count', scope: 'global',
        description: 'unit test global count cap', change_reason: 'item4 smoke test',
        admin_user: 'item4-test',
    });
    assert('seeded global count limit', r2.ok === true);

    console.log('=== 2) peek shows zero usage ===');
    const peek0 = await vol.peek(pool, TEST_KEY, { subject_id: TEST_SUBJECT });
    assert('peek threshold=1000', peek0 && peek0.threshold === 1000);
    assert('peek current=0', peek0 && peek0.current === 0);
    const peek0g = await vol.peek(pool, TEST_KEY_GLOBAL);
    assert('global peek current=0', peek0g && peek0g.current === 0);

    console.log('=== 3) check() under threshold ===');
    const c1 = await vol.check(pool, TEST_KEY, { subject_id: TEST_SUBJECT, amount: 600 });
    assert('first check ok=true (600 of 1000)', c1.ok === true);
    assert('current = 600', c1.current === 600);
    const c2 = await vol.check(pool, TEST_KEY, { subject_id: TEST_SUBJECT, amount: 300 });
    assert('second check still ok (900 of 1000)', c2.ok === true && c2.current === 900);

    console.log('=== 4) check() at-and-above threshold ===');
    const c3 = await vol.check(pool, TEST_KEY, { subject_id: TEST_SUBJECT, amount: 100 });
    // 600+300+100 = 1000 (== threshold). Threshold is "current <= threshold" so this should be ok.
    assert('exactly-at-threshold still ok', c3.ok === true && c3.current === 1000);
    const c4 = await vol.check(pool, TEST_KEY, { subject_id: TEST_SUBJECT, amount: 1 });
    assert('over-by-1 is denied', c4.ok === false);
    assert('retry_after_sec = window_seconds', c4.retry_after_sec === 3600);
    assert('limit_key echoed', c4.limit_key === TEST_KEY);

    console.log('=== 5) per_agent scope isolates subjects ===');
    const otherSubject = 'UMBRA-TEST02';
    const c5 = await vol.check(pool, TEST_KEY, { subject_id: otherSubject, amount: 50 });
    assert('different subject starts fresh', c5.ok === true && c5.current === 50);

    console.log('=== 6) global count limit ===');
    const g1 = await vol.check(pool, TEST_KEY_GLOBAL, { amount: 1 });
    const g2 = await vol.check(pool, TEST_KEY_GLOBAL, { amount: 1 });
    const g3 = await vol.check(pool, TEST_KEY_GLOBAL, { amount: 1 });
    assert('global count under threshold ok', g1.ok && g2.ok && g3.ok);
    const g4 = await vol.check(pool, TEST_KEY_GLOBAL, { amount: 1 });
    assert('global count over threshold denied', g4.ok === false);

    console.log('=== 7) disabled limit fails-open ===');
    await vol.upsertLimit(pool, {
        limit_key: TEST_KEY_GLOBAL, enabled: false,
        change_reason: 'unit test toggle off', admin_user: 'item4-test',
    });
    vol._invalidateCache();
    const g5 = await vol.check(pool, TEST_KEY_GLOBAL, { amount: 1 });
    assert('disabled limit -> ok=true even when "over"', g5.ok === true && g5.disabled === true);

    console.log('=== 8) unknown key fails-open ===');
    const u = await vol.check(pool, 'no:such:limit', { amount: 999 });
    assert('unknown key -> ok=true', u.ok === true && u.unknown === true);

    console.log('=== 9) admin endpoints (live server) ===');
    const BASE = process.env.HUB_URL || 'http://127.0.0.1:' + (process.env.PORT || '3000');
    const ADMIN_KEY = process.env.ADMIN_API_KEY;
    if (!ADMIN_KEY) {
        console.log('  -- skipping live endpoint tests (ADMIN_API_KEY not set)');
    } else {
        try {
            const list = await axios.get(`${BASE}/api/admin/volumetric-limits`, {
                headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true,
            });
            assert(`GET /list http=${list.status}`, list.status === 200);
            const seeded = (list.data?.limits || []).find(l => l.limit_key === TEST_KEY);
            assert('test limit visible in admin list', !!seeded);

            const peek = await axios.get(`${BASE}/api/admin/volumetric-limits/${encodeURIComponent(TEST_KEY)}?subject_id=${encodeURIComponent(TEST_SUBJECT)}`, {
                headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true,
            });
            assert(`GET /peek http=${peek.status}`, peek.status === 200);
            assert('peek shows current > 0 for our subject', peek.data?.peek?.current > 0);

            const upsert = await axios.post(`${BASE}/api/admin/volumetric-limits`, {
                limit_key: TEST_KEY, threshold_value: 2000,
                change_reason: 'item4 raise threshold via admin API',
            }, { headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true });
            assert(`POST /upsert http=${upsert.status}`, upsert.status === 200);
            assert('upsert returned ok', upsert.data?.ok === true);
            assert('upsert raised threshold', Number(upsert.data?.limit?.threshold_value) === 2000);

            const pruneDry = await axios.post(`${BASE}/api/admin/volumetric-limits/prune?dry_run=1`, {}, {
                headers: { 'X-Admin-Key': ADMIN_KEY }, validateStatus: () => true,
            });
            assert(`POST /prune dry-run http=${pruneDry.status}`, pruneDry.status === 200);
            assert('prune dry_run flag echoed', pruneDry.data?.dry_run === true);

            // 401 on bad key
            const bad = await axios.get(`${BASE}/api/admin/volumetric-limits`, {
                headers: { 'X-Admin-Key': 'wrong' }, validateStatus: () => true,
            });
            assert(`bad admin key -> 401 (got ${bad.status})`, bad.status === 401);
        } catch (e) {
            console.log('  -- live endpoint check FAILED: ' + e.message);
            failed++;
        }
    }

    // cleanup
    await pool.query(`DELETE FROM volumetric_counters WHERE limit_key LIKE 'test:item4:%'`);
    await pool.query(`DELETE FROM volumetric_limits   WHERE limit_key LIKE 'test:item4:%'`);
    await pool.end();

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
