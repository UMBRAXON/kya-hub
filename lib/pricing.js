// ============================================================================
// UMBRAXON KYA-Hub — Dynamic Pricing (Phase 2.4)
// ============================================================================
// Live-reload pricing pre TIERS (BASIC / ELITE). 
// 
// Source of truth: tabuľka tier_pricing.
// Cache: in-memory snapshot, reloaduje sa cez:
//   - automatic poll every PRICING_POLL_MS (default 60s)
//   - explicit reload() (po admin update endpoint)
//   - event 'update' (interný EventEmitter)
//
// .env fallback overrides (ak chceš override DB):
//   - TIER_BASIC_SATS, TIER_BASIC_GRADE, TIER_BASIC_DURATION_MONTHS
//   - TIER_ELITE_SATS, TIER_ELITE_GRADE, TIER_ELITE_REQUIRES_ANCHOR
//
// API:
//   pricing.init(pool, logger)       — load + start poller
//   pricing.getAll()                  — { BASIC: {...}, ELITE: {...} }
//   pricing.getTier(name)             — { tier_name, amount_sats, grade, duration_months, ... }
//   pricing.update(pool, opts)        — admin live update (INSERT new row, expire old)
//   pricing.reload(pool)              — re-read from DB
//   pricing.on('update', cb)          — subscribe
// ============================================================================

const { EventEmitter } = require('events');

const bus = new EventEmitter();

let _cache = null;
let _pool = null;
let _logger = null;
let _pollTimer = null;

const CFG = {
    POLL_MS: parseInt(process.env.PRICING_POLL_MS || '60000', 10),
    FALLBACK_BASIC: {
        tier_name: 'BASIC',
        amount_sats: parseInt(process.env.TIER_BASIC_SATS || '10000', 10),
        grade: process.env.TIER_BASIC_GRADE || 'B',
        duration_months: parseInt(process.env.TIER_BASIC_DURATION_MONTHS || '12', 10),
        requires_anchor: false,
        base_reputation: 500,
        source: 'env-fallback',
    },
    FALLBACK_ELITE: {
        tier_name: 'ELITE',
        amount_sats: parseInt(process.env.TIER_ELITE_SATS || '80000', 10),
        grade: process.env.TIER_ELITE_GRADE || 'S',
        duration_months: null,
        requires_anchor: (process.env.TIER_ELITE_REQUIRES_ANCHOR || 'true') === 'true',
        base_reputation: 900,
        source: 'env-fallback',
    },
};

async function _loadFromDb(pool) {
    const r = await pool.query(
        `SELECT tier_name, amount_sats, grade, duration_months, requires_anchor,
                base_reputation, effective_from, changed_by, change_reason
         FROM tier_pricing
         WHERE effective_until IS NULL`
    );
    const map = {};
    for (const row of r.rows) {
        map[row.tier_name] = {
            tier_name: row.tier_name,
            amount_sats: row.amount_sats,
            grade: row.grade,
            duration_months: row.duration_months,
            requires_anchor: row.requires_anchor,
            base_reputation: row.base_reputation,
            effective_from: row.effective_from,
            changed_by: row.changed_by,
            change_reason: row.change_reason,
            source: 'db',
        };
    }
    return map;
}

function _withFallback(dbMap) {
    return {
        BASIC: dbMap.BASIC || CFG.FALLBACK_BASIC,
        ELITE: dbMap.ELITE || CFG.FALLBACK_ELITE,
    };
}

async function init(pool, logger) {
    _pool = pool;
    _logger = logger;
    try {
        const m = await _loadFromDb(pool);
        _cache = _withFallback(m);
        if (logger && logger.info) {
            logger.info({
                BASIC: _cache.BASIC.amount_sats,
                ELITE: _cache.ELITE.amount_sats,
            }, 'pricing initialized');
        }
    } catch (e) {
        _cache = _withFallback({});
        if (logger && logger.warn) {
            logger.warn({ err: e.message }, 'pricing load FAIL, using fallback');
        }
    }
    
    // Start poller
    if (CFG.POLL_MS > 0 && !_pollTimer) {
        _pollTimer = setInterval(async () => {
            try {
                await reload(_pool);
            } catch (_) { /* swallow */ }
        }, CFG.POLL_MS);
        if (typeof _pollTimer.unref === 'function') _pollTimer.unref();
    }
}

