// ============================================================================
// UMBRAXON KYA-Hub — Registration Quote + Pubkey Deny-List (Phase D)
// ----------------------------------------------------------------------------
// Strategic Sprint §31 D — A+B+D combo (NO custody, NO bond):
//   A) Tiered upfront pricing
//   B) Tiered re-registration multiplier  (3 ^ ban_count, capped at 9×)
//   D) Pubkey deny-list cooldown
//
// Operator policy (2026-05-12): hub holds NO bot funds. Every penalty is
// expressed as either reputation drop, CRL inclusion, or a one-shot upfront
// re-registration fee multiplier. There is no bond, no slashing of held
// collateral, and no refund mechanism.
//
// Public surface:
//   getMultiplier(banCount)
//   isOnDenyList(pool, pubkey)        — returns { active, row } where active === true
//                                       means the pubkey is BLOCKED from re-registering
//   getQuote(pool, { tier, pubkey })  — pure read; safe to call before payment
//   banPubkey(client, opts)           — within transaction; sets agents.status='BANNED',
//                                       inserts/upserts pubkey_deny_list row
//   unbanPubkey(client, pubkey, opts) — clears cleared_at on deny-list row but keeps
//                                       ban_count for next-time multiplier
//   listDenyList(pool, opts)          — admin paginated listing
// ============================================================================
'use strict';

const pricing = require('./pricing');

const CFG = {
    BAN_BASE: parseFloat(process.env.REREG_MULTIPLIER_BASE || '3'),
    BAN_CAP_EXP: parseInt(process.env.REREG_MULTIPLIER_CAP_EXP || '2', 10),  // 3^2 = 9 cap
    DEFAULT_BAN_DAYS_BASIC: parseInt(process.env.BAN_DAYS_BASIC || '30', 10),
    DEFAULT_BAN_DAYS_ELITE: parseInt(process.env.BAN_DAYS_ELITE || '90', 10),
    REPUTATION_DROP_ON_BAN: parseInt(process.env.BAN_REPUTATION_DROP || '500', 10),
};

function normalisePubkey(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    if (!/^[0-9a-f]{64,130}$/.test(trimmed)) return null;
    return trimmed;
}

/**
 * Re-registration multiplier:
 *   ban_count = 0  → 1×
 *   ban_count = 1  → 3×
 *   ban_count ≥ 2  → 9× (capped, exponent CFG.BAN_CAP_EXP)
 */
function getMultiplier(banCount) {
    const n = Math.max(0, Number.isFinite(banCount) ? Math.floor(banCount) : 0);
    if (n === 0) return 1;
    const exp = Math.min(n, CFG.BAN_CAP_EXP);
    return Math.pow(CFG.BAN_BASE, exp);
}

/**
 * Lookup the deny-list row for a pubkey. Returns:
 *   { active: bool, ban_count: int, expires_at: Date|null, cleared_at: Date|null,
 *     row: <raw row or null> }
 *
 * "active" means the deny-list is currently BLOCKING re-registration:
 *   - row exists
 *   - cleared_at IS NULL
 *   - expires_at > NOW()
 *
 * ban_count is always returned (even if cleared/expired) so callers can compute
 * the multiplier for the next registration.
 */
async function isOnDenyList(pool, rawPubkey) {
    const pubkey = normalisePubkey(rawPubkey);
    if (!pubkey) return { active: false, ban_count: 0, expires_at: null, cleared_at: null, row: null, pubkey: null };

    const r = await pool.query(
        `SELECT pubkey_hex, ban_count, expires_at, cleared_at, added_at, reason, last_kya_id
         FROM pubkey_deny_list WHERE pubkey_hex = $1`,
        [pubkey]
    );
    if (r.rowCount === 0) return { active: false, ban_count: 0, expires_at: null, cleared_at: null, row: null, pubkey };

    const row = r.rows[0];
    const now = Date.now();
    const expMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    const active = !row.cleared_at && expMs > now;
    return {
        active,
        ban_count: row.ban_count,
        expires_at: row.expires_at,
        cleared_at: row.cleared_at,
        row,
        pubkey,
    };
}

/**
 * Read-only price quote. Safe to call before any payment.
 *
 * @returns {object}
 *   { tier, base_price_sats, multiplier, total_price_sats, ban_count,
 *     deny_listed_until, deny_listed, grade, requires_anchor, base_reputation }
 *
 * If the pubkey is currently deny-listed (active), `deny_listed: true` and the
 * caller MUST refuse to start a registration (server.js returns 409 Conflict).
 */
