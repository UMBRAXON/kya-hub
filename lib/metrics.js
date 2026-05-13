// ============================================================================
// UMBRAXON KYA-Hub — Prometheus metrics
// Strategic Sprint §30 Item 10
// ----------------------------------------------------------------------------
// Exposes the hub's operational state in Prometheus text format on
// `/api/metrics` (admin-auth-gated). Designed to be scraped by Netdata or
// any Prometheus-compatible collector.
//
// Metric families:
//   kyahub_requests_total{route, method, status}           — counter
//   kyahub_request_duration_seconds{route, method}          — histogram (s)
//   kyahub_pending_anchors                                 — gauge (last refresh)
//   kyahub_active_agents{tier, zone}                        — gauge
//   kyahub_agents_ever_registered                           — gauge (COUNT(*) agents; lifetime)
//   kyahub_registration_intents{status}                     — gauge (registration_intents by status)
//   kyahub_webhook_deliveries_unprocessed{source}         — gauge (webhook_deliveries processed=false)
//   kyahub_rejected_requests_24h                          — gauge (rejected_requests last 24h)
//   kyahub_rejected_requests_by_reason_24h{reason}       — gauge (top 8 reasons, last 24h)
//   kyahub_circuit_breaker_state{breaker_name}              — gauge (0=closed,1=open,2=half_open)
//   kyahub_lightning_inbound_sat                            — gauge
//   kyahub_btcpay_balance_sat                               — gauge
//   kyahub_bitcoind_anchor_balance_sat                      — gauge
//
// Also re-exports the default process metrics (CPU, RSS, open FDs, GC) under
// `kyahub_` prefix so Netdata gets node.js insight for free.
//
// p99 latency alert: the histogram exposes the standard
// `kyahub_request_duration_seconds_bucket{le="0.5"}` buckets, so the alert
// is configured downstream in Prometheus as:
//   histogram_quantile(0.99, rate(kyahub_request_duration_seconds_bucket{route="/api/pay"}[5m])) > 0.5
// The Telegram-bridge integration belongs in the operator's existing
// alertmanager config, NOT in node.js — keeping concerns separated.
// ============================================================================
'use strict';
const client = require('prom-client');
const { fetchOpsSummarySnapshot } = require('./ops-summary-data');

const PREFIX = process.env.METRICS_PREFIX || 'kyahub';

const registry = new client.Registry();
registry.setDefaultLabels({ app: 'kya-hub' });
client.collectDefaultMetrics({ register: registry, prefix: `${PREFIX}_proc_` });

const requestsTotal = new client.Counter({
    name: `${PREFIX}_requests_total`,
    help: 'Total HTTP requests served, labelled by route, method, and status code class (200/300/400/500).',
    labelNames: ['route', 'method', 'status'],
    registers: [registry],
});

