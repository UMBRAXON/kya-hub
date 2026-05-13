// ============================================================================
// UMBRAXON KYA-Hub — Cert Issuance Breaker (Strategic Sprint §30 Item 3)
// ============================================================================
// Internal-flow circuit breaker around `issueCertificate()` / `signCert()` —
// fundamentally different from the existing per-upstream `lib/circuit-breaker.js`:
//
//   - circuit-breaker.js  → BTCPay/Alby outbound calls; counts CONSECUTIVE
//     failures and opens after N in a row.
//   - cert-issuance-breaker.js → KYA cert SIGNING outcomes; tracks a rolling
//     5-minute window of {success, failure} samples and trips on FAILURE
//     PERCENTAGE (not consecutive count), because cert signing should be ~100%
//     successful and any non-trivial fail rate is a sign of trouble (HSM down,
//     DB corruption, hub-key store corruption, etc.).
//
// Two thresholds (user-confirmed):
//   - SOFT WARN at 3% fail rate over the window → Telegram WARN
//     (dedupe `cert_issuance_degraded`). Cert signing continues; this is just
//     observability.
//   - HARD HALT at 8% fail rate → MAINTENANCE_MODE=true. `/api/pay` returns
//     503 with `Retry-After: 300`. Telegram CRITICAL. Operator must clear
//     via `POST /api/admin/breaker/cert-issuance/reset`.
//
// Sample window is purged lazily on every record() call. Minimum sample size
// (default 20) gates trips so a single failure doesn't trip the breaker on
// quiet days.
//
// Public API:
//   breaker.recordSuccess() / breaker.recordFailure(err)
//   breaker.canIssue()                  → false if HARD HALT engaged
//   breaker.state()                     → { state, failPct, samples, ... }
//   breaker.reset({ admin, reason })    → clear HARD HALT (audit-logged)
//   breaker.isMaintenanceMode()         → boolean (exposed to /api/pay handler)
// ============================================================================
const logger = require('./logger');
const notifications = require('./notifications');

const CFG = {
    WINDOW_MS:    parseInt(process.env.CERT_BREAKER_WINDOW_MS    || '300000', 10),   // 5 min
    MIN_SAMPLES:  parseInt(process.env.CERT_BREAKER_MIN_SAMPLES  || '20', 10),
    WARN_PCT:     parseFloat(process.env.CERT_BREAKER_WARN_PCT   || '3'),  // %
    HALT_PCT:     parseFloat(process.env.CERT_BREAKER_HALT_PCT   || '8'),  // %
    AUTO_RESET_AFTER_MS: parseInt(process.env.CERT_BREAKER_AUTO_RESET_AFTER_MS || '0', 10), // 0 = never (operator-only)
};

// Each sample: { ts: ms, ok: bool, errCode?: string }
const samples = [];
let hardHalt = false;
let hardHaltSince = 0;
let hardHaltReason = null;
let lastWarnSentAt = 0;
let totalSuccesses = 0;   // lifetime counter
let totalFailures = 0;    // lifetime counter
let resetHistory = [];    // audit trail of admin resets

function _purgeOld(now) {
    const cutoff = now - CFG.WINDOW_MS;
    while (samples.length && samples[0].ts < cutoff) samples.shift();
}

function _computeWindowStats(now) {
    _purgeOld(now);
    const total = samples.length;
    const failures = samples.reduce((acc, s) => acc + (s.ok ? 0 : 1), 0);
    const failPct = total === 0 ? 0 : (failures / total) * 100;
    return { total, failures, failPct };
}

function _checkAutoReset(now) {
    if (!hardHalt) return;
    if (CFG.AUTO_RESET_AFTER_MS <= 0) return; // operator-only by default
    if (now - hardHaltSince >= CFG.AUTO_RESET_AFTER_MS) {
        const before = { hardHalt, since: hardHaltSince, reason: hardHaltReason };
        hardHalt = false;
        hardHaltSince = 0;
        hardHaltReason = null;
        logger.warn({ event: 'cert_breaker_auto_reset', before }, 'cert-issuance breaker auto-reset after grace period');
        notifications.notify({
            category: 'info',
            title: 'Cert issuance breaker AUTO-RESET',
            body: `Grace period ${CFG.AUTO_RESET_AFTER_MS}ms elapsed. Cert signing resumed. Previous reason: ${before.reason || 'unknown'}`,
            dedupe_key: 'cert_issuance_auto_reset',
        }).catch(() => {});
    }
}

function recordSuccess() {
    const now = Date.now();
    samples.push({ ts: now, ok: true });
    totalSuccesses++;
    _purgeOld(now);
    _checkAutoReset(now);
}