async function getQuote(pool, { tier, pubkey }) {
    const tierName = (tier || '').toString().toUpperCase();
    if (tierName !== 'BASIC' && tierName !== 'ELITE') {
        return { error: 'INVALID_TIER', message: 'tier must be BASIC or ELITE' };
    }

    const tierInfo = pricing.getTier(tierName);
    if (!tierInfo) return { error: 'TIER_NOT_AVAILABLE' };
    const basePrice = tierInfo.amount_sats;

    let banCount = 0;
    let denyListed = false;
    let denyListedUntil = null;
    let lookup = null;

    if (pubkey) {
        lookup = await isOnDenyList(pool, pubkey);
        banCount = lookup.ban_count;
        denyListed = lookup.active;
        denyListedUntil = lookup.active ? lookup.expires_at : null;
    }

    const multiplier = getMultiplier(banCount);
    const totalPrice = basePrice * multiplier;

    return {
        tier: tierName,
        base_price_sats: basePrice,
        multiplier,
        total_price_sats: totalPrice,
        ban_count: banCount,
        deny_listed: denyListed,
        deny_listed_until: denyListedUntil,
        grade: tierInfo.grade,
        requires_anchor: !!tierInfo.requires_anchor,
        base_reputation: tierInfo.base_reputation,
        // Transparency: explicit no-custody disclaimer for bot SDKs / docs.
        custody: 'NONE',
        notice: 'Upfront payment only. No bond / no refund. Re-registration after a ban costs 3× (first re-reg) or 9× (cap) the base price.',
    };
}

/**
 * Insert / upsert a deny-list row for this pubkey. Must run inside a
 * transaction (caller passes pg.PoolClient). Increments ban_count if a row
 * already exists.
 *
 * @returns { ban_count, expires_at }
 */
async function _upsertDenyList(client, { pubkey, expiresAt, reason, evidenceHash, addedBy, lastKyaId }) {
    const existing = await client.query(
        `SELECT pubkey_hex, ban_count FROM pubkey_deny_list WHERE pubkey_hex = $1 FOR UPDATE`,
        [pubkey]
    );
    if (existing.rowCount === 0) {
        const ins = await client.query(
            `INSERT INTO pubkey_deny_list (pubkey_hex, expires_at, ban_count, reason,
                                           evidence_hash, added_by, last_kya_id, cleared_at)
             VALUES ($1, $2, 1, $3, $4, $5, $6, NULL)
             RETURNING ban_count, expires_at`,
            [pubkey, expiresAt, reason || null, evidenceHash || null, addedBy || 'system', lastKyaId || null]
        );
        return ins.rows[0];
    } else {
        const upd = await client.query(
            `UPDATE pubkey_deny_list
                SET ban_count = ban_count + 1,
                    expires_at = GREATEST($2::timestamptz, expires_at),
                    cleared_at = NULL,
                    cleared_by = NULL,
                    cleared_reason = NULL,
                    reason = COALESCE($3, reason),
                    evidence_hash = COALESCE($4, evidence_hash),
                    added_by = COALESCE($5, added_by),
                    last_kya_id = COALESCE($6, last_kya_id),
                    added_at = now()
              WHERE pubkey_hex = $1
              RETURNING ban_count, expires_at`,
            [pubkey, expiresAt, reason || null, evidenceHash || null, addedBy || 'system', lastKyaId || null]
        );
        return upd.rows[0];
    }
}

/**
 * Ban an agent — TX-aware. Atomically:
 *   1. SET agents.status='BANNED', pubkey_blacklisted=TRUE
 *   2. Upsert pubkey_deny_list with cooldown
 *   3. Drop reputation by REPUTATION_DROP_ON_BAN
 *
 * CRL inclusion is handled separately by lib/crl.js — the caller should
 * invoke crl.revokeCert(...) right after this. We deliberately do NOT
 * couple them tighter here so admin restore (unban) can leave CRL alone.
 *
 * @param {pg.PoolClient} client — must be in a transaction
 * @param {object} opts
 *   - kya_id            (required)
 *   - reason            (required, short text)
 *   - evidence_hash?    (sha256 hex; appears on whitepaper / public disclosures)
 *   - ban_duration_days?  (overrides tier default)
 *   - admin_user?
 *
 * @returns { kya_id, pubkey, ban_count, expires_at, reputation_before, reputation_after }
 */
