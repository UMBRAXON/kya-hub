// ============================================================================
// UMBRAXON KYA-Hub — Operator daily digest (DB snapshot for Telegram / CLI)
// ============================================================================

const HUB_PUBLIC = (process.env.HUB_URL || process.env.HUB_PUBLIC_URL || 'https://www.umbraxon.xyz').replace(/\/$/, '');
const { productionAgentsWhere, filterRows, isTestRegistration } = require('./operator-report-filters');
const PROD_WHERE = productionAgentsWhere('a');

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function fmtTs(d) {
    if (!d) return '—';
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return '—';
    return x.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function linesLimit(arr, max, mapFn) {
    const slice = arr.slice(0, max);
    const more = arr.length > max ? `\n… +${arr.length - max} more` : '';
    return slice.map(mapFn).join('\n') + more;
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ hours?: number }} opts — window for "last 24h" sections (default 24)
 */
async function collectReport(pool, opts = {}) {
    const hours = Number.isFinite(opts.hours) ? opts.hours : parseInt(process.env.OPERATOR_REPORT_HOURS || '24', 10);
    const windowInterval = `${Math.max(1, hours)} hours`;

    const [
        agentSummary,
        agentsNewInWindow,
        intentsRecent,
        intentsPending,
        devKeys,
        heartbeats,
        repEvents,
        rejected,
        webhookOutbox,
        lsatOrders,
        agentTotals,
        integratorOps,
    ] = await Promise.all([
        pool.query(`
            SELECT status, tier, COUNT(*)::int n
            FROM agents a
            WHERE ${PROD_WHERE}
            GROUP BY status, tier ORDER BY n DESC`),
        pool.query(`
            SELECT kya_id, agent_name, tier, status, reputation_score,
                   verified_at, payment_settled_at, last_heartbeat_at
            FROM agents a
            WHERE ${PROD_WHERE}
              AND a.verified_at > NOW() - $1::interval
            ORDER BY a.verified_at DESC`,
            [windowInterval],
        ),
        pool.query(`
            SELECT registration_id, agent_name, tier_requested, status, created_at, completed_at, client_ip::text
            FROM registration_intents
            WHERE created_at > NOW() - $1::interval
            ORDER BY created_at DESC LIMIT 20`,
            [windowInterval],
        ),
        pool.query(`
            SELECT ri.agent_name, ri.tier_requested, ri.status, ri.created_at::text
            FROM registration_intents ri
            WHERE ri.status NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
              AND ri.agent_name !~* '^(TEST-|GOV-|DEMO-|REPTEST|ABTEST)'
              AND ri.agent_name !~* 'UMBRAXONTEST|TEST-WEBHOOK|TEST-BOT|MANUAL_CHECK|real-ln-test|test-denylist|test-export|test-bot'
              AND ri.agent_name !~* '^Agent007$'
              AND NOT EXISTS (
                SELECT 1 FROM agents a
                WHERE lower(a.agent_name) = lower(ri.agent_name)
                  AND a.payment_settled_at IS NOT NULL
                  AND ${PROD_WHERE}
              )
            ORDER BY ri.created_at DESC LIMIT 10`),
        pool.query(`
            SELECT key_prefix, label, tier, created_at, last_used_at, revoked_at IS NOT NULL AS revoked
            FROM developer_api_keys ORDER BY created_at DESC LIMIT 10`),
        pool.query(`
            SELECT h.kya_id, a.agent_name, COUNT(*)::int n, MAX(h.received_at) AS last_hb
            FROM heartbeats_log h
            INNER JOIN agents a ON a.kya_id = h.kya_id AND ${PROD_WHERE}
            WHERE h.received_at > NOW() - $1::interval
            GROUP BY h.kya_id, a.agent_name ORDER BY last_hb DESC`,
            [windowInterval],
        ),
        pool.query(`
            SELECT r.kya_id, r.event_type, r.source, r.delta, r.score_after, r.occurred_at
            FROM reputation_events r
            INNER JOIN agents a ON a.kya_id = r.kya_id AND ${PROD_WHERE}
            WHERE r.occurred_at > NOW() - $1::interval
            ORDER BY r.occurred_at DESC LIMIT 15`,
            [windowInterval],
        ),
        pool.query(`
            SELECT path, reason, http_status, COUNT(*)::int n
            FROM rejected_requests
            WHERE occurred_at > NOW() - $1::interval
            GROUP BY path, reason, http_status
            ORDER BY n DESC LIMIT 12`,
            [windowInterval],
        ),
        pool.query(`
            SELECT status, COUNT(*)::int n FROM developer_webhook_outbox GROUP BY status ORDER BY n DESC`),
        pool.query(`
            SELECT o.access_id, o.status, o.amount_sats, o.created_at, o.paid_at
            FROM integrator_lsat_orders o
            LEFT JOIN developer_api_keys k ON k.id = o.integrator_key_id
            WHERE o.created_at > NOW() - $1::interval
              AND o.integrator_key_id IS NOT NULL
              AND (k.label IS NULL OR k.label !~* '(smoke|ready-probe|test|e2e)')
            ORDER BY o.created_at DESC LIMIT 10`,
            [windowInterval],
        ).catch(() => ({ rows: [] })),
        pool.query(`
            SELECT COUNT(*)::int total,
                   COUNT(*) FILTER (WHERE discovery_opt_in)::int opt_in,
                   COUNT(*) FILTER (WHERE payment_settled_at IS NOT NULL)::int paid
            FROM agents a
            WHERE ${PROD_WHERE}`),
        pool.query(`
            SELECT COALESCE(SUM(calls), 0)::bigint AS calls,
                   COALESCE(SUM(verified_ok), 0)::bigint AS verified_ok,
                   COUNT(DISTINCT source) FILTER (WHERE source LIKE 'key:%')::int AS external_keys
            FROM integrator_verify_daily
            WHERE day >= CURRENT_DATE - 1`,
        ).catch(() => ({ rows: [{ calls: 0, verified_ok: 0, external_keys: 0 }] })),
    ]);

    const summaryRows = agentSummary.rows;
    const totalAgents = agentTotals.rows[0]?.total || 0;

    return {
        generated_at: new Date().toISOString(),
        hub_url: HUB_PUBLIC,
        window_hours: hours,
        totals: {
            agents: totalAgents,
            paid: agentTotals.rows[0]?.paid || 0,
            discovery_opt_in: agentTotals.rows[0]?.opt_in || 0,
            by_status_tier: summaryRows,
        },
        agents_new_in_window: agentsNewInWindow.rows,
        registration_intents_24h: filterRows(intentsRecent.rows).filter((r) => !isTestRegistration(r)),
        registration_pending: filterRows(intentsPending.rows).filter((r) => !isTestRegistration(r)),
        developer_api_keys: devKeys.rows,
        heartbeats_24h: heartbeats.rows,
        reputation_events_24h: repEvents.rows,
        rejected_24h: rejected.rows,
        webhook_outbox: webhookOutbox.rows,
        lsat_orders_24h: lsatOrders.rows,
        integrator_verify_24h: integratorOps.rows[0] || {},
    };
}

