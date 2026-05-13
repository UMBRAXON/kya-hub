// ============================================================================
// UMBRAXON KYA-Hub — Volumetric AML limits (Strategic Sprint §30 Item 4)
// ============================================================================
// Sliding-window enforcement layer for AML / fraud volumetric thresholds.
//
// Two tables (migration 012):
//   * volumetric_limits   — admin-editable thresholds. Seeded with 3 defaults:
//       - agent:per_day_sats          200000 sats / 86400 s, per_agent
//       - global:per_hour_regs        1000   count / 3600 s, global
//       - global:per_day_anchor_sats  50000  sats / 86400 s, global
//   * volumetric_counters — append-only per-event log; rolling-window queried.
//
// Usage from server.js / workers:
//   const vol = require('./lib/volumetric-limits');
//   const r = await vol.check(pool, 'agent:per_day_sats',
//                              { subject_id: kya_id, amount: 5000, metadata: {...} });
//   if (!r.ok) return res.status(429).set('Retry-After', r.retry_after_sec)
//                       .json({ error: 'VOLUMETRIC_LIMIT_EXCEEDED', limit_key: r.limit_key,
//                               threshold: r.threshold, current: r.current, window_seconds: r.window_seconds });
//   // ELSE -> the event was already recorded; proceed.
//
// `check()` is intentionally an INSERT-then-SUM in a single short transaction.
// We record the event first (so an attacker cannot bypass by getting their
// event in before the check completes from a parallel goroutine), then sum
// the rolling window and if EXCESS we BOTH leave the event in place (for
// forensic completeness) AND return ok=false. If the caller wants to abort
// without leaving an event, use `peek()` instead — but for our threat model
// (rate-limit-then-deny) leaving the audit row is the safer default.
// ============================================================================
const logger = require('./logger');
const notifications = require('./notifications');

const CACHE_TTL_MS = parseInt(process.env.VOLUMETRIC_LIMITS_CACHE_TTL_MS || '60000', 10);
let cachedLimits = null;
let cachedAt = 0;
let lastBreachAlertedAt = new Map(); // limit_key -> last alert ms

/**
 * Load limits from DB, with 60s cache.
 * Returns `{ ok: false }` on DB error (FAIL_OPEN behaviour — we never block
 * traffic just because the limits table is unreachable; loud-log instead).
 */
async function _loadLimits(pool) {
    const now = Date.now();
    if (cachedLimits && (now - cachedAt) < CACHE_TTL_MS) return cachedLimits;
    try {
        const r = await pool.query(`
            SELECT id, limit_key, threshold_value::bigint AS threshold_value,
                   window_seconds, enabled, unit, scope, description,
                   change_reason, last_changed_by, last_changed_at
            FROM volumetric_limits
            ORDER BY limit_key
        `);
        cachedLimits = r.rows;
        cachedAt = now;
        return cachedLimits;
    } catch (e) {
        logger.error({ err: e.message, event: 'volumetric_limits_load_fail' }, 'volumetric_limits load failed — fail-open');
        return cachedLimits || [];
    }
}

function _invalidateCache() {
    cachedLimits = null;
    cachedAt = 0;
}

/** Find a single limit row by key (cached). */
async function getLimit(pool, limit_key) {
    const all = await _loadLimits(pool);
    return all.find(l => l.limit_key === limit_key) || null;
}

async function listLimits(pool) {
    return _loadLimits(pool);
}

/**
 * Insert a counter row and check whether the rolling-window sum exceeds the
 * threshold.
 *
 * @param {Pool} pool
 * @param {string} limit_key
 * @param {object} opts
 *   - subject_id  (string|null) — e.g. kya_id for per_agent scope; null for global
 *   - amount      (number)      — magnitude in unit (sats or count); default 1
 *   - metadata    (object)      — forensic context, JSON-stringifiable
 * @returns {{ok, limit_key, threshold, current, window_seconds, retry_after_sec, scope, unit}}
 */
