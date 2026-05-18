// ============================================================================
// UMBRAXON KYA-Hub — Developer webhook outbox (enqueue + retry worker)
// ============================================================================

const crypto = require('crypto');
const developerWebhooks = require('./developer-webhooks');

const ENABLED = process.env.DEV_WEBHOOK_QUEUE_ENABLED !== 'false';
const BATCH_SIZE = parseInt(process.env.DEV_WEBHOOK_BATCH_SIZE || '50', 10);
const MAX_ATTEMPTS = parseInt(process.env.DEV_WEBHOOK_MAX_ATTEMPTS || '5', 10);
const POST_TIMEOUT_MS = parseInt(process.env.DEV_WEBHOOK_POST_TIMEOUT_MS || '8000', 10);

/** Backoff seconds after failed attempt (1-based index). */
const BACKOFF_SEC = [60, 300, 1800, 7200, 86400];

function _deliveryId() {
    return `devwh-${crypto.randomBytes(12).toString('hex')}`;
}

function _nextAttemptAfter(attemptCount) {
    const idx = Math.min(Math.max(attemptCount, 1), BACKOFF_SEC.length) - 1;
    const sec = BACKOFF_SEC[idx] || 86400;
    return new Date(Date.now() + sec * 1000);
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ event: string, kya_id: string, url: string, payload?: object }} row
 */
async function enqueue(pool, { event, kya_id, url, payload }) {
    if (!ENABLED || !pool || !event || !kya_id || !url) return null;
    if (!developerWebhooks.ALLOWED_EVENTS.has(event)) return null;
    const delivery_id = _deliveryId();
    const body = {
        typ: 'KYADeveloperWebhook',
        v: 1,
        event,
        kya_id,
        payload: payload || {},
    };
    try {
        await pool.query(
            `INSERT INTO developer_webhook_outbox
                (delivery_id, kya_id, event, target_url, payload, max_attempts)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
            [delivery_id, kya_id, event, url, JSON.stringify(body), MAX_ATTEMPTS]
        );
        return delivery_id;
    } catch (e) {
        if (e.code === '23505') return null;
        throw e;
    }
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ limit?: number }} [opts]
 */
async function processPending(pool, opts = {}) {
    if (!ENABLED || !pool) return { processed: 0, delivered: 0, failed: 0, dead: 0 };
    const limit = Math.min(opts.limit || BATCH_SIZE, 200);
    const client = await pool.connect();
    let processed = 0;
    let delivered = 0;
    let failed = 0;
    let dead = 0;
    try {
        await client.query('BEGIN');
        const sel = await client.query(
            `SELECT id, delivery_id, kya_id, event, target_url, payload, attempt_count, max_attempts
             FROM developer_webhook_outbox
             WHERE status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP
             ORDER BY next_attempt_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [limit]
        );
        for (const row of sel.rows) {
            processed += 1;
            const attempt = row.attempt_count + 1;
            const env = {
                ...row.payload,
                issued_at: new Date().toISOString(),
            };
            const signed = developerWebhooks.signEnvelope(env);
            let httpStatus = null;
            let errMsg = null;
            let ok = false;
            try {
                const r = await developerWebhooks.postJson(row.target_url, signed, POST_TIMEOUT_MS);
                httpStatus = r.status;
                ok = r.ok;
                if (!ok) errMsg = `HTTP ${r.status}`;
            } catch (e) {
                errMsg = e && e.message ? e.message : String(e);
            }
            if (ok) {
                delivered += 1;
                await client.query(
                    `UPDATE developer_webhook_outbox
                     SET status = 'delivered', attempt_count = $2, last_http_status = $3,
                         last_error = NULL, delivered_at = CURRENT_TIMESTAMP
                     WHERE id = $1`,
                    [row.id, attempt, httpStatus]
                );
            } else if (attempt >= row.max_attempts) {
                dead += 1;
                await client.query(
                    `UPDATE developer_webhook_outbox
                     SET status = 'dead', attempt_count = $2, last_http_status = $3, last_error = $4
                     WHERE id = $1`,
                    [row.id, attempt, httpStatus, errMsg]
                );
            } else {
                failed += 1;
                const nextAt = _nextAttemptAfter(attempt);
                await client.query(
                    `UPDATE developer_webhook_outbox
                     SET status = 'pending', attempt_count = $2, last_http_status = $3,
                         last_error = $4, next_attempt_at = $5
                     WHERE id = $1`,
                    [row.id, attempt, httpStatus, errMsg, nextAt]
                );
            }
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
    return { processed, delivered, failed, dead };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ status?: string, kya_id?: string, limit?: number }} [opts]
 */
async function listDeliveries(pool, opts = {}) {
    const limit = Math.min(opts.limit || 100, 500);
    const params = [];
    const where = [];
    if (opts.status) {
        params.push(opts.status);
        where.push(`status = $${params.length}`);
    }
    if (opts.kya_id) {
        params.push(opts.kya_id);
        where.push(`kya_id = $${params.length}`);
    }
    params.push(limit);
    const sql = `
        SELECT delivery_id, kya_id, event, target_url, status, attempt_count, max_attempts,
               next_attempt_at, last_http_status, last_error, created_at, delivered_at
        FROM developer_webhook_outbox
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${params.length}`;
    const r = await pool.query(sql, params);
    return r.rows;
}

/**
 * @param {import('pg').Pool} pool
 */
async function countByStatus(pool) {
    const r = await pool.query(
        `SELECT status, COUNT(*)::int AS c
         FROM developer_webhook_outbox
         GROUP BY status`
    );
    const out = { pending: 0, delivered: 0, failed: 0, dead: 0 };
    for (const row of r.rows) {
        if (Object.prototype.hasOwnProperty.call(out, row.status)) out[row.status] = row.c;
    }
    return out;
}

module.exports = {
    enqueue,
    processPending,
    listDeliveries,
    countByStatus,
    ENABLED,
    BATCH_SIZE,
    MAX_ATTEMPTS,
};
