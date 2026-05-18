#!/usr/bin/env node
'use strict';

const lsat = require('./lib/integrator-lsat');
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

const orders = new Map();

const mockPool = {
    async query(sql, params) {
        if (sql.includes('INSERT INTO integrator_lsat_orders')) {
            const access_id = params[0];
            orders.set(access_id, {
                access_id,
                integrator_key_id: params[1],
                amount_sats: params[2],
                status: 'pending',
                token_hash: null,
                scopes: ['agents:read'],
                rate_limit_per_min: params[3],
                invoice_id: null,
                bolt11: null,
            });
            return { rowCount: 1, rows: [] };
        }
        if (sql.includes('UPDATE integrator_lsat_orders') && sql.includes('SET token_hash')) {
            const row = orders.get(params[0]);
            if (row && row.status === 'paid' && !row.token_hash) {
                row.token_hash = params[1];
                row.token_prefix = params[2];
                return {
                    rowCount: 1,
                    rows: [{
                        access_id: row.access_id,
                        scopes: row.scopes,
                        rate_limit_per_min: row.rate_limit_per_min,
                    }],
                };
            }
            return { rowCount: 0, rows: [] };
        }
        if (sql.includes('UPDATE integrator_lsat_orders') && sql.includes("status = 'paid'")) {
            const row = orders.get(params[0]);
            if (row && row.status === 'pending') {
                row.status = 'paid';
                row.paid_at = new Date();
            }
            return { rowCount: row && row.status === 'paid' ? 1 : 0, rows: row ? [{ access_id: params[0] }] : [] };
        }
        if (sql.includes('FROM integrator_lsat_orders') && sql.includes('token_hash = $1')) {
            const digest = params[0];
            for (const row of orders.values()) {
                if (row.token_hash === digest && row.status === 'paid') {
                    return {
                        rowCount: 1,
                        rows: [{
                            access_id: row.access_id,
                            scopes: row.scopes,
                            rate_limit_per_min: row.rate_limit_per_min,
                            expires_at: new Date(Date.now() + 86400000),
                            status: 'paid',
                        }],
                    };
                }
            }
            return { rowCount: 0, rows: [] };
        }
        if (sql.includes('FROM integrator_lsat_orders WHERE access_id')) {
            const row = orders.get(params[0]);
            return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
        }
        if (sql.includes('SELECT access_id, status, token_hash')) {
            const row = orders.get(params[0]);
            return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
        }
        return { rowCount: 0, rows: [] };
    },
};

(async () => {
    ok('profile has endpoints', lsat.profileDoc().endpoints.create_invoice.includes('lsat'));

    const order = await lsat.createInvoiceOrder(mockPool, {});
    ok('access_id prefix', order.access_id.startsWith('lsat-'));

    const paid = await lsat.markPaid(mockPool, order.access_id, 'inv-test');
    ok('mark paid', paid.ok);

    const redeemed = await lsat.redeemToken(mockPool, order.access_id);
    ok('redeem token prefix', redeemed.lsat_token && redeemed.lsat_token.startsWith('umb_lsat_'));

    const ctx = await lsat.resolveToken(mockPool, redeemed.lsat_token);
    ok('resolve lsat', ctx && ctx.kind === 'lsat');

    const dup = await lsat.redeemToken(mockPool, order.access_id);
    ok('redeem once', dup.error === 'ALREADY_REDEEMED');

    ok('generateApiKey still umb_live_', devAuth.generateApiKey().raw.startsWith('umb_live_'));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
