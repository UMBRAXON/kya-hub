// ============================================================================
// UMBRAXON KYA-Hub — Sponsor invites (PoW bypass, payment + signatures remain)
// ============================================================================
'use strict';

const crypto = require('crypto');
const hubkeys = require('./hubkeys');

const PUBKEY_RE = /^[0-9a-f]{64}$/i;
const AGENT_NAME_RE = /^[A-Za-z0-9._-]{3,64}$/;
const INVITE_ID_RE = /^SINV-[0-9a-f]{24}$/i;

const CFG = {
    ENABLED: String(process.env.SPONSOR_INVITE_ENABLED || 'false').toLowerCase() === 'true',
    AGENT_MIN_REPUTATION: parseInt(process.env.SPONSOR_AGENT_MIN_REPUTATION || '700', 10),
    AGENT_INVITES_PER_MONTH: parseInt(process.env.SPONSOR_AGENT_INVITES_PER_MONTH || '5', 10),
    TTL_HOURS_DEFAULT: parseInt(process.env.SPONSOR_INVITE_TTL_HOURS_DEFAULT || '72', 10),
    TTL_HOURS_MAX: parseInt(process.env.SPONSOR_INVITE_TTL_HOURS_MAX || '168', 10),
    MAX_VIOLATIONS_30D: parseInt(process.env.SPONSOR_MAX_VIOLATIONS_PER_30D || '3', 10),
    PENALTY_REPUTATION: parseInt(process.env.SPONSOR_PENALTY_REPUTATION || '25', 10),
    SUSPEND_DAYS: parseInt(process.env.SPONSOR_INVITE_SUSPEND_DAYS || '30', 10),
    MFR_INVITES: {
        BRONZE: parseInt(process.env.SPONSOR_MFR_INVITES_BRONZE_PER_MONTH || '10', 10),
        SILVER: parseInt(process.env.SPONSOR_MFR_INVITES_SILVER_PER_MONTH || '20', 10),
        GOLD: parseInt(process.env.SPONSOR_MFR_INVITES_GOLD_PER_MONTH || '50', 10),
    },
    MFR_ALLOWLIST: (process.env.SPONSOR_MFR_ALLOWLIST || '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    AGENT_ALLOWLIST: (process.env.SPONSOR_AGENT_ALLOWLIST || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
};

function isEnabled() {
    return CFG.ENABLED;
}

function currentMonthKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function mfrMonthlyQuota(tier) {
    const t = (tier || 'BRONZE').toUpperCase();
    return CFG.MFR_INVITES[t] || CFG.MFR_INVITES.BRONZE;
}

function buildInviteCanonicalPayload(body) {
    return JSON.stringify({
        kind: 'sponsor_invite',
        nonce: String(body.nonce),
        timestamp: String(body.timestamp),
        invitee_pubkey: String(body.invitee_pubkey).toLowerCase(),
        tier_requested: String(body.tier_requested).toUpperCase(),
        expected_agent_name: body.expected_agent_name || null,
        ttl_hours: body.ttl_hours != null ? Number(body.ttl_hours) : CFG.TTL_HOURS_DEFAULT,
    });
}

function manifestHashFromString(str) {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function verifySponsorActionSignature(pubkeyHex, signatureHex, body) {
    const canonical = buildInviteCanonicalPayload(body);
    const hashBuf = Buffer.from(manifestHashFromString(canonical), 'hex');
    return hubkeys.verify(hashBuf, signatureHex, pubkeyHex.toLowerCase());
}

async function getAgentSponsorRow(pool, kya_id) {
    const r = await pool.query(
        `SELECT kya_id, tier, status, anchor_status, reputation_score, agent_pubkey,
                sponsor_invites_issued_month, sponsor_invites_issued_count,
                sponsor_invite_suspended_until
           FROM agents WHERE kya_id = $1`,
        [kya_id]
    );
    return r.rowCount ? r.rows[0] : null;
}

async function checkAgentSponsorEligible(pool, agent) {
    if (!agent) return { ok: false, error: 'SPONSOR_NOT_FOUND' };
    if (CFG.AGENT_ALLOWLIST.length && !CFG.AGENT_ALLOWLIST.includes(agent.kya_id)) {
        return { ok: false, error: 'SPONSOR_NOT_ALLOWLISTED' };
    }
    if (agent.sponsor_invite_suspended_until && new Date(agent.sponsor_invite_suspended_until) > new Date()) {
        return { ok: false, error: 'SPONSOR_INVITE_SUSPENDED', until: agent.sponsor_invite_suspended_until };
    }
    if (agent.tier !== 'ELITE') return { ok: false, error: 'SPONSOR_NOT_ELITE' };
    if (agent.status !== 'VERIFIED') return { ok: false, error: 'SPONSOR_NOT_VERIFIED' };
    if (agent.anchor_status !== 'ANCHORED') return { ok: false, error: 'SPONSOR_NOT_ANCHORED' };
    if ((agent.reputation_score || 0) < CFG.AGENT_MIN_REPUTATION) {
        return { ok: false, error: 'SPONSOR_REPUTATION_TOO_LOW', min: CFG.AGENT_MIN_REPUTATION };
    }
    const month = currentMonthKey();
    let count = agent.sponsor_invites_issued_count || 0;
    if (agent.sponsor_invites_issued_month !== month) count = 0;
    if (count >= CFG.AGENT_INVITES_PER_MONTH) {
        return { ok: false, error: 'SPONSOR_QUOTA_EXCEEDED', limit: CFG.AGENT_INVITES_PER_MONTH };
    }
    return { ok: true, remaining: CFG.AGENT_INVITES_PER_MONTH - count - 1, month, count };
}

async function countMfrInvitesThisMonth(pool, manufacturerDbId) {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM sponsor_invites
          WHERE sponsor_manufacturer_id = $1
            AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)`,
        [manufacturerDbId]
    );
    return r.rows[0].c;
}

async function checkManufacturerSponsorEligible(pool, mfr) {
    if (!mfr) return { ok: false, error: 'MANUFACTURER_NOT_FOUND' };
    if (CFG.MFR_ALLOWLIST.length && !CFG.MFR_ALLOWLIST.includes(mfr.manufacturer_id)) {
        return { ok: false, error: 'SPONSOR_NOT_ALLOWLISTED' };
    }
    if (mfr.status !== 'VERIFIED') return { ok: false, error: 'MANUFACTURER_NOT_VERIFIED' };
    const limit = mfrMonthlyQuota(mfr.tier);
    const used = await countMfrInvitesThisMonth(pool, mfr.id);
    if (used >= limit) {
        return { ok: false, error: 'SPONSOR_QUOTA_EXCEEDED', limit, used };
    }
    return { ok: true, remaining: limit - used - 1, limit, used };
}

/**
 * Create invite (agent sponsor). Caller verified Ed25519 on route.
 */
async function createAgentInvite(pool, {
    sponsorKyaId,
    inviteePubkey,
    tierRequested,
    expectedAgentName,
    ttlHours,
    clientIp,
}) {
    if (!isEnabled()) return { ok: false, status: 503, error: 'SPONSOR_INVITE_DISABLED' };

    const pubkey = String(inviteePubkey || '').toLowerCase();
    if (!PUBKEY_RE.test(pubkey)) return { ok: false, status: 400, error: 'INVALID_INVITEE_PUBKEY' };
    const tier = String(tierRequested || '').toUpperCase();
    if (tier !== 'BASIC' && tier !== 'ELITE') return { ok: false, status: 400, error: 'INVALID_TIER' };
    if (expectedAgentName && !AGENT_NAME_RE.test(expectedAgentName)) {
        return { ok: false, status: 400, error: 'INVALID_EXPECTED_AGENT_NAME' };
    }

    const agent = await getAgentSponsorRow(pool, sponsorKyaId);
    const elig = await checkAgentSponsorEligible(pool, agent);
    if (!elig.ok) return { ok: false, status: 403, ...elig };

    const ttl = Math.min(
        Math.max(parseInt(ttlHours || CFG.TTL_HOURS_DEFAULT, 10), 1),
        CFG.TTL_HOURS_MAX
    );
    const inviteId = 'SINV-' + crypto.randomBytes(12).toString('hex');
    const expiresAt = new Date(Date.now() + ttl * 3600 * 1000);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO sponsor_invites (
                invite_id, sponsor_kind, sponsor_agent_kya_id,
                invitee_pubkey, expected_agent_name, tier_requested,
                status, expires_at, client_ip
             ) VALUES ($1, 'AGENT', $2, $3, $4, $5, 'PENDING', $6, $7)`,
            [inviteId, sponsorKyaId, pubkey, expectedAgentName || null, tier, expiresAt, clientIp || null]
        );
        const month = elig.month;
        await client.query(
            `UPDATE agents SET
                sponsor_invites_issued_month = $2,
                sponsor_invites_issued_count = CASE
                    WHEN sponsor_invites_issued_month = $2 THEN sponsor_invites_issued_count + 1
                    ELSE 1 END
             WHERE kya_id = $1`,
            [sponsorKyaId, month]
        );
        await client.query(
            `INSERT INTO sponsor_invite_events (invite_id, event_type, metadata)
             VALUES ($1, 'ISSUED', $2)`,
            [inviteId, JSON.stringify({ sponsor_kya_id: sponsorKyaId, tier })]
        );
        await client.query('COMMIT');
        return {
            ok: true,
            status: 201,
            invite_id: inviteId,
            expires_at: expiresAt.toISOString(),
            tier_requested: tier,
            pow_bypass: true,
            remaining_quota_this_month: elig.remaining,
        };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Validate invite for PoW bypass (register gate). Does not consume.
 */
async function validateForPowBypass(pool, { inviteId, inviteePubkey, tierRequested, agentName }) {
    if (!isEnabled()) return { ok: false, reason: 'SPONSOR_INVITE_DISABLED' };
    if (!inviteId || !INVITE_ID_RE.test(inviteId)) return { ok: false, reason: 'INVALID_INVITE_ID' };

    const pubkey = String(inviteePubkey || '').toLowerCase();
    if (!PUBKEY_RE.test(pubkey)) return { ok: false, reason: 'INVALID_PUBKEY' };

    const r = await pool.query(
        `SELECT * FROM sponsor_invites WHERE invite_id = $1`,
        [inviteId]
    );
    if (r.rowCount === 0) return { ok: false, reason: 'INVITE_NOT_FOUND' };
    const inv = r.rows[0];

    if (inv.status === 'REVOKED') return { ok: false, reason: 'INVITE_REVOKED' };
    if (inv.status === 'CONSUMED') return { ok: false, reason: 'INVITE_ALREADY_CONSUMED' };
    if (inv.status === 'EXPIRED' || new Date(inv.expires_at) < new Date()) {
        if (inv.status === 'PENDING') {
            await pool.query(
                `UPDATE sponsor_invites SET status = 'EXPIRED', updated_at = NOW() WHERE invite_id = $1`,
                [inviteId]
            );
        }
        return { ok: false, reason: 'INVITE_EXPIRED' };
    }

    if (inv.invitee_pubkey !== pubkey) return { ok: false, reason: 'INVITE_PUBKEY_MISMATCH' };
    const tier = String(tierRequested || '').toUpperCase();
    if (tier !== inv.tier_requested) return { ok: false, reason: 'INVITE_TIER_MISMATCH' };
    if (inv.expected_agent_name && agentName && inv.expected_agent_name !== agentName) {
        return { ok: false, reason: 'INVITE_AGENT_NAME_MISMATCH' };
    }

    return {
        ok: true,
        invite_id: inviteId,
        sponsor_kind: inv.sponsor_kind,
        sponsor_agent_kya_id: inv.sponsor_agent_kya_id,
        sponsor_manufacturer_ext_id: inv.sponsor_manufacturer_ext_id,
    };
}

/**
 * Mark invite consumed when registration_intent is created.
 */
async function markConsumed(pool, {
    inviteId,
    inviteePubkey,
    tierRequested,
    registrationIntentId,
    agentName,
}) {
    const tierRow = await pool.query(
        `SELECT tier_requested FROM sponsor_invites WHERE invite_id = $1`,
        [inviteId]
    );
    const tier = tierRequested || tierRow.rows[0]?.tier_requested;
    const v2 = await validateForPowBypass(pool, { inviteId, inviteePubkey, tierRequested: tier, agentName });
    if (!v2.ok) return v2;

    const upd = await pool.query(
        `UPDATE sponsor_invites SET
            status = 'CONSUMED',
            consumed_at = NOW(),
            registration_intent_id = $2,
            updated_at = NOW()
         WHERE invite_id = $1 AND status = 'PENDING'`,
        [inviteId, registrationIntentId || null]
    );
    if (upd.rowCount === 0) return { ok: false, reason: 'INVITE_CONSUME_RACE' };

    await pool.query(
        `INSERT INTO sponsor_invite_events (invite_id, event_type, metadata)
         VALUES ($1, 'CONSUMED', $2)`,
        [inviteId, JSON.stringify({ registration_intent_id: registrationIntentId, agent_name: agentName })]
    );

    return { ok: true, ...v2 };
}

async function linkAgentAfterRegistration(pool, { inviteId, agentKyaId }) {
    if (!inviteId) return;
    const inv = await pool.query(
        `SELECT sponsor_agent_kya_id, sponsor_kind FROM sponsor_invites WHERE invite_id = $1`,
        [inviteId]
    );
    if (inv.rowCount === 0) return;
    const sponsoredBy = inv.rows[0].sponsor_agent_kya_id || null;
    await pool.query(
        `UPDATE sponsor_invites SET consumed_agent_kya_id = $2, updated_at = NOW() WHERE invite_id = $1`,
        [inviteId, agentKyaId]
    );
    await pool.query(
        `UPDATE agents SET sponsor_invite_id = $2, sponsored_by_kya_id = $3 WHERE kya_id = $1`,
        [agentKyaId, inviteId, sponsoredBy]
    );
}

async function getPublicStatus(pool, inviteId) {
    const r = await pool.query(
        `SELECT invite_id, status, tier_requested, expires_at, consumed_at,
                LEFT(invitee_pubkey, 8) AS pubkey_prefix
           FROM sponsor_invites WHERE invite_id = $1`,
        [inviteId]
    );
    if (r.rowCount === 0) return { error: 'INVITE_NOT_FOUND' };
    const row = r.rows[0];
    if (row.status === 'PENDING' && new Date(row.expires_at) < new Date()) {
        row.status = 'EXPIRED';
    }
    return {
        invite_id: row.invite_id,
        status: row.status,
        tier_requested: row.tier_requested,
        expires_at: row.expires_at,
        consumed_at: row.consumed_at,
        invitee_pubkey_prefix: row.pubkey_prefix,
        pow_bypass: row.status === 'PENDING',
    };
}

/**
 * Phase 2 hook: call when invited agent receives CRL/slash.
 */
async function recordInviteeViolation(pool, { agentKyaId, eventType, metadata }) {
    if (!isEnabled()) return;
    const a = await pool.query(
        `SELECT sponsor_invite_id, sponsored_by_kya_id FROM agents WHERE kya_id = $1`,
        [agentKyaId]
    );
    if (a.rowCount === 0 || !a.rows[0].sponsor_invite_id) return;

    const inviteId = a.rows[0].sponsor_invite_id;
    const sponsorKyaId = a.rows[0].sponsored_by_kya_id;

    await pool.query(
        `INSERT INTO sponsor_invite_events (invite_id, event_type, agent_kya_id, metadata)
         VALUES ($1, $2, $3, $4)`,
        [inviteId, eventType, agentKyaId, JSON.stringify(metadata || {})]
    );

    if (sponsorKyaId) {
        await pool.query(
            `UPDATE agents SET reputation_score = GREATEST(0, reputation_score - $2)
             WHERE kya_id = $1`,
            [sponsorKyaId, CFG.PENALTY_REPUTATION]
        );
        const violations = await pool.query(
            `SELECT COUNT(*)::int AS c FROM sponsor_invite_events
              WHERE invite_id IN (
                    SELECT invite_id FROM sponsor_invites WHERE sponsor_agent_kya_id = $1
                  )
                AND event_type IN ('INVITEE_CRL', 'INVITEE_SLASH')
                AND created_at > NOW() - INTERVAL '30 days'`,
            [sponsorKyaId]
        );
        if (violations.rows[0].c >= CFG.MAX_VIOLATIONS_30D) {
            await pool.query(
                `UPDATE agents SET sponsor_invite_suspended_until = NOW() + ($2::int * INTERVAL '1 day')
                 WHERE kya_id = $1`,
                [sponsorKyaId, CFG.SUSPEND_DAYS]
            );
            await pool.query(
                `INSERT INTO sponsor_invite_events (invite_id, event_type, metadata)
                 VALUES ($1, 'SPONSOR_SUSPENDED', $2)`,
                [inviteId, JSON.stringify({ sponsor_kya_id: sponsorKyaId, days: CFG.SUSPEND_DAYS })]
            );
        }
    }
}

function buildRegisterAdmissionMiddleware({ poolGetter, powGate, recordRejection }) {
    return async function registerAdmissionGate(req, res, next) {
        const inviteId = req.body?.sponsor_invite_id;
        if (!inviteId) {
            return powGate(req, res, next);
        }
        if (!isEnabled()) {
            if (recordRejection) recordRejection(req, 'SPONSOR_INVITE_DISABLED');
            return res.status(402).json({
                error: 'SPONSOR_INVITE_DISABLED',
                message: 'sponsor invites are disabled on this hub',
            });
        }
        const b = req.body || {};
        const pubkey = String(
            b.public_key ?? b.pubkey ?? b.agent_pubkey ?? b.manifest?.agent?.pubkey ?? ''
        ).toLowerCase();
        const tier = String(
            b.tier ?? b.tier_requested ?? b.manifest?.tier_requested ?? ''
        ).toUpperCase();
        const agentName = String(
            b.agent_name ?? b.agentName ?? b.manifest?.agent?.name ?? ''
        ).trim();

        const v = await validateForPowBypass(poolGetter(), {
            inviteId,
            inviteePubkey: pubkey,
            tierRequested: tier,
            agentName: agentName || undefined,
        });
        if (!v.ok) {
            if (recordRejection) recordRejection(req, v.reason);
            return res.status(402).json({ error: v.reason || 'INVALID_SPONSOR_INVITE' });
        }
        req.sponsor_invite_verified = v;
        res.setHeader('X-Pow-Bypass', 'sponsor-invite');
        return next();
    };
}

module.exports = {
    CFG,
    isEnabled,
    buildInviteCanonicalPayload,
    verifySponsorActionSignature,
    buildRegisterAdmissionMiddleware,
    createAgentInvite,
    validateForPowBypass,
    markConsumed,
    linkAgentAfterRegistration,
    getPublicStatus,
    recordInviteeViolation,
    checkAgentSponsorEligible,
};
