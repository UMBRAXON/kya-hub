// ============================================================================
// UMBRAXON KYA-Hub — Integrator LSAT (paid API access token after Lightning invoice)
// ============================================================================

const crypto = require('crypto');

const LSAT_PREFIX = 'umb_lsat_';
const DEFAULT_SATS = parseInt(process.env.INTEGRATOR_LSAT_DAY_PASS_SATS || '5000', 10);
const TTL_HOURS = parseInt(process.env.INTEGRATOR_LSAT_TTL_HOURS || '24', 10);
const DEFAULT_RATE = parseInt(process.env.INTEGRATOR_LSAT_RATE_PER_MIN || '300', 10);

function _accessId() {
    return `lsat-${crypto.randomBytes(10).toString('hex')}`;
}

function hashToken(raw) {
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function generateToken() {
    const secret = crypto.randomBytes(24).toString('base64url');
    const raw = `${LSAT_PREFIX}${secret}`;
    return { raw, prefix: raw.slice(0, 16), hash: hashToken(raw) };
}

function profileDoc() {
    return {
        profile: 'umbraxon-integrator-lsat-v1',
        version: 1,
        description: 'Lightning-paid integrator API access (day pass). Pay invoice, poll status, use Bearer umb_lsat_…',
        endpoints: {
            create_invoice: 'POST /api/v1/integrator/lsat/invoice',
            poll_status: 'GET /api/v1/integrator/lsat/status?access_id=…',
        },
        default_amount_sats: DEFAULT_SATS,
        ttl_hours: TTL_HOURS,
        auth_header: 'Authorization: Bearer umb_lsat_…',
    };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ integratorKeyId?: string, clientIp?: string, amountSats?: number }} opts
 */
async function createInvoiceOrder(pool, opts = {}) {
    const access_id = _accessId();
    const amount_sats = Number.isInteger(opts.amountSats) ? opts.amountSats : DEFAULT_SATS;
    const expires_order = new Date(Date.now() + 3600 * 1000);
    await pool.query(
        `INSERT INTO integrator_lsat_orders
            (access_id, integrator_key_id, amount_sats, status, rate_limit_per_min, expires_at)
         VALUES ($1, $2, $3, 'pending', $4, $5)`,
        [access_id, opts.integratorKeyId || null, amount_sats, DEFAULT_RATE, expires_order]
    );
    return { access_id, amount_sats };
}

async function attachInvoice(pool, access_id, { invoiceId, bolt11 }) {
    await pool.query(
        `UPDATE integrator_lsat_orders SET invoice_id = $2, bolt11 = $3 WHERE access_id = $1`,
        [access_id, invoiceId, bolt11 || null]
    );
}

/**
 * Mark order paid after Lightning settlement (webhook). Token minted on redeem.
 */
async function markPaid(pool, access_id, invoiceId) {
    const r = await pool.query(
        `UPDATE integrator_lsat_orders
         SET status = 'paid', paid_at = CURRENT_TIMESTAMP, invoice_id = COALESCE(invoice_id, $2)
         WHERE access_id = $1 AND status = 'pending'
         RETURNING access_id`,
        [access_id, invoiceId || null]
    );
    if (r.rowCount > 0) return { ok: true, access_id };
    const check = await pool.query(
        `SELECT access_id, status FROM integrator_lsat_orders WHERE access_id = $1`,
        [access_id]
    );
    if (check.rowCount === 0) return { ok: false, error: 'NOT_FOUND' };
    if (check.rows[0].status === 'paid') return { ok: true, already: true, access_id };
    return { ok: false, error: 'INVALID_STATE' };
}

/**
 * Mint umb_lsat_ token once after payment (POST redeem).
 */
