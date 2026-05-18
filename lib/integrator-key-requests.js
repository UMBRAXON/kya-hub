// ============================================================================
// UMBRAXON KYA-Hub — Integrator API key request queue (self-serve → admin approve)
// ============================================================================

const developerApiKeys = require('./developer-api-keys');
const developerApiAuth = require('./developer-api-auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ORG = 128;
const MAX_EMAIL = 256;
const MAX_USE_CASE = 4000;
const MAX_WEBSITE = 256;
const MAX_PENDING_PER_IP_24H = parseInt(process.env.INTEGRATOR_KEY_REQ_MAX_PER_IP_DAY || '3', 10);

function validateSubmit(body) {
    const organization = String(body.organization || '').trim();
    const contact_email = String(body.contact_email || '').trim().toLowerCase();
    const use_case = String(body.use_case || '').trim();
    const website = String(body.website || '').trim();
    if (!organization || organization.length > MAX_ORG) {
        return { ok: false, error: 'INVALID_ORGANIZATION' };
    }
    if (!EMAIL_RE.test(contact_email) || contact_email.length > MAX_EMAIL) {
        return { ok: false, error: 'INVALID_EMAIL' };
    }
    if (use_case.length < 20 || use_case.length > MAX_USE_CASE) {
        return { ok: false, error: 'INVALID_USE_CASE' };
    }
    if (website && website.length > MAX_WEBSITE) {
        return { ok: false, error: 'INVALID_WEBSITE' };
    }
    return { ok: true, data: { organization, contact_email, use_case, website: website || null } };
}

/**
 * @param {import('pg').Pool} pool
 */
async function countRecentByIp(pool, clientIp) {
    if (!clientIp) return 0;
    const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM integrator_key_requests
         WHERE client_ip = $1::inet AND created_at > NOW() - INTERVAL '24 hours'`,
        [clientIp]
    );
    return r.rows[0].n || 0;
}

async function submit(pool, { organization, contact_email, use_case, website, client_ip }) {
    const r = await pool.query(
        `INSERT INTO integrator_key_requests (organization, contact_email, use_case, website, client_ip)
         VALUES ($1, $2, $3, $4, $5::inet)
         RETURNING id, status, created_at`,
        [organization, contact_email, use_case, website, client_ip || null]
    );
    return r.rows[0];
}

async function list(pool, { status, limit = 50 } = {}) {
    const params = [];
    let where = '';
    if (status) {
        params.push(status);
        where = `WHERE status = $1`;
    }
    params.push(Math.min(Math.max(limit, 1), 200));
    const lim = params.length;
    const r = await pool.query(
        `SELECT id, organization, contact_email, use_case, website, status,
                approved_key_id, created_at, reviewed_at, admin_notes
         FROM integrator_key_requests ${where}
         ORDER BY created_at DESC
         LIMIT $${lim}`,
        params
    );
    return r.rows;
}

async function approve(pool, id, { tier, label, admin_notes, admin_user }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const req = await client.query(
            `SELECT * FROM integrator_key_requests WHERE id = $1 FOR UPDATE`,
            [id]
        );
        if (req.rowCount === 0) {
            await client.query('ROLLBACK');
            return { error: 'NOT_FOUND', status: 404 };
        }
        const row = req.rows[0];
        if (row.status !== 'pending') {
            await client.query('ROLLBACK');
            return { error: 'ALREADY_REVIEWED', status: 409 };
        }
        const tierName = developerApiKeys.ALLOWED_TIERS.has(tier) ? tier : 'free';
        const rate = developerApiKeys.tierDefaultRate(tierName);
        const scopes = developerApiKeys.sanitizeScopes(['agents:read']);
        const { raw, prefix, hash } = developerApiAuth.generateApiKey();
        const keyIns = await client.query(
            `INSERT INTO developer_api_keys
                (key_prefix, key_hash, label, owner_contact, scopes, tier, rate_limit_per_min)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, key_prefix, tier`,
            [
                prefix,
                hash,
                (label || `integrator:${row.organization}`).slice(0, 128),
                row.contact_email,
                scopes,
                tierName,
                rate,
            ]
        );
        const keyRow = keyIns.rows[0];
        await client.query(
            `UPDATE integrator_key_requests
             SET status = 'approved', approved_key_id = $2, reviewed_at = CURRENT_TIMESTAMP,
                 admin_notes = COALESCE($3, admin_notes)
             WHERE id = $1`,
            [id, keyRow.id, admin_notes || null]
        );
        await client.query('COMMIT');
        return {
            status: 200,
            request_id: id,
            api_key: raw,
            key_prefix: keyRow.key_prefix,
            tier: keyRow.tier,
            warning: 'Store api_key securely — it is shown only once.',
            reviewed_by: admin_user || 'admin',
        };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function reject(pool, id, { admin_notes }) {
    const r = await pool.query(
        `UPDATE integrator_key_requests
         SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, admin_notes = $2
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [id, admin_notes || null]
    );
    if (r.rowCount === 0) return { error: 'NOT_FOUND_OR_REVIEWED', status: 404 };
    return { ok: true, id };
}

module.exports = {
    validateSubmit,
    countRecentByIp,
    MAX_PENDING_PER_IP_24H,
    submit,
    list,
    approve,
    reject,
};