/**
 * Format report for Telegram HTML (max ~4000 chars — truncate if needed).
 */
function formatTelegramHtml(report) {
    const h = report.window_hours;
    const parts = [];

    parts.push(`📊 <b>KYA Hub — daily report</b>`);
    parts.push(`${esc(fmtTs(report.generated_at))} · window <b>${h}h</b>`);
    parts.push(`<a href="${esc(report.hub_url)}">${esc(report.hub_url)}</a>`);

    const t = report.totals;
    parts.push('');
    parts.push('<b>Agents</b>');
    parts.push(`total ${t.agents} · paid ${t.paid} · discovery ${t.discovery_opt_in}`);
    for (const r of t.by_status_tier) {
        parts.push(`  ${esc(r.status)} / ${esc(r.tier)}: ${r.n}`);
    }

    parts.push('');
    parts.push(`<b>New bots (${h}h)</b>`);
    if (report.agents_new_in_window.length === 0) {
        parts.push('  (none)');
    } else {
        parts.push('<pre>' + esc(linesLimit(report.agents_new_in_window, 10, (a) =>
            `${a.agent_name} (${a.kya_id}) rep=${a.reputation_score}`
        )) + '</pre>');
    }

    parts.push('');
    parts.push(`<b>Registrations (${h}h)</b>`);
    if (report.registration_intents_24h.length === 0) {
        parts.push('  (none)');
    } else {
        parts.push('<pre>' + esc(linesLimit(report.registration_intents_24h, 6, (r) =>
            `${r.agent_name} ${r.status} ${fmtTs(r.created_at)}`
        )) + '</pre>');
    }

    if (report.registration_pending.length) {
        parts.push('');
        parts.push('<b>Pending payment</b>');
        parts.push('<pre>' + esc(linesLimit(report.registration_pending, 5, (r) =>
            `${r.agent_name} ${r.status}`
        )) + '</pre>');
    }

    const iv = report.integrator_verify_24h;
    if (iv && Number(iv.calls) > 0) {
        parts.push('');
        parts.push('<b>Integrator API (24h)</b>');
        parts.push(`calls ${iv.calls} · verified ${iv.verified_ok} · ext. keys ${iv.external_keys || 0}`);
    }

    parts.push('');
    parts.push(`<b>Heartbeats (${h}h)</b>`);
    if (report.heartbeats_24h.length === 0) {
        parts.push('  (none)');
    } else {
        parts.push('<pre>' + esc(linesLimit(report.heartbeats_24h, 8, (r) =>
            `${r.kya_id} ${r.agent_name || '?'} ×${r.n}`
        )) + '</pre>');
    }

    parts.push('');
    parts.push(`<b>Reputation events (${h}h)</b>`);
    if (report.reputation_events_24h.length === 0) {
        parts.push('  (none)');
    } else {
        parts.push('<pre>' + esc(linesLimit(report.reputation_events_24h, 6, (r) =>
            `${r.kya_id} ${r.event_type} ${r.delta >= 0 ? '+' : ''}${r.delta} →${r.score_after}`
        )) + '</pre>');
    }

    parts.push('');
    parts.push(`<b>Rejected API top (${h}h)</b>`);
    if (report.rejected_24h.length === 0) {
        parts.push('  (none)');
    } else {
        parts.push('<pre>' + esc(linesLimit(report.rejected_24h, 8, (r) =>
            `${r.n}× ${r.http_status} ${r.reason} ${(r.path || '').slice(0, 40)}`
        )) + '</pre>');
    }

    if (report.webhook_outbox.length) {
        parts.push('');
        parts.push('<b>Webhook outbox</b>');
        parts.push('<pre>' + esc(report.webhook_outbox.map((w) => `${w.status}: ${w.n}`).join('\n')) + '</pre>');
    }

    if (report.lsat_orders_24h.length) {
        parts.push('');
        parts.push(`<b>LSAT orders (${h}h)</b>`);
        parts.push('<pre>' + esc(linesLimit(report.lsat_orders_24h, 5, (r) =>
            `${r.status} ${r.amount_sats}sat ${r.access_id}`
        )) + '</pre>');
    }

    parts.push('');
    parts.push('<i>Manual:</i> <code>node scripts/operator-daily-report.js --dry-run</code>');

    let text = parts.join('\n');
    if (text.length > 3900) {
        text = text.slice(0, 3850) + '\n\n… (truncated; use --dry-run for full JSON)';
    }
    return text;
}

function formatPlainText(report) {
    return formatTelegramHtml(report)
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

module.exports = {
    collectReport,
    formatTelegramHtml,
    formatPlainText,
};