async function redeemToken(pool, access_id) {
    const { raw, prefix, hash } = generateToken();
    const expires_at = new Date(Date.now() + TTL_HOURS * 3600 * 1000);
    const u = await pool.query(
        `UPDATE integrator_lsat_orders
         SET token_hash = $2, token_prefix = $3, expires_at = $4
         WHERE access_id = $1 AND status = 'paid' AND token_hash IS NULL
         RETURNING access_id, scopes, rate_limit_per_min`,
        [access_id, hash, prefix, expires_at]
    );
    if (u.rowCount > 0) {
        const row = u.rows[0];
        return {
            ok: true,
            access_id: row.access_id,
            lsat_token: raw,
            expires_at: expires_at.toISOString(),
            rate_limit_per_min: row.rate_limit_per_min,
            scopes: row.scopes,
        };
    }
    const r = await pool.query(
        `SELECT access_id, status, token_hash FROM integrator_lsat_orders WHERE access_id = $1`,
        [access_id]
    );
    if (r.rowCount === 0) return { ok: false, error: 'NOT_FOUND' };
    const row = r.rows[0];
    if (row.status !== 'paid') return { ok: false, error: 'NOT_PAID', status: row.status };
    if (row.token_hash) return { ok: false, error: 'ALREADY_REDEEMED' };
    return { ok: false, error: 'REDEEM_FAILED' };
}

async function getStatus(pool, access_id, { revealToken = false } = {}) {
    const r = await pool.query(
        `SELECT access_id, status, amount_sats, invoice_id, bolt11, token_prefix,
                expires_at, paid_at, scopes, rate_limit_per_min
         FROM integrator_lsat_orders WHERE access_id = $1`,
        [access_id]
    );
    if (r.rowCount === 0) return { ok: false, error: 'NOT_FOUND' };
    const row = r.rows[0];
    const out = {
        access_id: row.access_id,
        status: row.status,
        amount_sats: row.amount_sats,
        invoice_id: row.invoice_id,
        paid_at: row.paid_at,
        expires_at: row.expires_at,
        scopes: row.scopes,
        rate_limit_per_min: row.rate_limit_per_min,
    };
    if (row.bolt11 && row.status === 'pending') out.bolt11 = row.bolt11;
    if (row.status === 'paid') out.redeem = 'POST /api/v1/integrator/lsat/redeem';
    return { ok: true, ...out };
}

/**
 * Resolve Bearer umb_lsat_… for middleware.
 */
async function resolveToken(pool, raw) {
    if (!raw || !raw.startsWith(LSAT_PREFIX)) return null;
    const digest = hashToken(raw);
    const r = await pool.query(
        `SELECT access_id, scopes, rate_limit_per_min, expires_at, status
         FROM integrator_lsat_orders
         WHERE token_hash = $1 AND status = 'paid'`,
        [digest]
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
    return {
        kind: 'lsat',
        access_id: row.access_id,
        scopes: row.scopes || ['agents:read'],
        rate_limit_per_min: row.rate_limit_per_min || DEFAULT_RATE,
    };
}

async function createBtcpayInvoice(cfg, axios, { access_id, amount_sats, integratorKeyId }) {
    const r = await axios.post(
        `${cfg.BTCPAY_URL}/api/v1/stores/${cfg.BTCPAY_STORE_ID}/invoices`,
        {
            amount: amount_sats,
            currency: 'SATS',
            metadata: {
                integratorLsatAccessId: access_id,
                integratorKeyId: integratorKeyId || null,
                amount: amount_sats,
            },
            checkout: { speedPolicy: 'HighSpeed' },
        },
        {
            headers: { Authorization: `token ${cfg.BTCPAY_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 10000,
        }
    );
    const inv = r.data;
    let bolt11 = null;
    if (inv.id) {
        try {
            const pm = await axios.get(
                `${cfg.BTCPAY_URL}/api/v1/stores/${cfg.BTCPAY_STORE_ID}/invoices/${inv.id}/payment-methods`,
                { headers: { Authorization: `token ${cfg.BTCPAY_API_KEY}` }, timeout: 10000 }
            );
            const ln = (pm.data || []).find((m) => m.paymentMethodId === 'BTC-LN');
            bolt11 = ln && ln.destination ? ln.destination : null;
        } catch {
            /* optional */
        }
    }
    return { invoiceId: inv.id, bolt11, checkoutLink: inv.checkoutLink };
}

module.exports = {
    LSAT_PREFIX,
    profileDoc,
    createInvoiceOrder,
    attachInvoice,
    markPaid,
    redeemToken,
    getStatus,
    resolveToken,
    createBtcpayInvoice,
    DEFAULT_SATS,
    TTL_HOURS,
};