function recordFailure(err) {
    const now = Date.now();
    const errCode = (err && (err.code || err.errorCode || err.name)) || null;
    samples.push({ ts: now, ok: false, errCode, errMessage: err && err.message ? err.message.slice(0, 200) : null });
    totalFailures++;
    _purgeOld(now);

    const stats = _computeWindowStats(now);
    if (stats.total < CFG.MIN_SAMPLES) return; // not enough data to trip

    if (stats.failPct >= CFG.HALT_PCT && !hardHalt) {
        hardHalt = true;
        hardHaltSince = now;
        hardHaltReason = `HALT: failPct=${stats.failPct.toFixed(2)}% (${stats.failures}/${stats.total}) over ${CFG.WINDOW_MS/1000}s window`;
        logger.error({
            event: 'cert_breaker_halted',
            fail_pct: stats.failPct,
            failures: stats.failures,
            total: stats.total,
            window_ms: CFG.WINDOW_MS,
            recent_err_codes: samples.filter(s => !s.ok).slice(-5).map(s => s.errCode),
        }, 'cert-issuance breaker HARD HALT engaged — /api/pay is now 503');
        notifications.notify({
            category: 'critical',
            title: 'Cert issuance HALTED ⛔',
            body: `${hardHaltReason}\nimpact: /api/pay returns 503 + Retry-After 300\naction: investigate hub-key store / DB / signer; reset via POST /api/admin/breaker/cert-issuance/reset once root cause confirmed.`,
            dedupe_key: 'cert_issuance_halted',
        }).catch(() => {});
        return;
    }

    if (stats.failPct >= CFG.WARN_PCT) {
        // Throttle warns to once per dedupe-window (handled by notifications.js;
        // we additionally avoid flooding logs).
        if (now - lastWarnSentAt > 60000) {
            lastWarnSentAt = now;
            logger.warn({
                event: 'cert_breaker_degraded',
                fail_pct: stats.failPct,
                failures: stats.failures,
                total: stats.total,
                window_ms: CFG.WINDOW_MS,
            }, 'cert-issuance fail rate above SOFT WARN');
            notifications.notify({
                category: 'warning',
                title: 'Cert issuance degraded',
                body: `failPct=${stats.failPct.toFixed(2)}% (${stats.failures}/${stats.total}) over ${CFG.WINDOW_MS/1000}s; threshold WARN=${CFG.WARN_PCT}% HALT=${CFG.HALT_PCT}%\nlast err codes: ${samples.filter(s => !s.ok).slice(-3).map(s => s.errCode).join(',') || 'n/a'}`,
                dedupe_key: 'cert_issuance_degraded',
            }).catch(() => {});
        }
    }
}

function canIssue() {
    _checkAutoReset(Date.now());
    return !hardHalt;
}

function isMaintenanceMode() {
    _checkAutoReset(Date.now());
    return hardHalt;
}

function state() {
    const now = Date.now();
    _checkAutoReset(now);
    const stats = _computeWindowStats(now);
    return {
        hard_halt: hardHalt,
        hard_halt_since: hardHaltSince ? new Date(hardHaltSince).toISOString() : null,
        hard_halt_reason: hardHaltReason,
        window_ms: CFG.WINDOW_MS,
        min_samples_to_trip: CFG.MIN_SAMPLES,
        warn_pct_threshold: CFG.WARN_PCT,
        halt_pct_threshold: CFG.HALT_PCT,
        window_total: stats.total,
        window_failures: stats.failures,
        window_fail_pct: Number(stats.failPct.toFixed(4)),
        lifetime_successes: totalSuccesses,
        lifetime_failures: totalFailures,
        recent_failure_codes: samples.filter(s => !s.ok).slice(-10).map(s => ({ ts: new Date(s.ts).toISOString(), code: s.errCode })),
        reset_history: resetHistory.slice(-10),
    };
}

function reset({ admin = 'unknown', reason = 'manual reset' } = {}) {
    const before = state();
    const wasHalted = hardHalt;
    hardHalt = false;
    hardHaltSince = 0;
    hardHaltReason = null;
    // Don't clear the rolling samples — operator may want to see them. But
    // clear them when explicit reason includes 'flush'.
    if (/flush|clear[-_ ]samples/i.test(reason)) samples.length = 0;
    resetHistory.push({
        ts: new Date().toISOString(),
        admin: String(admin || 'unknown').slice(0, 64),
        reason: String(reason || '').slice(0, 256),
        had_halt: wasHalted,
    });
    if (resetHistory.length > 50) resetHistory = resetHistory.slice(-50);
    logger.warn({ event: 'cert_breaker_admin_reset', admin, reason, was_halted: wasHalted }, 'cert-issuance breaker reset by admin');
    if (wasHalted) {
        notifications.notify({
            category: 'info',
            title: 'Cert issuance breaker RESET',
            body: `admin: ${admin}\nreason: ${reason}\nprevious state: ${before.hard_halt_reason || 'n/a'}`,
            dedupe_key: 'cert_issuance_reset',
        }).catch(() => {});
    }
    return { ok: true, was_halted: wasHalted, before, after: state() };
}

// Convenience wrapper: pass a function that returns a Promise; record outcome.
async function wrap(fn) {
    if (!canIssue()) {
        const e = new Error('CERT_ISSUANCE_HALTED');
        e.code = 'CERT_ISSUANCE_HALTED';
        e.retryAfterSec = 300;
        e.breakerState = state();
        throw e;
    }
    try {
        const r = await fn();
        recordSuccess();
        return r;
    } catch (e) {
        recordFailure(e);
        throw e;
    }
}

// Test helper (NOT used by server code) — fully clear state.
function _resetForTests() {
    samples.length = 0;
    hardHalt = false;
    hardHaltSince = 0;
    hardHaltReason = null;
    totalSuccesses = 0;
    totalFailures = 0;
    resetHistory = [];
    lastWarnSentAt = 0;
}

module.exports = {
    CFG,
    recordSuccess,
    recordFailure,
    canIssue,
    isMaintenanceMode,
    state,
    reset,
    wrap,
    _resetForTests,
};
