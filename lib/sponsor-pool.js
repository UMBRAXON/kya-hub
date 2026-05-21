// ============================================================================
// Operator sponsor pool — one-time codes for discounted/free registration (growth)
// ============================================================================
// Redemption at register/initiate is wired when SPONSOR_POOL_REGISTER_HOOK=true.
// Admin creates codes via POST /api/admin/sponsor-pool/codes
// ============================================================================

'use strict';

const crypto = require('crypto');

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{4,31}$/;

const CFG = {
    ENABLED: String(process.env.SPONSOR_POOL_ENABLED || 'false').toLowerCase() === 'true',
    REGISTER_HOOK: String(process.env.SPONSOR_POOL_REGISTER_HOOK || 'false').toLowerCase() === 'true',
    DEFAULT_TIER: (process.env.SPONSOR_POOL_DEFAULT_TIER || 'BASIC').toUpperCase(),
};

function normaliseCode(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const c = raw.trim().toUpperCase();
    return CODE_RE.test(c) ? c : null;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} code
 */
async function validateCode(pool, code) {
    const c = normaliseCode(code);
    if (!c) return { ok: false, error: 'INVALID_CODE_FORMAT' };
    const r = await pool.query(
        `SELECT code, tier_name, max_uses, uses_count, expires_at, note
         FROM sponsor_pool_codes WHERE code = $1`,
        [c],
    );
    if (r.rowCount === 0) return { ok: false, error: 'CODE_NOT_FOUND' };
    const row = r.rows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return { ok: false, error: 'CODE_EXPIRED' };
    }
    if (row.uses_count >= row.max_uses) {
        return { ok: false, error: 'CODE_EXHAUSTED' };
    }
    return {
        ok: true,
        code: row.code,
        tier_name: row.tier_name,
        remaining: row.max_uses - row.uses_count,
    };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ code: string, kya_id: string }} opts
 */
async function redeemCode(client, { code, kya_id }) {
    const c = normaliseCode(code);
    const r = await client.query(
        `UPDATE sponsor_pool_codes
         SET uses_count = uses_count + 1
         WHERE code = $1 AND uses_count < max_uses
           AND (expires_at IS NULL OR expires_at > NOW())
         RETURNING code, tier_name`,
        [c],
    );
    if (r.rowCount === 0) throw new Error('SPONSOR_POOL_REDEEM_FAILED');
    await client.query(
        `INSERT INTO sponsor_pool_redemptions (code, kya_id) VALUES ($1, $2)`,
        [c, kya_id],
    );
    return r.rows[0];
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ tier_name?: string, max_uses?: number, expires_at?: string, note?: string, code?: string }} opts
 */
async function createCode(pool, opts) {
    const tier_name = (opts.tier_name || CFG.DEFAULT_TIER).toUpperCase();
    if (!['BASIC', 'ELITE'].includes(tier_name)) {
        return { error: 'INVALID_TIER' };
    }
    const max_uses = Math.min(Math.max(parseInt(opts.max_uses || '1', 10), 1), 1000);
    const code = normaliseCode(opts.code) || normaliseCode(crypto.randomBytes(6).toString('hex').toUpperCase());
    if (!code) return { error: 'INVALID_CODE' };

    const r = await pool.query(
        `INSERT INTO sponsor_pool_codes (code, tier_name, max_uses, expires_at, note)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [code, tier_name, max_uses, opts.expires_at || null, opts.note || null],
    );
    return { ok: true, row: r.rows[0] };
}

async function listCodes(pool, { limit = 50 } = {}) {
    const r = await pool.query(
        `SELECT code, tier_name, max_uses, uses_count, expires_at, note, created_at
         FROM sponsor_pool_codes ORDER BY created_at DESC LIMIT $1`,
        [Math.min(limit, 200)],
    );
    return r.rows;
}

module.exports = {
    CFG,
    normaliseCode,
    validateCode,
    redeemCode,
    createCode,
    listCodes,
};
