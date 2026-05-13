// ============================================================================
// UMBRAXON KYA-Hub — HTTP 403 sliding-window tracker
// ============================================================================
// Lightweight in-process counter of 403 responses across the whole hub. Used
// to detect short-term spikes (e.g. mass-suspended agents retrying, mass bad
// signatures, sudden enforcement waves) and, while a spike is active, hand
// out longer-lived auth challenges so legit clients can still complete their
// flows.
//
// Why a separate module: 403 responses come from many places —
// `lib/zone-rate-limiter.js` (AGENT_SUSPENDED, zone block), `rejectAndLog`
// in server.js, and direct `res.status(403)` calls. Counting at the express
// `res.on('finish')` boundary captures all of them with a single hook.
//
// In-process only (per PM2 instance). For horizontal scale-out behind a load
// balancer this would need a Redis or DB-backed aggregate; see plan.
// ============================================================================

const DEFAULT_WINDOW_MIN = 10;
const DEFAULT_THRESHOLD = 30;
const DEFAULT_TTL_MULTIPLIER = 2;

function _parseInt(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : fallback;
}

function _parseFloat(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = parseFloat(String(raw));
    return Number.isFinite(n) ? n : fallback;
}

const CFG = {
    WINDOW_MIN: Math.max(1, _parseInt(process.env.AUTH_CHALLENGE_403_SPIKE_WINDOW_MIN, DEFAULT_WINDOW_MIN)),
    THRESHOLD: Math.max(1, _parseInt(process.env.AUTH_CHALLENGE_403_SPIKE_THRESHOLD, DEFAULT_THRESHOLD)),
    TTL_MULTIPLIER: Math.max(1, _parseFloat(process.env.AUTH_CHALLENGE_403_SPIKE_TTL_MULTIPLIER, DEFAULT_TTL_MULTIPLIER)),
    EXTEND_OPEN_ON_SPIKE: String(process.env.AUTH_CHALLENGE_EXTEND_OPEN_ON_SPIKE || '').toLowerCase() === 'true'
        || process.env.AUTH_CHALLENGE_EXTEND_OPEN_ON_SPIKE === '1',
};

// Ring of timestamps (ms). Bounded by window size; we trim on every read/write
// so the worst-case length is roughly the 403 rate * window.
const _events = [];

function _windowMs() { return CFG.WINDOW_MIN * 60 * 1000; }

function _prune(nowMs) {
    const cutoff = nowMs - _windowMs();
    let drop = 0;
    while (drop < _events.length && _events[drop] < cutoff) drop++;
    if (drop > 0) _events.splice(0, drop);
}

/**
 * Record a single 403 response. Cheap: array push + occasional prune.
 */
function note403(nowMs = Date.now()) {
    _events.push(nowMs);
    // Periodic prune so the array does not grow unbounded under sustained spikes.
    if (_events.length % 64 === 0) _prune(nowMs);
}

/**
 * Number of 403 responses observed in the configured window.
 */
function get403CountInWindow(nowMs = Date.now()) {
    _prune(nowMs);
    return _events.length;
}

/**
 * Is the hub currently experiencing a 403 spike per the configured threshold?
 */
function is403Spike(nowMs = Date.now()) {
    return get403CountInWindow(nowMs) >= CFG.THRESHOLD;
}

/**
 * Compute the auth-challenge TTL to use right now, given the configured base.
 * Returns `{ ttl_sec, mode, count_in_window }`.
 */
function computeChallengeTtl(baseTtlSec, nowMs = Date.now()) {
    const base = Math.max(1, parseInt(baseTtlSec, 10) || 0);
    const count = get403CountInWindow(nowMs);
    if (count >= CFG.THRESHOLD) {
        const ttl = Math.max(base, Math.floor(base * CFG.TTL_MULTIPLIER));
        return { ttl_sec: ttl, mode: 'spike', count_in_window: count };
    }
    return { ttl_sec: base, mode: 'normal', count_in_window: count };
}

/**
 * Express middleware: attach `res.on('finish')` hook that records the response
 * if status is 403. Idempotent (only marks each response once via `_noted`).
 */
function buildExpressMiddleware() {
    return function http403Counter(req, res, next) {
        if (res._http403Noted) return next();
        res._http403Noted = true;
        res.on('finish', () => {
            if (res.statusCode === 403) note403();
        });
        next();
    };
}

/**
 * Snapshot for diagnostics / dashboard exposure.
 */
function snapshot(nowMs = Date.now()) {
    const count = get403CountInWindow(nowMs);
    return {
        window_min: CFG.WINDOW_MIN,
        threshold: CFG.THRESHOLD,
        ttl_multiplier: CFG.TTL_MULTIPLIER,
        count_in_window: count,
        spike: count >= CFG.THRESHOLD,
        extend_open_on_spike: CFG.EXTEND_OPEN_ON_SPIKE,
    };
}

/**
 * Reset the in-memory window (tests only).
 */
function _resetForTest() {
    _events.length = 0;
}

module.exports = {
    CFG,
    note403,
    get403CountInWindow,
    is403Spike,
    computeChallengeTtl,
    buildExpressMiddleware,
    snapshot,
    _resetForTest,
};
