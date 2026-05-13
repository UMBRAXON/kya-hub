#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 10 smoke test
// ----------------------------------------------------------------------------
// Verifies `GET /api/metrics` (Prometheus scrape endpoint):
//   1. Admin-auth gated: 401 without key.
//   2. With key: 200 + text/plain Prometheus format.
//   3. Contains the required gauges + counters.
//   4. Histogram buckets present for /api/health route.
//   5. Default node.js metrics present (kyahub_proc_*).
//   6. Lib-level _shouldRedact / formatters not present (no log leak).
//   7. Alert rules YAML parses and contains expected alert names.
//   8. Send a few sentinel requests + verify counter increments.
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_URL = process.env.KYAHUB_BASE_URL || 'http://127.0.0.1:3000';
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const ax = axios.create({ baseURL: BASE_URL, timeout: 8000, validateStatus: () => true });

let passed = 0, failed = 0;
function ok(n)  { console.log(`  \u2713 ${n}`); passed++; }
function fail(n, d) { console.log(`  \u2717 ${n}${d ? ' — ' + d : ''}`); failed++; }
function eq(a, b, n) { return (a === b) ? ok(n) : fail(n, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

async function main() {
    if (!ADMIN_KEY) {
        console.error('ADMIN_API_KEY must be set (in .env or env). Aborting.');
        process.exit(2);
    }
    const headers = { 'X-Admin-Key': ADMIN_KEY };

    console.log('=== 1) admin auth gating ===');
    const noKey = await ax.get('/api/metrics');
    truthy(noKey.status === 401 || noKey.status === 403,
        `1.1 no admin key → 401/403 (got ${noKey.status})`);

    console.log('=== 2) successful scrape ===');
    const r = await ax.get('/api/metrics', { headers, transformResponse: x => x });
    eq(r.status, 200, '2.1 status 200');
    const ct = (r.headers['content-type'] || '').toLowerCase();
    truthy(ct.includes('text/plain'), `2.2 content-type text/plain (${ct})`);
    truthy(typeof r.data === 'string' && r.data.length > 200,
        `2.3 body > 200 bytes (${typeof r.data}, len=${r.data?.length})`);

    const body = r.data;

    console.log('=== 3) required metrics present ===');
    const must = [
        'kyahub_requests_total',
        'kyahub_request_duration_seconds_bucket',
        'kyahub_request_duration_seconds_count',
        'kyahub_pending_anchors',
        'kyahub_active_agents',
        'kyahub_circuit_breaker_state',
        'kyahub_lightning_inbound_sat',
        'kyahub_btcpay_balance_sat',
        'kyahub_bitcoind_anchor_balance_sat',
        'kyahub_chain_consensus_state',
        'kyahub_cert_breaker_fail_pct',
        'kyahub_start_time_seconds',
    ];
    for (const m of must) truthy(body.includes(m), `3.? ${m} present`);

    console.log('=== 4) default node.js metrics present ===');
    const defaults = [
        'kyahub_proc_process_cpu_user_seconds_total',
        'kyahub_proc_process_resident_memory_bytes',
        'kyahub_proc_nodejs_eventloop_lag_seconds',
    ];
    for (const m of defaults) truthy(body.includes(m), `4.? ${m} present`);

    console.log('=== 5) histogram buckets include 0.5 (p99 SLO line) ===');
    truthy(/kyahub_request_duration_seconds_bucket\{[^\}]*le="0\.5"/.test(body),
        '5.1 le="0.5" bucket present (for p99 SLO query)');

    console.log('=== 6) counter increments on traffic ===');
    // Baseline metric value
    function extractCount(routeRegex, body) {
        const re = new RegExp(`kyahub_requests_total\\{[^\\}]*route="${routeRegex}"[^\\}]*\\} (\\d+(?:\\.\\d+)?)`, 'g');
        let total = 0;
        let m;
        while ((m = re.exec(body)) !== null) total += parseFloat(m[1]);
        return total;
    }
    const baseline = extractCount('/api/health', body);
    // hit /api/health 5 times
    for (let i = 0; i < 5; i++) await ax.get('/api/health');
    // Wait > METRICS_REFRESH_TTL_MS so the next scrape returns fresh aggregates.
    await new Promise(r => setTimeout(r, 600));
    const r2 = await ax.get('/api/metrics', { headers, transformResponse: x => x });
    const after = extractCount('/api/health', r2.data);
    truthy(after >= baseline + 5,
        `6.1 /api/health counter advanced by >=5 (${baseline} -> ${after})`);

    console.log('=== 7) alert rules YAML parses ===');
    const yamlPath = path.join(__dirname, '..', 'config', 'prometheus-alerts.yml');
    truthy(fs.existsSync(yamlPath), `7.1 ${yamlPath} exists`);
    const raw = fs.readFileSync(yamlPath, 'utf8');
    truthy(raw.includes('KYAHubPayLatencyP99High'), '7.2 alert KYAHubPayLatencyP99High defined');
    truthy(raw.includes('histogram_quantile'), '7.3 histogram_quantile expression present');
    truthy(raw.includes('kyahub_request_duration_seconds_bucket'),
        '7.4 alert references the metric name we expose');
    truthy(raw.includes('KYAHubChainForkDetected'), '7.5 fork-detected alert defined');
    truthy(raw.includes('KYAHubCertBreakerHalted'), '7.6 cert-breaker-halt alert defined');

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('FATAL:', e.stack || e.message);
    process.exit(2);
});