async function check(pool, limit_key, opts = {}) {
    const limit = await getLimit(pool, limit_key);
    if (!limit) {
        // unknown limit key — log and fail-open (don't block traffic)
        logger.warn({ event: 'volumetric_unknown_key', limit_key }, 'volumetric.check() called with unknown limit_key');
        return { ok: true, limit_key, unknown: true };
    }
    if (!limit.enabled) {
        return { ok: true, limit_key, disabled: true };
    }

    const subject = opts.subject_id || null;
    const amount = Number.isFinite(opts.amount) ? Math.max(0, Math.floor(opts.amount)) : 1;
    const meta = opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : {};

    try {
        // INSERT then aggregate, in a single transaction.
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO volumetric_counters (limit_key, subject_id, amount, metadata)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [limit_key, subject, amount, JSON.stringify(meta)]
            );
            // Rolling-window sum (or count if amount column is always 1)
            const aggCol = limit.unit === 'count' ? 'COUNT(*)::bigint' : 'COALESCE(SUM(amount), 0)::bigint';
            const subjectCondition = limit.scope === 'global'
                ? ''
                : ' AND subject_id = $3';
            const args = [limit_key, limit.window_seconds];
            if (limit.scope !== 'global') args.push(subject);
            const q = `
                SELECT ${aggCol} AS current
                FROM volumetric_counters
                WHERE limit_key = $1
                  AND occurred_at > NOW() - ($2::int * INTERVAL '1 second')
                  ${subjectCondition}
            `;
            const agg = await client.query(q, args);
            await client.query('COMMIT');
            const current = Number(agg.rows[0].current || 0);
            const threshold = Number(limit.threshold_value);
            const ok = current <= threshold;
            const result = {
                ok,
                limit_key,
                threshold,
                current,
                window_seconds: limit.window_seconds,
                scope: limit.scope,
                unit: limit.unit,
                subject_id: subject,
                retry_after_sec: ok ? 0 : limit.window_seconds,
            };
            if (!ok) {
                // Telegram alert (deduped — at most once per 5 min per limit_key+subject)
                _maybeAlertBreach({ limit, current, subject, amount, metadata: meta });
                logger.warn({
                    event: 'volumetric_limit_exceeded',
                    limit_key, threshold, current, scope: limit.scope, subject,
                    amount, metadata: meta,
                }, 'volumetric AML limit exceeded — request will be denied');
            }
            return result;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    } catch (e) {
        // DB error: fail-open + loud-log (we don't want a misconfigured pool to
        // accidentally deny all traffic).
        logger.error({ err: e.message, limit_key, event: 'volumetric_check_db_fail' }, 'volumetric.check() DB error — fail-open');
        return { ok: true, limit_key, db_error: e.message };
    }
}

/**
 * Peek at current window without inserting an event. Useful for admin dashboards.
 */
async function peek(pool, limit_key, { subject_id } = {}) {
    const limit = await getLimit(pool, limit_key);
    if (!limit) return null;
    const aggCol = limit.unit === 'count' ? 'COUNT(*)::bigint' : 'COALESCE(SUM(amount), 0)::bigint';
    const subjectCondition = limit.scope === 'global' ? '' : ' AND subject_id = $3';
    const args = [limit_key, limit.window_seconds];
    if (limit.scope !== 'global') args.push(subject_id || null);
    const r = await pool.query(`
        SELECT ${aggCol} AS current
        FROM volumetric_counters
        WHERE limit_key = $1
          AND occurred_at > NOW() - ($2::int * INTERVAL '1 second')
          ${subjectCondition}
    `, args);
    const current = Number(r.rows[0]?.current || 0);
    const threshold = Number(limit.threshold_value);
    return {
        limit_key,
        threshold,
        current,
        utilization_pct: threshold > 0 ? Number(((current / threshold) * 100).toFixed(2)) : 0,
        window_seconds: limit.window_seconds,
        scope: limit.scope,
        unit: limit.unit,
        enabled: limit.enabled,
    };
}

/**
 * Admin: upsert a limit row.
 * NOTE: only fields we explicitly allow can be updated to keep the audit
 * straightforward.
 */