async function banAgent(client, { kya_id, reason, evidence_hash, ban_duration_days, admin_user }) {
    if (!kya_id) throw new Error('kya_id required');
    if (!reason) throw new Error('reason required');

    const ag = await client.query(
        `SELECT id, kya_id, agent_pubkey, tier, status, reputation_score
         FROM agents WHERE kya_id = $1 FOR UPDATE`,
        [kya_id]
    );
    if (ag.rowCount === 0) throw new Error(`AGENT_NOT_FOUND: ${kya_id}`);
    const a = ag.rows[0];

    if (!a.agent_pubkey) throw new Error('AGENT_HAS_NO_PUBKEY (cannot deny-list)');

    const pubkey = normalisePubkey(a.agent_pubkey);
    if (!pubkey) throw new Error('AGENT_PUBKEY_INVALID');

    const days = ban_duration_days != null
        ? Math.max(1, parseInt(ban_duration_days, 10))
        : (a.tier === 'ELITE' ? CFG.DEFAULT_BAN_DAYS_ELITE : CFG.DEFAULT_BAN_DAYS_BASIC);
    const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);

    // 1. Update agent
    const repBefore = a.reputation_score;
    const repAfter = Math.max(0, repBefore - CFG.REPUTATION_DROP_ON_BAN);
    await client.query(
        `UPDATE agents
            SET status = 'BANNED',
                pubkey_blacklisted = TRUE,
                reputation_score = $2,
                last_score_change_at = NOW(),
                revoked_at = COALESCE(revoked_at, NOW()),
                revoke_reason = COALESCE(revoke_reason, $3)
          WHERE id = $1`,
        [a.id, repAfter, reason]
    );

    // 2. Upsert deny-list
    const dlRow = await _upsertDenyList(client, {
        pubkey,
        expiresAt,
        reason,
        evidenceHash: evidence_hash || null,
        addedBy: admin_user || 'admin',
        lastKyaId: kya_id,
    });

    // 3. Audit row in reputation_events (so /agent/:kya_id history shows it).
    await client.query(
        `INSERT INTO reputation_events (agent_id, kya_id, event_type, source, delta,
                                        score_before, score_after, reason, admin_user)
         VALUES ($1, $2, 'ADMIN_BAN', 'admin', $3, $4, $5, $6, $7)`,
        [a.id, kya_id, repAfter - repBefore, repBefore, repAfter,
         `BAN: ${reason} (deny-list ${days}d, ban_count=${dlRow.ban_count})`,
         admin_user || 'admin']
    );

    return {
        kya_id,
        pubkey,
        ban_count: dlRow.ban_count,
        expires_at: dlRow.expires_at,
        reputation_before: repBefore,
        reputation_after: repAfter,
        ban_duration_days: days,
    };
}

/**
 * Unban: clears the active deny-list cooldown BUT keeps the lifetime
 * ban_count (so the next ban still triples / caps at 9× as expected).
 *
 * Note: does NOT auto-restore agent.status — that is operator's call.
 * Use the existing /api/admin/agent/:kya_id/restore endpoint for reputation.
 *
 * @returns { cleared: bool, ban_count, pubkey }
 */
async function unbanPubkey(client, rawPubkey, { admin_user, reason }) {
    const pubkey = normalisePubkey(rawPubkey);
    if (!pubkey) throw new Error('INVALID_PUBKEY');

    const r = await client.query(
        `UPDATE pubkey_deny_list
            SET cleared_at = NOW(), cleared_by = $2, cleared_reason = $3
          WHERE pubkey_hex = $1 AND cleared_at IS NULL
        RETURNING pubkey_hex, ban_count`,
        [pubkey, admin_user || 'admin', reason || null]
    );
    if (r.rowCount === 0) return { cleared: false, pubkey, ban_count: 0 };
    return { cleared: true, pubkey, ban_count: r.rows[0].ban_count };
}

/**
 * Admin listing (paginated, latest first).
 */
async function listDenyList(pool, { limit = 100, offset = 0, only_active = false } = {}) {
    const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const where = only_active ? 'WHERE cleared_at IS NULL AND expires_at > NOW()' : '';
    const r = await pool.query(
        `SELECT pubkey_hex, added_at, expires_at, ban_count, reason, evidence_hash,
                added_by, last_kya_id, cleared_at, cleared_by, cleared_reason,
                (cleared_at IS NULL AND expires_at > NOW()) AS active
         FROM pubkey_deny_list
         ${where}
         ORDER BY added_at DESC
         LIMIT $1 OFFSET $2`,
        [lim, off]
    );
    const total = await pool.query(
        `SELECT COUNT(*)::int AS c FROM pubkey_deny_list ${where}`);
    return {
        items: r.rows,
        total: total.rows[0].c,
        limit: lim,
        offset: off,
    };
}

module.exports = {
    CFG,
    normalisePubkey,
    getMultiplier,
    isOnDenyList,
    getQuote,
    banAgent,
    unbanPubkey,
    listDenyList,
    _upsertDenyList,
};
