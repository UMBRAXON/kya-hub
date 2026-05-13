// ============================================================================
// UMBRAXON KYA-Hub — Zone-aware Rate Limiter (Phase 2)
// ============================================================================
// Per-agent rate limiting podľa aktuálnej reputation zóny.
//
//   SUSPENDED  → blokuje úplne (HTTP 403, žiadne API volania)
//   PROBATION  → 1 request / minútu  (anti-spam, aby nemohli zaplaviť hub)
//   NEUTRAL    → 30 req / minútu     (normal usage)
//   TRUSTED    → 60 req / minútu     (vyššia dôvera)
//   ELITE_TIER → 120 req / minútu    (max trust)
//
// Implementácia: in-process sliding window (per kya_id + per endpoint kind).
// Pre multi-instance deploy by sa použila Redis backed store, ale pre Phase 2
// single-node deploymentu je in-memory dostatočné.
// ============================================================================

const reputation = require('./reputation');

// Limity per zóna (requests per minute window)
const ZONE_LIMITS = {
    SUSPENDED:  { perMin: 0,   blockReason: 'AGENT_SUSPENDED_NO_API' },
    PROBATION:  { perMin: 1,   blockReason: 'PROBATION_RATE_LIMIT' },
    NEUTRAL:    { perMin: 30,  blockReason: 'RATE_LIMIT' },
    TRUSTED:    { perMin: 60,  blockReason: 'RATE_LIMIT' },
    ELITE_TIER: { perMin: 120, blockReason: 'RATE_LIMIT' },
};

const WINDOW_MS = 60 * 1000;

// In-memory store: Map<key, Array<timestamp>>
const buckets = new Map();

function _now() { return Date.now(); }
function _pruneBucket(arr) {
    const cutoff = _now() - WINDOW_MS;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr;
}

function _key(kya_id, kind) {
    return `${kya_id}::${kind || 'default'}`;
}

/**
 * Skontroluje a zaznamená request do bucketu.
 * @returns {{ allowed, zone, limit, used, retry_after_sec }}
 */
function checkAndRecord({ kya_id, kind, score }) {
    const zone = reputation.getZone(score).name;
    const cfg = ZONE_LIMITS[zone] || ZONE_LIMITS.NEUTRAL;
    
    if (cfg.perMin === 0) {
        return { allowed: false, zone, limit: 0, used: 0, blockReason: cfg.blockReason, retry_after_sec: null };
    }
    
    const k = _key(kya_id, kind);
    let bucket = buckets.get(k);
    if (!bucket) { bucket = []; buckets.set(k, bucket); }
    _pruneBucket(bucket);
    
    if (bucket.length >= cfg.perMin) {
        const oldest = bucket[0];
        const retryAfterMs = (oldest + WINDOW_MS) - _now();
        return {
            allowed: false,
            zone,
            limit: cfg.perMin,
            used: bucket.length,
            blockReason: cfg.blockReason,
            retry_after_sec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
    }
    
    bucket.push(_now());
    return { allowed: true, zone, limit: cfg.perMin, used: bucket.length, retry_after_sec: 0 };
}

/**
 * Pravidelný cleanup starých bucketov (aby Map nerástla donekonečna).
 * Volaj raz za 10 minút.
 */
function cleanup() {
    const cutoff = _now() - 2 * WINDOW_MS;
    let removed = 0;
    for (const [k, bucket] of buckets.entries()) {
        _pruneBucket(bucket);
        if (bucket.length === 0) { buckets.delete(k); removed++; }
    }
    return removed;
}

const _cleanupInterval = setInterval(cleanup, 10 * 60 * 1000);
// .unref() — interval nedrží event loop nažive (CLI scripty môžu cleanly skončiť)
if (typeof _cleanupInterval.unref === 'function') _cleanupInterval.unref();

/**
 * Express middleware factory.
 * @param {object} opts
 *   - poolGetter: () => pg.Pool (pre lazy fetch agenta)
 *   - kind: string label pre bucket
 *   - allowMissingAgent: boolean — ak true, agent ktorý ešte neexistuje môže prejsť (pre register-flow)
 *
 * Middleware predpokladá `req.params.kya_id`.
 */
function buildMiddleware({ poolGetter, kind, allowMissingAgent = false }) {
    return async function zoneRateLimit(req, res, next) {
        const kya_id = req.params.kya_id;
        if (!kya_id) return next();
        
        // Admin bypass: ak request prinesie validný X-Admin-Key, zone-limit sa preskočí.
        // (užitočné pre integration testy, admin tooling, monitoring.)
        const adminKey = req.headers['x-admin-key'];
        const expectedAdmin = process.env.ADMIN_API_KEY;
        if (adminKey && expectedAdmin && typeof adminKey === 'string') {
            try {
                const a = Buffer.from(adminKey);
                const b = Buffer.from(expectedAdmin);
                if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) {
                    res.set('X-RateLimit-Bypass', 'admin');
                    return next();
                }
            } catch (_) { /* ignore */ }
        }
        
        const pool = poolGetter();
        let agent;
        try {
            const r = await pool.query(
                `SELECT id, kya_id, reputation_score, status, is_active FROM agents WHERE kya_id = $1`,
                [kya_id]
            );
            if (r.rowCount === 0) {
                if (allowMissingAgent) return next();
                return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
            }
            agent = r.rows[0];
        } catch (e) {
            return res.status(500).json({ error: 'DB_ERROR' });
        }
        
        // SUSPENDED status (independent of zone) → 403 vždy
        if (agent.status === 'SUSPENDED' || agent.is_active === false) {
            return res.status(403).json({
                error: 'AGENT_SUSPENDED',
                message: 'Agent je SUSPENDED — API volania sú zablokované',
                kya_id: agent.kya_id,
                status: agent.status,
            });
        }
        
        const check = checkAndRecord({
            kya_id: agent.kya_id,
            kind: kind || req.path,
            score: agent.reputation_score || 0,
        });
        
        if (!check.allowed) {
            const status = check.zone === 'SUSPENDED' ? 403 : 429;
            res.set('Retry-After', String(check.retry_after_sec || 60));
            return res.status(status).json({
                error: check.blockReason || 'RATE_LIMITED',
                zone: check.zone,
                limit_per_min: check.limit,
                used: check.used,
                retry_after_sec: check.retry_after_sec,
                message: check.zone === 'PROBATION'
                    ? 'Probation režim: max 1 request za minútu. Zlepši reputáciu úspešnými operáciami.'
                    : `Rate limit ${check.limit}/min pre zónu ${check.zone}.`,
            });
        }
        
        // Pridaj info headery
        res.set('X-RateLimit-Zone', check.zone);
        res.set('X-RateLimit-Limit', String(check.limit));
        res.set('X-RateLimit-Used', String(check.used));
        next();
    };
}

module.exports = {
    ZONE_LIMITS,
    checkAndRecord,
    buildMiddleware,
    cleanup,
    _internal: { buckets, WINDOW_MS },
};