async function upsertLimit(pool, {
    limit_key, threshold_value, window_seconds, enabled, unit, scope,
    description, change_reason, admin_user,
}) {
    if (!limit_key || !/^[a-z0-9._:-]{3,96}$/.test(limit_key)) {
        return { error: 'INVALID_LIMIT_KEY', message: 'limit_key must match [a-z0-9._:-]{3,96}' };
    }
    if (threshold_value != null && (!Number.isFinite(threshold_value) || threshold_value < 0)) {
        return { error: 'INVALID_THRESHOLD' };
    }
    if (window_seconds != null && (!Number.isFinite(window_seconds) || window_seconds < 1 || window_seconds > 31_536_000)) {
        return { error: 'INVALID_WINDOW_SECONDS' };
    }
    if (scope && !['global', 'per_agent', 'per_ip'].includes(scope)) return { error: 'INVALID_SCOPE' };
    if (unit && !['sats', 'count'].includes(unit)) return { error: 'INVALID_UNIT' };

    // PostgreSQL evaluates NOT NULL constraints during the INSERT phase even
    // when ON CONFLICT DO UPDATE is specified, so we must merge existing-row
    // values into the INSERT VALUES manually.
    const existing = await pool.query(
        `SELECT threshold_value, window_seconds, enabled, unit, scope, description
         FROM volumetric_limits WHERE limit_key = $1`,
        [limit_key]
    );
    const cur = existing.rows[0] || null;

    if (!cur) {
        // Pure INSERT — all NOT NULL columns must be supplied or take their
        // schema default. threshold_value, window_seconds, unit, scope are
        // mandatory on first creation.
        if (threshold_value == null || window_seconds == null) {
            return { error: 'MISSING_FIELDS', message: 'threshold_value and window_seconds are required when creating a new limit_key' };
        }
    }

    const finalThreshold = threshold_value != null ? Math.floor(threshold_value) : Number(cur.threshold_value);
    const finalWindow    = window_seconds  != null ? Math.floor(window_seconds)  : cur.window_seconds;
    const finalEnabled   = enabled != null ? !!enabled : (cur ? cur.enabled : true);
    const finalUnit      = unit  || (cur ? cur.unit  : 'sats');
    const finalScope     = scope || (cur ? cur.scope : 'global');
    const finalDesc      = description != null ? description : (cur ? cur.description : null);

    const r = await pool.query(`
        INSERT INTO volumetric_limits (
            limit_key, threshold_value, window_seconds, enabled, unit, scope,
            description, change_reason, last_changed_by, last_changed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (limit_key) DO UPDATE SET
            threshold_value = EXCLUDED.threshold_value,
            window_seconds  = EXCLUDED.window_seconds,
            enabled         = EXCLUDED.enabled,
            unit            = EXCLUDED.unit,
            scope           = EXCLUDED.scope,
            description     = EXCLUDED.description,
            change_reason   = COALESCE(EXCLUDED.change_reason, volumetric_limits.change_reason),
            last_changed_by = COALESCE(EXCLUDED.last_changed_by, volumetric_limits.last_changed_by),
            last_changed_at = NOW()
        RETURNING *
    `, [
        limit_key,
        finalThreshold,
        finalWindow,
        finalEnabled,
        finalUnit, finalScope,
        finalDesc,
        (change_reason || '').slice(0, 1024) || null,
        (admin_user || 'admin').slice(0, 64),
    ]);
    _invalidateCache();
    return { ok: true, limit: r.rows[0] };
}

/** Prune very old counter rows (rolling window + N days margin). */
async function prune(pool, { extra_margin_days = 7, dry_run = false } = {}) {
    // Keep at minimum the longest configured window + margin
    const limits = await _loadLimits(pool);
    const longestWindowSec = limits.reduce((acc, l) => Math.max(acc, l.window_seconds || 0), 86400);
    const keepSec = longestWindowSec + extra_margin_days * 86400;
    if (dry_run) {
        const r = await pool.query(`
            SELECT COUNT(*)::bigint AS rows_to_delete
            FROM volumetric_counters
            WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 second')
        `, [keepSec]);
        return { dry_run: true, rows_to_delete: Number(r.rows[0].rows_to_delete) };
    }
    const r = await pool.query(`
        WITH del AS (
            DELETE FROM volumetric_counters
            WHERE occurred_at < NOW() - ($1::int * INTERVAL '1 second')
            RETURNING 1
        )
        SELECT COUNT(*)::bigint AS deleted FROM del
    `, [keepSec]);
    return { deleted: Number(r.rows[0].deleted), kept_seconds: keepSec };
}

function _maybeAlertBreach({ limit, current, subject, amount, metadata }) {
    const dedupeKey = `${limit.limit_key}:${subject || 'global'}`;
    const now = Date.now();
    const last = lastBreachAlertedAt.get(dedupeKey) || 0;
    if ((now - last) < 5 * 60 * 1000) return; // 5 min dedupe
    lastBreachAlertedAt.set(dedupeKey, now);
    notifications.notify({
        category: 'warning',
        title: 'AML volumetric limit BREACH',
        body: (
            `limit_key: ${limit.limit_key}\n` +
            `scope: ${limit.scope}\n` +
            `subject: ${subject || '(global)'}\n` +
            `threshold: ${limit.threshold_value} ${limit.unit}\n` +
            `current:   ${current} ${limit.unit}\n` +
            `window:    ${limit.window_seconds}s\n` +
            `this event amount: ${amount}\n` +
            `metadata: ${JSON.stringify(metadata).slice(0, 300)}\n` +
            `action: HTTP 429 returned to caller; investigate if persistent.`
        ),
        dedupe_key: `aml_breach_${dedupeKey}`,
    }).catch(() => {});
}

module.exports = {
    check,
    peek,
    listLimits,
    getLimit,
    upsertLimit,
    prune,
    _invalidateCache,
};
