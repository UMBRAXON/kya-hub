#!/usr/bin/env node
'use strict';

const queue = require('./lib/developer-webhook-queue');
const wh = require('./lib/developer-webhooks');

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

ok('allowed events', wh.ALLOWED_EVENTS.has('agent.registered'));

const rows = [];
const mockPool = {
    async query(sql, params) {
        if (sql.includes('INSERT INTO developer_webhook_outbox')) {
            rows.push({
                id: rows.length + 1,
                delivery_id: params[0],
                kya_id: params[1],
                event: params[2],
                target_url: params[3],
                payload: JSON.parse(params[4]),
                attempt_count: 0,
                max_attempts: params[5],
                status: 'pending',
            });
            return { rowCount: 1 };
        }
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
            const pending = rows.filter((r) => r.status === 'pending');
            return { rows: pending.slice(0, params[0] || 50) };
        }
        if (sql.includes("SET status = 'delivered'")) {
            const row = rows.find((r) => r.id === params[0]);
            if (row) row.status = 'delivered';
            return { rowCount: 1 };
        }
        if (sql.includes('GROUP BY status')) {
            const counts = { pending: 0, delivered: 0, dead: 0 };
            for (const r of rows) {
                if (counts[r.status] !== undefined) counts[r.status] += 1;
            }
            return {
                rows: Object.entries(counts).map(([status, c]) => ({ status, c })),
            };
        }
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0 };
        return { rowCount: 0, rows: [] };
    },
    connect: async () => ({
        query: mockPool.query.bind(mockPool),
        release: () => {},
    }),
};

(async () => {
    const id = await queue.enqueue(mockPool, {
        event: 'agent.registered',
        kya_id: 'UMBRA-000001',
        url: 'https://example.com/hook',
        payload: { test: true },
    });
    ok('enqueue id', !!id);
    ok('row inserted', rows.length === 1);

    const counts = await queue.countByStatus(mockPool);
    ok('pending count', counts.pending >= 1);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