async function reload(pool) {
    const targetPool = pool || _pool;
    if (!targetPool) throw new Error('pricing not initialized (no pool)');
    const newMap = _withFallback(await _loadFromDb(targetPool));
    const changed = JSON.stringify(_cache) !== JSON.stringify(newMap);
    _cache = newMap;
    if (changed && _logger && _logger.info) {
        _logger.info({
            BASIC: _cache.BASIC.amount_sats, ELITE: _cache.ELITE.amount_sats,
        }, 'pricing reloaded (changed)');
        bus.emit('update', _cache);
    }
    return _cache;
}

function getAll() {
    if (!_cache) {
        // Lazy fallback bez init
        return _withFallback({});
    }
    return _cache;
}

function getTier(name) {
    const all = getAll();
    return all[name] || null;
}

/**
 * Admin live update — atómovo: expire current ACTIVE, insert nový riadok ACTIVE.
 * 
 * @param {pg.Pool} pool
 * @param {object} opts
 *   - tier_name (BASIC | ELITE)
 *   - amount_sats (required)
 *   - grade, duration_months, requires_anchor, base_reputation (optional, default = current)
 *   - changed_by, change_reason
 *
 * @returns { previous, current }
 */
async function update(pool, opts) {
    const { tier_name, amount_sats, grade, duration_months, requires_anchor, base_reputation, changed_by, change_reason } = opts;
    
    if (!['BASIC', 'ELITE'].includes(tier_name)) {
        throw new Error('Invalid tier_name (must be BASIC or ELITE)');
    }
    if (!Number.isInteger(amount_sats) || amount_sats <= 0 || amount_sats > 10_000_000) {
        throw new Error('Invalid amount_sats (1..10M)');
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Get current ACTIVE row (for defaults + history)
        const curR = await client.query(
            `SELECT * FROM tier_pricing WHERE tier_name = $1 AND effective_until IS NULL`,
            [tier_name]
        );
        const cur = curR.rows[0] || null;
        
        // Expire current
        if (cur) {
            await client.query(
                `UPDATE tier_pricing SET effective_until = NOW() WHERE id = $1`,
                [cur.id]
            );
        }
        
        // Insert new
        const newR = await client.query(
            `INSERT INTO tier_pricing (
                tier_name, amount_sats, grade, duration_months, requires_anchor, base_reputation,
                changed_by, change_reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                tier_name,
                amount_sats,
                grade !== undefined ? grade : (cur ? cur.grade : (tier_name === 'BASIC' ? 'B' : 'S')),
                duration_months !== undefined ? duration_months : (cur ? cur.duration_months : (tier_name === 'BASIC' ? 12 : null)),
                requires_anchor !== undefined ? !!requires_anchor : (cur ? cur.requires_anchor : (tier_name === 'ELITE')),
                base_reputation !== undefined ? base_reputation : (cur ? cur.base_reputation : (tier_name === 'BASIC' ? 500 : 900)),
                changed_by || 'admin',
                change_reason || null,
            ]
        );
        await client.query('COMMIT');
        
        await reload(pool);
        return { previous: cur, current: newR.rows[0] };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function getHistory(pool, tier_name, limit = 20) {
    const r = await pool.query(
        `SELECT * FROM tier_pricing
         WHERE ($1::text IS NULL OR tier_name = $1)
         ORDER BY effective_from DESC LIMIT $2`,
        [tier_name || null, limit]
    );
    return r.rows;
}

function on(event, cb) { bus.on(event, cb); }
function off(event, cb) { bus.off(event, cb); }

function stop() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

module.exports = {
    CFG,
    init,
    reload,
    getAll,
    getTier,
    update,
    getHistory,
    on,
    off,
    stop,
};
