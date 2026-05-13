// Security utilities — timing-safe HMAC, admin auth, request validation
const crypto = require('crypto');

/**
 * Timing-safe HMAC SHA-256 verifikácia.
 * @param {Buffer|string} rawBody - raw request body
 * @param {string} secret - HMAC kľúč
 * @param {string} signatureHeader - hodnota zo `BTCPay-Sig` headera (formát: "sha256=hex...")
 * @returns {boolean}
 */
function verifyHmacSignature(rawBody, secret, signatureHeader) {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    if (!rawBody || (Buffer.isBuffer(rawBody) && rawBody.length === 0)) return false;
    
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    
    // Oba musia mať rovnakú dĺžku, inak timingSafeEqual hodí chybu
    const sig = Buffer.from(signatureHeader);
    const exp = Buffer.from(expected);
    if (sig.length !== exp.length) return false;
    
    try {
        return crypto.timingSafeEqual(sig, exp);
    } catch (_) {
        return false;
    }
}

/**
 * Timing-safe porovnanie dvoch tokenov.
 */
function safeCompareTokens(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (_) {
        return false;
    }
}

/**
 * Express middleware pre admin auth cez `X-Admin-Key` header.
 * Vyžaduje env premennú ADMIN_API_KEY.
 */
function adminAuth(req, res, next) {
    const expected = process.env.ADMIN_API_KEY;
    if (!expected) {
        // Ak nie je nastavený, blokujeme všetko (bezpečnejší default)
        return res.status(503).json({ error: 'ADMIN_NOT_CONFIGURED', message: 'ADMIN_API_KEY nie je v .env' });
    }
    const provided = req.headers['x-admin-key'] || req.query.adminKey;
    if (!provided || !safeCompareTokens(String(provided), expected)) {
        // Phase 2.2: BAD_ADMIN_KEY je 'critical' v abuse-tracker, čo eskaluje IP ban rýchlo.
        try {
            const abuseTracker = require('./abuse-tracker');
            const pool = req.app && req.app.locals && req.app.locals.pool;
            if (pool) {
                abuseTracker.recordRejection(pool, {
                    path: req.path, method: req.method, reason: 'BAD_ADMIN_KEY',
                    http_status: 401, client_ip: req.ip, user_agent: req.headers['user-agent'],
                    error_detail: provided ? 'wrong key provided' : 'no key provided',
                }).catch(() => {});
            }
        } catch (_) { /* fail silent — never break auth flow */ }
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    next();
}

/**
 * CORS whitelist pre KYA-Hub.
 * Botovia (server-to-server) nemajú Origin header → ich requests sú vždy povolené.
 * Browser klienti s Origin musia byť v allowlist.
 */
function buildCorsOptions() {
    const raw = process.env.CORS_ALLOWED_ORIGINS || 'https://umbraxon.xyz,https://*.umbraxon.xyz,http://localhost:3000,http://127.0.0.1:3000';
    const patterns = raw.split(',').map(s => s.trim()).filter(Boolean);
    
    // Skompiluj patterns na regex (* = wildcard subdomény)
    const regexPatterns = patterns.map(p => {
        const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        return new RegExp('^' + escaped + '$');
    });

    return {
        origin: function (origin, callback) {
            // Žiadny Origin = server-to-server (curl, bot, monitor) → POVOLENÉ
            if (!origin) return callback(null, true);
            // Browser klient s Origin → musí byť v whitelist
            const allowed = regexPatterns.some(re => re.test(origin));
            return callback(null, allowed);
        },
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'BTCPay-Sig'],
        maxAge: 86400,
    };
}

/**
 * Validácia agent name — alphanumeric, hyphens, underscores, dots, 3-64 znakov.
 */
function isValidAgentName(name) {
    return typeof name === 'string'
        && name.length >= 3 && name.length <= 64
        && /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Validácia hex pubkey — 64 alebo 66 znakov (compressed/uncompressed bez 04 prefixu).
 */
function isValidPubkey(pk) {
    if (typeof pk !== 'string') return false;
    return /^[0-9a-fA-F]{64,130}$/.test(pk);
}

module.exports = {
    verifyHmacSignature,
    safeCompareTokens,
    adminAuth,
    buildCorsOptions,
    isValidAgentName,
    isValidPubkey,
};