const requestDuration = new client.Histogram({
    name: `${PREFIX}_request_duration_seconds`,
    help: 'HTTP request latency (seconds), labelled by route + method. Buckets tuned around the 0.5 s SLO.',
    labelNames: ['route', 'method'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
});

const pendingAnchors = new client.Gauge({
    name: `${PREFIX}_pending_anchors`,
    help: 'Number of rows in pending_anchors with status PENDING/BROADCAST (waiting for confirmation).',
    registers: [registry],
});

const activeAgents = new client.Gauge({
    name: `${PREFIX}_active_agents`,
    help: 'Active agents broken down by tier and reputation zone.',
    labelNames: ['tier', 'zone'],
    registers: [registry],
});

const agentsEverRegistered = new client.Gauge({
    name: `${PREFIX}_agents_ever_registered`,
    help: 'All-time count of agent rows in the agents table (every KYA registration ever persisted, including retired).',
    registers: [registry],
});

const registrationIntents = new client.Gauge({
    name: `${PREFIX}_registration_intents`,
    help: 'Registration intents grouped by lifecycle status (DB truth).',
    labelNames: ['status'],
    registers: [registry],
});

const webhookDeliveriesUnprocessed = new client.Gauge({
    name: `${PREFIX}_webhook_deliveries_unprocessed`,
    help: 'Count of webhook_deliveries rows with processed=false, by source (btcpay|alby).',
    labelNames: ['source'],
    registers: [registry],
});

const rejectedRequests24h = new client.Gauge({
    name: `${PREFIX}_rejected_requests_24h`,
    help: 'Count of rejected_requests rows in the rolling last 24 hours.',
    registers: [registry],
});

const rejectedRequestsByReason24h = new client.Gauge({
    name: `${PREFIX}_rejected_requests_by_reason_24h`,
    help: 'Top rejection reasons in the last 24 hours (at most 8 series).',
    labelNames: ['reason'],
    registers: [registry],
});

const breakerState = new client.Gauge({
    name: `${PREFIX}_circuit_breaker_state`,
    help: 'Circuit breaker state per name (0=CLOSED, 1=OPEN, 2=HALF_OPEN, 3=DEGRADED_WARN, 4=MAINTENANCE_HALT).',
    labelNames: ['breaker_name'],
    registers: [registry],
});

const lightningInbound = new client.Gauge({
    name: `${PREFIX}_lightning_inbound_sat`,
    help: 'Last-known Lightning inbound liquidity in satoshis. -1 if unknown (NWC fallback path).',
    registers: [registry],
});

const lightningOutbound = new client.Gauge({
    name: `${PREFIX}_lightning_outbound_sat`,
    help: 'Last-known Lightning outbound liquidity in satoshis. -1 if unknown.',
    registers: [registry],
});

const btcpayBalance = new client.Gauge({
    name: `${PREFIX}_btcpay_balance_sat`,
    help: 'Last-observed BTCPay store on-chain wallet balance in satoshis.',
    registers: [registry],
});

const bitcoindAnchorBalance = new client.Gauge({
    name: `${PREFIX}_bitcoind_anchor_balance_sat`,
    help: 'Last-observed bitcoind kya-anchor wallet balance in satoshis.',
    registers: [registry],
});

const chainConsensusStatus = new client.Gauge({
    name: `${PREFIX}_chain_consensus_state`,
    help: 'Fork-detector state: 0=OK, 1=INSUFFICIENT_SOURCES, 2=LOCAL_RPC_UNREACHABLE, 3=FORK_DETECTED.',
    registers: [registry],
});

const certBreakerFailPct = new client.Gauge({
    name: `${PREFIX}_cert_breaker_fail_pct`,
    help: 'Cert-issuance breaker rolling-window failure percentage (0-100).',
    registers: [registry],
});

const volumetricUsage = new client.Gauge({
    name: `${PREFIX}_volumetric_usage`,
    help: 'Current rolling-window consumption of a volumetric AML limit.',
    labelNames: ['limit_key', 'subject_id'],
    registers: [registry],
});

const startTimeSeconds = new client.Gauge({
    name: `${PREFIX}_start_time_seconds`,
    help: 'Unix timestamp at which the hub process started.',
    registers: [registry],
});
startTimeSeconds.set(Math.floor(Date.now() / 1000));

/** Safe label value for Prometheus (bounded, no runaway cardinality from DB). */
function _promLabelValue(s) {
    const t = String(s ?? 'unknown').replace(/[\r\n"\\]/g, '_').replace(/\|/g, '_');
    return t.length > 64 ? t.slice(0, 64) : t;
}

function _statusClass(code) {
    if (!code) return 'unknown';
    if (code < 200) return '1xx';
    if (code < 300) return '2xx';
    if (code < 400) return '3xx';
    if (code < 500) return '4xx';
    return '5xx';
}

/**
 * Express middleware: measure every request. Place it BEFORE all routes
 * but AFTER body parsing (so req.route is populated).
 *
 * We try to label by `req.route.path` (post-match) to keep cardinality
 * bounded. Falls back to the raw URL pathname truncated to 64 chars for
 * unmatched paths.
 */
function requestMetricsMiddleware() {
    return function (req, res, next) {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            try {
                const elapsedNs = Number(process.hrtime.bigint() - start);
                const elapsedSec = elapsedNs / 1e9;
                let route = (req.route && req.route.path) || req.baseUrl + (req.path || '') || req.path || 'unknown';
                if (typeof route !== 'string') route = String(route);
                if (route.length > 96) route = route.slice(0, 96);
                const method = (req.method || 'GET').toUpperCase();
                const status = String(res.statusCode || 0);
                requestsTotal.inc({ route, method, status: _statusClass(res.statusCode) });
                requestDuration.observe({ route, method }, elapsedSec);
                if (parseInt(status, 10) >= 200 && parseInt(status, 10) < 600) {
                    // also expose by exact status if low-cardinality
                    requestsTotal.inc({ route, method, status });
                }
            } catch (_) { /* never break the response */ }
        });
        next();
    };
}

/**
 * Refresh slow-changing gauges from the DB / external probes. Called by
 * `/api/metrics` BEFORE rendering. Each call is fully try/caught so a
 * single source going down can't poison the entire scrape.
 *
 * Cached for `METRICS_REFRESH_TTL_MS` (default 15 s) so a high scrape
 * rate doesn't hammer postgres.
 */
let _lastRefresh = 0;
const REFRESH_TTL_MS = parseInt(process.env.METRICS_REFRESH_TTL_MS || '15000', 10);

async function refreshFromDeps({ pool, breakers, certBreaker, forkDetector, liquidityMonitor }) {
    const now = Date.now();
    if (now - _lastRefresh < REFRESH_TTL_MS) return;
    _lastRefresh = now;

    if (pool) {
        try {
            const r = await pool.query(
                `SELECT COUNT(*)::int AS c FROM pending_anchors
                   WHERE status IN ('PENDING','BROADCAST','BROADCASTING')`);
            pendingAnchors.set(r.rows[0]?.c || 0);
        } catch (_) {}

        try {
            const r = await pool.query(
                `SELECT
                    COALESCE(tier, 'UNKNOWN') AS tier,
                    CASE
                        WHEN reputation_score >= 70 THEN 'GREEN'
                        WHEN reputation_score >= 40 THEN 'YELLOW'
                        ELSE 'RED'
                    END AS zone,
                    COUNT(*)::int AS c
                 FROM agents
                 WHERE is_active = TRUE AND retired_at IS NULL
                 GROUP BY 1, 2`);
            activeAgents.reset();
            for (const row of r.rows) {
                activeAgents.set({ tier: row.tier, zone: row.zone }, row.c);
            }
        } catch (_) {}

        try {
            const rAll = await pool.query('SELECT COUNT(*)::int AS c FROM agents');
            agentsEverRegistered.set(rAll.rows[0]?.c || 0);
        } catch (_) {}

        try {
            const snap = await fetchOpsSummarySnapshot(pool);
            registrationIntents.reset();
            for (const row of snap.registration_intents) {
                registrationIntents.set({ status: _promLabelValue(row.status) }, row.count);
            }
            webhookDeliveriesUnprocessed.reset();
            for (const row of snap.webhook_unprocessed) {
                webhookDeliveriesUnprocessed.set({ source: _promLabelValue(row.source) }, row.count);
            }
            rejectedRequests24h.set(snap.rejected_requests_24h);
            rejectedRequestsByReason24h.reset();
            for (const row of snap.rejected_top_reasons_24h) {
                rejectedRequestsByReason24h.set({ reason: _promLabelValue(row.reason) }, row.count);
            }
        } catch (_) {}
    }

    if (breakers && typeof breakers.snapshotAll === 'function') {
        try {
            for (const b of breakers.snapshotAll()) {
                const v = b.state === 'OPEN' ? 1 : b.state === 'HALF_OPEN' ? 2 : 0;
                breakerState.set({ breaker_name: b.name }, v);
            }
        } catch (_) {}
    }

    if (certBreaker && typeof certBreaker.state === 'function') {
        try {
            const s = certBreaker.state();
            const v = s.state === 'MAINTENANCE_HALT' ? 4
                : s.state === 'DEGRADED_WARN' ? 3
                : s.state === 'OPEN' ? 1
                : s.state === 'HALF_OPEN' ? 2 : 0;
            breakerState.set({ breaker_name: 'cert_issuance' }, v);
            if (typeof s.fail_pct === 'number') certBreakerFailPct.set(s.fail_pct);
        } catch (_) {}
    }

    if (forkDetector && typeof forkDetector.getLastResult === 'function') {
        try {
            const r = forkDetector.getLastResult();
            if (r && typeof r.status === 'string') {
                const map = { OK: 0, INSUFFICIENT_SOURCES: 1, LOCAL_RPC_UNREACHABLE: 2, FORK_DETECTED: 3 };
                if (Object.prototype.hasOwnProperty.call(map, r.status)) {
                    chainConsensusStatus.set(map[r.status]);
                }
            }
        } catch (_) {}
    }

    if (liquidityMonitor && typeof liquidityMonitor.getLastResult === 'function') {
        try {
            const r = liquidityMonitor.getLastResult();
            if (r) {
                lightningInbound.set(typeof r.inbound_sats === 'number' ? r.inbound_sats : -1);
                lightningOutbound.set(typeof r.outbound_sats === 'number' ? r.outbound_sats : -1);
            }
        } catch (_) {}
    }
}

function setBtcpayBalanceSats(sats)         { if (Number.isFinite(sats)) btcpayBalance.set(sats); }
function setBitcoindAnchorBalanceSats(sats) { if (Number.isFinite(sats)) bitcoindAnchorBalance.set(sats); }
function setLightningInbound(sats)          { lightningInbound.set(Number.isFinite(sats) ? sats : -1); }
function setLightningOutbound(sats)         { lightningOutbound.set(Number.isFinite(sats) ? sats : -1); }
function recordVolumetricUsage(limit_key, subject_id, value) {
    if (Number.isFinite(value)) {
        volumetricUsage.set({ limit_key, subject_id: subject_id || 'global' }, value);
    }
}

async function render() {
    return registry.metrics();
}
function contentType() { return registry.contentType; }

module.exports = {
    registry,
    requestMetricsMiddleware,
    refreshFromDeps,
    render, contentType,
    setBtcpayBalanceSats, setBitcoindAnchorBalanceSats,
    setLightningInbound, setLightningOutbound,
    recordVolumetricUsage,
    // raw gauges exposed for tests
    _gauges: {
        pendingAnchors, activeAgents, agentsEverRegistered, registrationIntents,
        webhookDeliveriesUnprocessed, rejectedRequests24h, rejectedRequestsByReason24h,
        breakerState,
        lightningInbound, lightningOutbound,
        btcpayBalance, bitcoindAnchorBalance,
        chainConsensusStatus, certBreakerFailPct, volumetricUsage,
    },
};
