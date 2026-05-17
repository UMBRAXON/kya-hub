#!/usr/bin/env node
/**
 * Live smoke test for platform integrator API (requires running hub + DB migrations).
 * Usage: node test-platform-integrator-live.js
 * Env: KYA_HUB_BASE_URL (default http://127.0.0.1:PORT), ADMIN_API_KEY, TEST_KYA_ID
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const http = require('http');
const https = require('https');
const { Pool } = require('pg');

const BASE = (process.env.KYA_HUB_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
const ADMIN = process.env.ADMIN_API_KEY || '';
const TEST_KYA = process.env.TEST_KYA_ID || 'UMBRA-000467';

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
    if (cond) {
        passed += 1;
        console.log('ok —', name);
    } else {
        failed += 1;
        console.error('FAIL —', name, detail || '');
    }
}

function request(method, path, { headers = {}, body } = {}) {
    const url = new URL(path, BASE);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const h = { Accept: 'application/json', ...headers };
    if (payload) h['Content-Type'] = 'application/json';
    return new Promise((resolve, reject) => {
        const req = lib.request(
            url,
            { method, headers: h },
            (res) => {
                let raw = '';
                res.on('data', (c) => { raw += c; });
                res.on('end', () => {
                    let json = null;
                    try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
                    resolve({ status: res.statusCode, json });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function checkDbMigrations() {
    if (!process.env.DB_PASSWORD) {
        ok('db migrations (skip)', true, 'no DB_PASSWORD');
        return;
    }
    const pool = new Pool({
        user: process.env.DB_USER,
        host: process.env.DB_HOST || '127.0.0.1',
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: parseInt(process.env.DB_PORT || '5432', 10),
    });
    try {
        const r = await pool.query(
            `SELECT version FROM schema_migrations
             WHERE version IN ('023_developer_api_keys','024_developer_webhook_outbox','025_integrator_lsat')
             ORDER BY version`
        );
        ok('db migration 023', r.rows.some((x) => x.version === '023_developer_api_keys'));
        ok('db migration 024', r.rows.some((x) => x.version === '024_developer_webhook_outbox'));
        ok('db migration 025', r.rows.some((x) => x.version === '025_integrator_lsat'));
        const t = await pool.query(
            `SELECT to_regclass('public.integrator_lsat_orders') AS lsat`
        );
        ok('table integrator_lsat_orders', !!t.rows[0].lsat);
    } finally {
        await pool.end();
    }
}

async function main() {
    console.log('Base URL:', BASE);
    console.log('Test KYA:', TEST_KYA);

    const health = await request('GET', '/api/health');
    ok('health', health.status === 200);

    const status = await request('GET', `/api/v1/agents/${encodeURIComponent(TEST_KYA)}/status`);
    ok('v1 status 200', status.status === 200);
    ok('v1 status verified', status.json && status.json.verified === true);

    const full = await request('GET', `/api/v1/agents/${encodeURIComponent(TEST_KYA)}`);
    ok('v1 agent 200', full.status === 200);
    ok('v1 agent trust', full.json && full.json.trust);

    const profile = await request('GET', '/api/protocol/integrator-lsat-profile');
    ok('lsat profile 200', profile.status === 200);
    ok('lsat profile id', profile.json && profile.json.profile === 'umbraxon-integrator-lsat-v1');

    if (ADMIN) {
        const list = await request('GET', '/api/admin/developer-keys', {
            headers: { 'X-Admin-Key': ADMIN },
        });
        ok('admin list keys', list.status === 200);

        const created = await request('POST', '/api/admin/developer-keys', {
            headers: { 'X-Admin-Key': ADMIN },
            body: {
                label: `ready-probe-${Date.now()}`,
                tier: 'free',
                scopes: ['agents:read'],
            },
        });
        ok('admin create key', created.status === 201 && created.json && created.json.api_key);
        if (created.json && created.json.api_key) {
            const authed = await request('GET', `/api/v1/agents/${encodeURIComponent(TEST_KYA)}/status`, {
                headers: { Authorization: `Bearer ${created.json.api_key}` },
            });
            ok('api key auth', authed.status === 200);
            if (created.json.id) {
                const rev = await request('POST', `/api/admin/developer-keys/${created.json.id}/revoke`, {
                    headers: { 'X-Admin-Key': ADMIN },
                });
                ok('admin revoke probe key', rev.status === 200);
            }
        }

        const wh = await request('POST', '/api/admin/developer-webhooks/process', {
            headers: { 'X-Admin-Key': ADMIN },
            body: { limit: 5 },
        });
        ok('admin webhook process', wh.status === 200 && wh.json && wh.json.ok === true);

        const lsatInv = await request('POST', '/api/v1/integrator/lsat/invoice', { body: {} });
        ok('lsat invoice', lsatInv.status === 201 && lsatInv.json && lsatInv.json.access_id);
    } else {
        console.log('skip — ADMIN_API_KEY not set (admin + lsat invoice checks)');
    }

    await checkDbMigrations();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
