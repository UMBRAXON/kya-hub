// ============================================================================
// UMBRAXON KYA-Hub — Developer API key auth (integrator layer)
// ============================================================================
// Optional: missing key → anonymous (public read). Invalid key → 401.
// ============================================================================

const crypto = require('crypto');
const integratorLsat = require('./integrator-lsat');

const KEY_PREFIX = 'umb_live_';

function hashKey(raw) {
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function extractBearerKey(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    const x = req.headers['x-api-key'];
    return typeof x === 'string' ? x.trim() : '';
}

/**
 * Express middleware — attach req.integrator when valid key present.
 * @param {import('pg').Pool} pool
 */
function optionalDeveloperKey(pool) {
    return async (req, res, next) => {
        const raw = extractBearerKey(req);
        if (!raw) return next();
        if (raw.startsWith(integratorLsat.LSAT_PREFIX)) {
            try {
                const ctx = await integratorLsat.resolveToken(pool, raw);
                if (!ctx) {
                    return res.status(401).json({
                        error: 'INVALID_LSAT',
                        message: 'Unknown, expired, or revoked LSAT token',
                    });
                }
                req.integrator = {
                    id: ctx.access_id,
                    scopes: ctx.scopes,
                    tier: 'lsat',
                    rate_limit_per_min: ctx.rate_limit_per_min,
                    label: 'lsat-day-pass',
                    auth: 'lsat',
                };
                return next();
            } catch (e) {
                return res.status(500).json({ error: 'DB_ERROR' });
            }
        }
        if (!raw.startsWith(KEY_PREFIX)) {
            return res.status(401).json({
                error: 'INVALID_API_KEY',
                message: 'API key must use umb_live_ or umb_lsat_ prefix',
            });
        }
        try {
            const digest = hashKey(raw);
            const r = await pool.query(
                `SELECT id, scopes, tier, rate_limit_per_min, label
                 FROM developer_api_keys
                 WHERE key_hash = $1 AND revoked_at IS NULL`,
                [digest]
            );
            if (r.rowCount === 0) {
                return res.status(401).json({ error: 'INVALID_API_KEY', message: 'Unknown or revoked key' });
            }
            const row = r.rows[0];
            req.integrator = {
                id: row.id,
                scopes: row.scopes || ['agents:read'],
                tier: row.tier,
                rate_limit_per_min: row.rate_limit_per_min,
                label: row.label,
                auth: 'api_key',
            };
            pool.query(
                `UPDATE developer_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [row.id]
            ).catch(() => {});
            return next();
        } catch (e) {
            return res.status(500).json({ error: 'DB_ERROR' });
        }
    };
}

function requireScope(scope) {
    return (req, res, next) => {
        if (!req.integrator) {
            return res.status(401).json({
                error: 'API_KEY_REQUIRED',
                message: `Scope ${scope} requires Authorization: Bearer ${KEY_PREFIX}...`,
            });
        }
        const scopes = req.integrator.scopes || [];
        if (!scopes.includes(scope) && !scopes.includes('*')) {
            return res.status(403).json({ error: 'FORBIDDEN', message: `Missing scope: ${scope}` });
        }
        return next();
    };
}

/**
 * Generate a new key pair for admin create endpoint (future).
 * @returns {{ raw: string, prefix: string, hash: string }}
 */
function generateApiKey() {
    const secret = crypto.randomBytes(24).toString('base64url');
    const raw = `${KEY_PREFIX}${secret}`;
    return {
        raw,
        prefix: raw.slice(0, 16),
        hash: hashKey(raw),
    };
}

module.exports = {
    KEY_PREFIX,
    hashKey,
    optionalDeveloperKey,
    requireScope,
    generateApiKey,
};
