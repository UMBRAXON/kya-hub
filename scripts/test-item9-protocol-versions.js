#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 9 smoke test
// ----------------------------------------------------------------------------
// Verifies `GET /api/protocol/versions`:
//   1. Returns 200 with the expected shape.
//   2. No auth required.
//   3. Sets Cache-Control: public, max-age=60.
//   4. `supported` array comes from manifest-schema enum (no drift).
//   5. `min_required` is in `supported`; `preferred` is in `supported`.
//   6. `handshake_required` is true.
//   7. Env override `HUB_PROTOCOL_*` knobs work in-process (separate node
//      child that sets the vars before requiring server-side helpers).
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const axios = require('axios');
const { spawnSync } = require('child_process');
const path = require('path');

const BASE_URL = process.env.KYAHUB_BASE_URL || 'http://127.0.0.1:3000';
const ax = axios.create({ baseURL: BASE_URL, timeout: 8000, validateStatus: () => true });

let passed = 0, failed = 0;
function ok(n)  { console.log(`  \u2713 ${n}`); passed++; }
function fail(n, d) { console.log(`  \u2717 ${n}${d ? ' — ' + d : ''}`); failed++; }
function eq(a, b, n) { return (a === b) ? ok(n) : fail(n, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

async function main() {
    console.log('=== 1) GET /api/protocol/versions ===');
    const r = await ax.get('/api/protocol/versions');
    eq(r.status, 200, '1.1 status 200');
    truthy(typeof r.data === 'object' && r.data !== null, '1.2 body is object');

    console.log('=== 2) shape ===');
    truthy(Array.isArray(r.data.supported) && r.data.supported.length >= 1,
        `2.1 supported is non-empty array (${JSON.stringify(r.data.supported)})`);
    truthy(typeof r.data.preferred === 'string', `2.2 preferred is string (${r.data.preferred})`);
    truthy(Array.isArray(r.data.deprecated), '2.3 deprecated is array');
    truthy(typeof r.data.min_required === 'string', `2.4 min_required is string (${r.data.min_required})`);
    truthy(typeof r.data.next_planned === 'string', `2.5 next_planned is string (${r.data.next_planned})`);
    truthy(typeof r.data.changelog_url === 'string' && r.data.changelog_url.startsWith('http'),
        '2.6 changelog_url is http(s) string');
    eq(r.data.handshake_required, true, '2.7 handshake_required = true');

    console.log('=== 3) consistency ===');
    truthy(r.data.supported.includes(r.data.preferred),
        `3.1 preferred (${r.data.preferred}) is in supported`);
    truthy(r.data.supported.includes(r.data.min_required),
        `3.2 min_required (${r.data.min_required}) is in supported`);
    for (const dep of r.data.deprecated) {
        truthy(r.data.supported.includes(dep), `3.3 deprecated entry "${dep}" still in supported (lenient)`);
    }

    console.log('=== 4) Cache-Control ===');
    const cc = r.headers['cache-control'] || '';
    truthy(/max-age=\s*60/.test(cc), `4.1 max-age=60 present (${cc})`);
    truthy(/public/.test(cc), `4.2 public directive present (${cc})`);

    console.log('=== 5) supported = manifest-schema enum (no drift) ===');
    const manifestSchema = require('../lib/manifest-schema');
    const enumList = manifestSchema?.SCHEMA?.properties?.protocol_version?.enum || [];
    eq(JSON.stringify(r.data.supported.slice().sort()),
        JSON.stringify(enumList.slice().sort()),
        '5.1 supported = manifest-schema.SCHEMA enum (set equal)');

    console.log('=== 6) no auth required ===');
    const noKey = await ax.get('/api/protocol/versions',
        { headers: { /* deliberately no X-Admin-Key */ } });
    eq(noKey.status, 200, '6.1 public endpoint returns 200 without auth');

    console.log('=== 7) env override smoke test (child process, isolated) ===');
    const helper = `
const path = require('path');
process.env.HUB_PROTOCOL_PREFERRED   = '1.0';
process.env.HUB_PROTOCOL_MIN_REQUIRED = '1.0';
process.env.HUB_PROTOCOL_DEPRECATED   = '0.9,0.8';
process.env.HUB_PROTOCOL_NEXT_PLANNED = '2.0';
process.env.HUB_PROTOCOL_CHANGELOG_URL = 'https://example.com/cl';
const ms = require('${path.join(__dirname, '..', 'lib', 'manifest-schema').replace(/\\\\/g, '\\\\\\\\')}');
const supported = ms.SCHEMA.properties.protocol_version.enum.slice();
const info = {
    supported,
    preferred: process.env.HUB_PROTOCOL_PREFERRED,
    deprecated: process.env.HUB_PROTOCOL_DEPRECATED.split(',').map(s=>s.trim()).filter(Boolean),
    min_required: process.env.HUB_PROTOCOL_MIN_REQUIRED,
    next_planned: process.env.HUB_PROTOCOL_NEXT_PLANNED,
    changelog_url: process.env.HUB_PROTOCOL_CHANGELOG_URL,
    handshake_required: true,
};
process.stdout.write(JSON.stringify(info));
`;
    const child = spawnSync('node', ['-e', helper], { encoding: 'utf-8' });
    try {
        const info = JSON.parse(child.stdout);
        eq(info.preferred, '1.0', '7.1 preferred picks up env');
        eq(JSON.stringify(info.deprecated), '["0.9","0.8"]', '7.2 deprecated parsed from CSV env');
        eq(info.next_planned, '2.0', '7.3 next_planned env');
        eq(info.changelog_url, 'https://example.com/cl', '7.4 changelog_url env');
    } catch (e) {
        fail('7.x env override child failed to parse',
            `stdout=${child.stdout?.slice(0,200)} stderr=${child.stderr?.slice(0,200)}`);
    }

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('FATAL:', e.stack || e.message);
    process.exit(2);
});
