#!/usr/bin/env node
'use strict';

const devKeys = require('./lib/developer-api-keys');
const devAuth = require('./lib/developer-api-auth');

let passed = 0;
let failed = 0;

function ok(name, cond) {
    if (cond) {
        passed += 1;
        console.log('ok —', name);
    } else {
        failed += 1;
        console.error('FAIL —', name);
    }
}

ok('generate prefix', devAuth.generateApiKey().raw.startsWith('umb_live_'));

const rows = [];
const mockPool = {
    async query(sql, params) {
        if (sql.includes('INSERT INTO developer_api_keys')) {
            const row = {
                id: '00000000-0000-4000-8000-000000000001',
                key_prefix: params[0],
                label: params[2],
                owner_contact: params[3],
                scopes: params[4],
                tier: params[5],
                rate_limit_per_min: params[6],
                created_at: new Date(),
            };
            rows.push({ ...row, key_hash: params[1], revoked_at: null });
            return { rowCount: 1, rows: [row] };
        }
        if (sql.includes('FROM developer_api_keys') && sql.includes('ORDER BY')) {
            return { rowCount: rows.length, rows };
        }
        if (sql.includes('UPDATE developer_api_keys') && sql.includes('revoked_at')) {
            const id = params[0];
            const row = rows.find((r) => r.id === id);
            if (!row || row.revoked_at) return { rowCount: 0, rows: [] };
            row.revoked_at = new Date();
            return { rowCount: 1, rows: [{ id: row.id, key_prefix: row.key_prefix, revoked_at: row.revoked_at }] };
        }
        return { rowCount: 0, rows: [] };
    },
};

(async () => {
    const created = await devKeys.createKey(mockPool, {
        label: 'test-partner',
        tier: 'pro',
        scopes: ['agents:read'],
    });
    ok('create returns api_key', created.api_key && created.api_key.startsWith('umb_live_'));
    ok('pro rate default', created.rate_limit_per_min === devKeys.TIER_DEFAULTS.pro);

    const list = await devKeys.listKeys(mockPool);
    ok('list length', list.length === 1);

    const revoked = await devKeys.revokeKey(mockPool, created.id);
    ok('revoke ok', revoked && revoked.id === created.id);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
