// ============================================================================
// UMBRAXON KYA-Hub — Developer API key persistence (integrator / plug-in layer)
// ============================================================================

const developerApiAuth = require('./developer-api-auth');

const TIER_DEFAULTS = {
    free: parseInt(process.env.DEVKEY_RATE_FREE_PER_MIN || '60', 10),
    pro: parseInt(process.env.DEVKEY_RATE_PRO_PER_MIN || '300', 10),
    enterprise: parseInt(process.env.DEVKEY_RATE_ENTERPRISE_PER_MIN || '1000', 10),
};

const ALLOWED_SCOPES = new Set(['agents:read', 'discovery:read', 'webhooks:manage', '*']);
const ALLOWED_TIERS = new Set(['free', 'pro', 'enterprise']);

function tierDefaultRate(tier) {
    return TIER_DEFAULTS[tier] || TIER_DEFAULTS.free;
}

function sanitizeScopes(scopes) {
    if (!Array.isArray(scopes) || scopes.length === 0) return ['agents:read'];
    const out = scopes.filter((s) => typeof s === 'string' && ALLOWED_SCOPES.has(s));
    return out.length ? out : ['agents:read'];
}

/**
 * @param {import('pg').Pool} pool
 */
async function listKeys(pool) {
    const r = await pool.query(
        `SELECT id, key_prefix, label, owner_contact, scopes, tier, rate_limit_per_min,
                created_at, last_used_at, revoked_at
         FROM developer_api_keys
         ORDER BY created_at DESC
         LIMIT 200`
    );
    return r.rows.map((row) => ({
        id: row.id,
        key_prefix: row.key_prefix,
        label: row.label,
        owner_contact: row.owner_contact,
        scopes: row.scopes,
        tier: row.tier,
        rate_limit_per_min: row.rate_limit_per_min,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        revoked: !!row.revoked_at,
        revoked_at: row.revoked_at,
    }));
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ label?: string, owner_contact?: string, scopes?: string[], tier?: string, rate_limit_per_min?: number }} input
 */
async function createKey(pool, input = {}) {
    const tier = ALLOWED_TIERS.has(input.tier) ? input.tier : 'free';
    const rate =
        Number.isInteger(input.rate_limit_per_min) && input.rate_limit_per_min > 0
            ? input.rate_limit_per_min
            : tierDefaultRate(tier);
    const scopes = sanitizeScopes(input.scopes);
    const { raw, prefix, hash } = developerApiAuth.generateApiKey();
    const r = await pool.query(
        `INSERT INTO developer_api_keys
            (key_prefix, key_hash, label, owner_contact, scopes, tier, rate_limit_per_min)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, key_prefix, label, owner_contact, scopes, tier, rate_limit_per_min, created_at`,
        [
            prefix,
            hash,
            (input.label || '').slice(0, 128) || null,
            (input.owner_contact || '').slice(0, 256) || null,
            scopes,
            tier,
            rate,
        ]
    );
    const row = r.rows[0];
    return {
        id: row.id,
        api_key: raw,
        key_prefix: row.key_prefix,
        label: row.label,
        owner_contact: row.owner_contact,
        scopes: row.scopes,
        tier: row.tier,
        rate_limit_per_min: row.rate_limit_per_min,
        created_at: row.created_at,
        warning: 'Store api_key securely — it is shown only once.',
    };
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} id UUID
 */
async function revokeKey(pool, id) {
    const r = await pool.query(
        `UPDATE developer_api_keys
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, key_prefix, revoked_at`,
        [id]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0];
}

module.exports = {
    TIER_DEFAULTS,
    ALLOWED_SCOPES,
    ALLOWED_TIERS,
    listKeys,
    createKey,
    revokeKey,
    tierDefaultRate,
};
