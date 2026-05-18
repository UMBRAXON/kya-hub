// ============================================================================
// Integrator verify call aggregates (daily, no raw IP storage)
// ============================================================================

const crypto = require('crypto');

function sourceKey({ integratorKeyId, clientIp }) {
    if (integratorKeyId) return `key:${integratorKeyId}`;
    const ip = String(clientIp || 'unknown');
    const h = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
    return `ip:${h}`;
}

/**
 * @param {import('pg').Pool} pool
 */
async function recordStatusRead(pool, { verified, integratorKeyId, clientIp, certChecked }) {
    if (process.env.INTEGRATOR_METRICS_ENABLED === 'false') return;
    const source = sourceKey({ integratorKeyId, clientIp });
    try {
        await pool.query(
            `INSERT INTO integrator_verify_daily (day, source, calls, verified_ok, cert_checks)
             VALUES (CURRENT_DATE, $1, 1, $2, $3)
             ON CONFLICT (day, source) DO UPDATE SET
               calls = integrator_verify_daily.calls + 1,
               verified_ok = integrator_verify_daily.verified_ok + EXCLUDED.verified_ok,
               cert_checks = integrator_verify_daily.cert_checks + EXCLUDED.cert_checks`,
            [source, verified ? 1 : 0, certChecked ? 1 : 0],
        );
    } catch {
        /* metrics must not break API */
    }
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ days?: number }} [opts]
 */
async function getPublicSummary(pool, opts = {}) {
    const days = Math.min(90, Math.max(1, opts.days || 7));
    const r = await pool.query(
        `SELECT day::text AS day,
                SUM(calls)::bigint AS calls,
                SUM(verified_ok)::bigint AS verified_ok,
                SUM(cert_checks)::bigint AS cert_checks,
                COUNT(DISTINCT source) FILTER (WHERE source LIKE 'key:%')::int AS distinct_api_keys
         FROM integrator_verify_daily
         WHERE day >= CURRENT_DATE - $1::int
         GROUP BY day
         ORDER BY day DESC`,
        [days - 1],
    );
    const totals = r.rows.reduce(
        (a, row) => {
            a.calls += Number(row.calls) || 0;
            a.verified_ok += Number(row.verified_ok) || 0;
            a.cert_checks += Number(row.cert_checks) || 0;
            return a;
        },
        { calls: 0, verified_ok: 0, cert_checks: 0 },
    );
    return { days, daily: r.rows, totals };
}

module.exports = {
    recordStatusRead,
    getPublicSummary,
    sourceKey,
};
