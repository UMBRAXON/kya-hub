// ============================================================================
// Shared DB snapshot for Prometheus gauges (`fetchOpsSummarySnapshot`) and
// full ops dashboard JSON (`fetchOpsSummaryFull`).
// ============================================================================
'use strict';

/**
 * Minimal snapshot — used by lib/metrics.js refresh (keep query count low).
 * @param {import('pg').Pool} pool
 */
async function fetchOpsSummarySnapshot(pool) {
    const generated_at = new Date().toISOString();

    const [intentsR, webhookR, rej24R, rejTopR] = await Promise.all([
        pool.query(
            `SELECT COALESCE(NULLIF(TRIM(status), ''), 'UNKNOWN') AS status, COUNT(*)::int AS c
             FROM registration_intents GROUP BY 1`
        ),
        pool.query(
            `SELECT COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source, COUNT(*)::int AS c
             FROM webhook_deliveries WHERE processed = FALSE GROUP BY 1`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT reason, COUNT(*)::int AS c
             FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '24 hours'
             GROUP BY reason ORDER BY c DESC LIMIT 8`
        ),
    ]);

    return {
        generated_at,
        registration_intents: intentsR.rows.map((row) => ({
            status: String(row.status),
            count: row.c,
        })),
        webhook_unprocessed: webhookR.rows.map((row) => ({
            source: String(row.source),
            count: row.c,
        })),
        rejected_requests_24h: rej24R.rows[0]?.c ?? 0,
        rejected_top_reasons_24h: rejTopR.rows.map((row) => ({
            reason: String(row.reason),
            count: row.c,
        })),
    };
}

/**
 * Full dashboard payload — one round-trip of parallel reads (admin-only).
 * @param {import('pg').Pool} pool
 */
async function fetchOpsSummaryFull(pool) {
    const t0 = Date.now();
    const generated_at = new Date().toISOString();

    const [
        intentsR,
        webhookR,
        rej24R,
        rejTopR,
        activeR,
        everR,
        byTierR,
        byZoneR,
        dormantR,
        hb1hR,
        rejPathR,
        rejHttpR,
        rejIpR,
        rej7R,
        rejTop7R,
        authC24R,
        authOpenR,
        powC24R,
        powSolved24R,
        powOpenR,
        hbLog24R,
        wh24R,
        paR,
        sig24R,
        act24R,
        actTypesR,
    ] = await Promise.all([
        pool.query(
            `SELECT COALESCE(NULLIF(TRIM(status), ''), 'UNKNOWN') AS status, COUNT(*)::int AS c
             FROM registration_intents GROUP BY 1`
        ),
        pool.query(
            `SELECT COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source, COUNT(*)::int AS c
             FROM webhook_deliveries WHERE processed = FALSE GROUP BY 1`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT reason, COUNT(*)::int AS c
             FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '24 hours'
             GROUP BY reason ORDER BY c DESC LIMIT 8`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM agents WHERE is_active = TRUE AND retired_at IS NULL`
        ),
        pool.query(`SELECT COUNT(*)::int AS c FROM agents`),
        pool.query(
            `SELECT COALESCE(NULLIF(TRIM(tier), ''), 'UNKNOWN') AS tier, COUNT(*)::int AS c
             FROM agents WHERE is_active = TRUE AND retired_at IS NULL GROUP BY 1`
        ),
        pool.query(
            `SELECT CASE
                WHEN reputation_score >= 70 THEN 'GREEN'
                WHEN reputation_score >= 40 THEN 'YELLOW'
                ELSE 'RED'
             END AS zone, COUNT(*)::int AS c
             FROM agents WHERE is_active = TRUE AND retired_at IS NULL
             GROUP BY 1`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM agents
             WHERE is_active = TRUE AND retired_at IS NULL AND is_dormant = TRUE`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM agents
             WHERE is_active = TRUE AND retired_at IS NULL
               AND last_heartbeat_at IS NOT NULL
               AND last_heartbeat_at > NOW() - INTERVAL '1 hour'`
        ),
        pool.query(
            `SELECT path, COUNT(*)::int AS c FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '24 hours'
             GROUP BY path ORDER BY c DESC LIMIT 20`
        ),
        pool.query(
            `SELECT http_status, COUNT(*)::int AS c FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '24 hours'
             GROUP BY http_status ORDER BY http_status`
        ),
        pool.query(
            `SELECT COUNT(DISTINCT client_ip)::int AS c FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '7 days'`
        ),
        pool.query(
            `SELECT reason, COUNT(*)::int AS c FROM rejected_requests
             WHERE occurred_at > NOW() - INTERVAL '7 days'
             GROUP BY reason ORDER BY c DESC LIMIT 12`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM auth_challenges
             WHERE created_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM auth_challenges
             WHERE used_at IS NULL AND expires_at > NOW()`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM pow_challenges
             WHERE created_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM pow_challenges
             WHERE solved_at IS NOT NULL AND solved_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM pow_challenges
             WHERE solved_at IS NULL AND expires_at > NOW()`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM heartbeats_log
             WHERE received_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source, COUNT(*)::int AS c
             FROM webhook_deliveries
             WHERE received_at > NOW() - INTERVAL '24 hours'
             GROUP BY 1`
        ),
        pool.query(
            `SELECT COALESCE(NULLIF(TRIM(status), ''), 'UNKNOWN') AS status, COUNT(*)::int AS c
             FROM pending_anchors GROUP BY 1`
        ),
        pool.query(
            `SELECT failure_type, COUNT(*)::int AS c FROM signature_failures
             WHERE occurred_at > NOW() - INTERVAL '24 hours'
             GROUP BY failure_type ORDER BY c DESC`
        ),
        pool.query(
            `SELECT COUNT(*)::int AS c FROM action_log
             WHERE received_at > NOW() - INTERVAL '24 hours'`
        ),
        pool.query(
            `SELECT action_type, COUNT(*)::int AS c FROM action_log
             WHERE received_at > NOW() - INTERVAL '24 hours'
             GROUP BY action_type ORDER BY c DESC LIMIT 12`
        ),
    ]);

    const extended = {
        agents_by_tier_active: byTierR.rows.map((row) => ({ tier: String(row.tier), count: row.c })),
        agents_by_reputation_zone: byZoneR.rows.map((row) => ({ zone: String(row.zone), count: row.c })),
        agents_dormant_active: dormantR.rows[0]?.c ?? 0,
        agents_heartbeat_last_1h: hb1hR.rows[0]?.c ?? 0,
        rejected_paths_24h: rejPathR.rows.map((row) => ({ path: String(row.path), count: row.c })),
        rejected_http_status_24h: rejHttpR.rows.map((row) => ({
            http_status: row.http_status,
            count: row.c,
        })),
        rejected_unique_ips_24h: rejIpR.rows[0]?.c ?? 0,
        rejected_total_7d: rej7R.rows[0]?.c ?? 0,
        rejected_top_reasons_7d: rejTop7R.rows.map((row) => ({
            reason: String(row.reason),
            count: row.c,
        })),
        auth_challenges_created_24h: authC24R.rows[0]?.c ?? 0,
        auth_challenges_unused_valid: authOpenR.rows[0]?.c ?? 0,
        pow_challenges_created_24h: powC24R.rows[0]?.c ?? 0,
        pow_challenges_solved_24h: powSolved24R.rows[0]?.c ?? 0,
        pow_challenges_open_unsolved: powOpenR.rows[0]?.c ?? 0,
        heartbeats_log_rows_24h: hbLog24R.rows[0]?.c ?? 0,
        webhook_deliveries_received_24h_by_source: wh24R.rows.map((row) => ({
            source: String(row.source),
            count: row.c,
        })),
        pending_anchors_by_status: paR.rows.map((row) => ({
            status: String(row.status),
            count: row.c,
        })),
        signature_failures_24h_by_type: sig24R.rows.map((row) => ({
            failure_type: String(row.failure_type),
            count: row.c,
        })),
        action_log_rows_24h: act24R.rows[0]?.c ?? 0,
        action_log_top_types_24h: actTypesR.rows.map((row) => ({
            action_type: String(row.action_type),
            count: row.c,
        })),
    };

    return {
        generated_at,
        registration_intents: intentsR.rows.map((row) => ({
            status: String(row.status),
            count: row.c,
        })),
        webhook_unprocessed: webhookR.rows.map((row) => ({
            source: String(row.source),
            count: row.c,
        })),
        rejected_requests_24h: rej24R.rows[0]?.c ?? 0,
        rejected_top_reasons_24h: rejTopR.rows.map((row) => ({
            reason: String(row.reason),
            count: row.c,
        })),
        agents_active: activeR.rows[0]?.c ?? 0,
        agents_ever_registered: everR.rows[0]?.c ?? 0,
        extended,
        legend: {
            agents_active:
                'Počet riadkov v tabuľke agents kde is_active = true a retired_at je NULL — t.j. registrovaní KYA agenti v stave „aktívny“ (nie počet HTTP spojení ani ľudí v admin UI).',
            agents_ever_registered:
                'Celkový počet riadkov v agents (vrátane retired / neaktívnych).',
            agents_heartbeat_last_1h:
                'Aktívni agenti, ktorí poslali heartbeat v poslednej hodine (last_heartbeat_at).',
            heartbeats_log_rows_24h:
                'Počet záznamov v heartbeats_log za 24 h (replay okno; každý úspešný heartbeat môže byť jeden riadok).',
            rejected_unique_ips_24h:
                'Rôzne IP v rejected_requests za 24 h (orientačný „šum“ klientov, nie jednoznačne boti).',
        },
        _meta: { query_ms: Date.now() - t0 },
    };
}

module.exports = { fetchOpsSummarySnapshot, fetchOpsSummaryFull };
