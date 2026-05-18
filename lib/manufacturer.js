// ============================================================================
// UMBRAXON KYA-Hub — Phase 4B / Manufacturer Onboarding Library
// ----------------------------------------------------------------------------
// Helpers for:
//   - registering a manufacturer (admin-gated CRUD)
//   - submitting + verifying manufacturer pre-attestations of agent manifests
//   - consuming an attestation during agent registration
//   - admin verify / suspend / revoke
//   - lookup helpers
//
// Signature scheme (consistent with existing manifest signing in server.js):
//   attestation = Ed25519_sign(sha256(canonical_manifest), mfr_priv)
//   verified by lookupByExtId(manufacturer_id) → pubkey_ed25519 → hubkeys.verify()
//
// The manifest is the EXACT same JSON the agent will later submit to
// /api/register/initiate. The mfr does NOT need access to KYA-Hub's signing
// keys — they sign their own commitment to "this manifest is mine".
// ============================================================================
'use strict';

const crypto = require('crypto');
const hubkeys = require('./hubkeys');
const manifestSchema = require('./manifest-schema');

const MFR_STATUS_ENUM = new Set(['PENDING', 'VERIFIED', 'SUSPENDED', 'REVOKED']);
const MFR_TIER_ENUM = new Set(['BRONZE', 'SILVER', 'GOLD']);

const TIER_DEFAULT_BONUS = {
    BRONZE: parseInt(process.env.MFR_BONUS_BRONZE || '25', 10),
    SILVER: parseInt(process.env.MFR_BONUS_SILVER || '50', 10),
    GOLD:   parseInt(process.env.MFR_BONUS_GOLD   || '100', 10),
};

const VALID_MFR_ID = /^[A-Z0-9_]{2,64}$/;
const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

// Phase 4B follow-up (SECURITY-AUDIT-2026-05-12 §3.6): hard-cap the variable-
// length fields that an attacker (compromised manufacturer) could otherwise
// inflate to fill the 100 KB Express body limit.
const MAX_METADATA_BYTES        = parseInt(process.env.MFR_MAX_METADATA_BYTES || '4096', 10);
const MAX_MANIFEST_META_BYTES   = parseInt(process.env.MFR_MAX_MANIFEST_META_BYTES || '4096', 10);

function _serializedSize(value) {
    if (value == null) return 0;
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// ----------------------------------------------------------------------------
// Per-manufacturer token bucket (SECURITY-AUDIT-2026-05-12 §3.5)
// ----------------------------------------------------------------------------
// In-memory rate limit keyed by manufacturer_id. Defends against a
// compromised-but-valid mfr key spamming the attestation table from many IPs
// (the express-rate-limit middleware is keyed by IP, not by mfr).
//
// Bucket is per-mfr, refilled continuously. Defaults are intentionally
// generous (60/hr BRONZE → 240/hr GOLD); tune via env:
//
//   MFR_ATTEST_RATE_BRONZE_PER_HR  (default 60)
//   MFR_ATTEST_RATE_SILVER_PER_HR  (default 120)
//   MFR_ATTEST_RATE_GOLD_PER_HR    (default 240)
//   MFR_ATTEST_RATE_DEFAULT_PER_HR (default 60)         // fallback / unknown tier
//
const _mfrBuckets = new Map(); // mfr_ext_id -> { tokens, lastRefillMs, capacity, refillPerMs }

function _tierRateLimit(tier) {
    const def = parseInt(process.env.MFR_ATTEST_RATE_DEFAULT_PER_HR || '60', 10);
    const map = {
        BRONZE: parseInt(process.env.MFR_ATTEST_RATE_BRONZE_PER_HR || '60', 10),
        SILVER: parseInt(process.env.MFR_ATTEST_RATE_SILVER_PER_HR || '120', 10),
        GOLD:   parseInt(process.env.MFR_ATTEST_RATE_GOLD_PER_HR   || '240', 10),
    };
    const v = map[(tier || '').toUpperCase()];
    return Number.isFinite(v) && v > 0 ? v : def;
}

/**
 * Try to consume one token from a manufacturer's bucket. Returns
 * { allowed: bool, retry_after_seconds, remaining, capacity }.
 * Buckets initialise lazily on first call.
 */
function _consumeMfrToken(mfr_ext_id, tier) {
    const capacity = _tierRateLimit(tier);
    const refillPerMs = capacity / (60 * 60 * 1000); // tokens per ms
    const now = Date.now();
    let b = _mfrBuckets.get(mfr_ext_id);
    if (!b || b.capacity !== capacity) {
        b = { tokens: capacity, lastRefillMs: now, capacity, refillPerMs };
        _mfrBuckets.set(mfr_ext_id, b);
    }
    // Refill
    const elapsed = now - b.lastRefillMs;
    if (elapsed > 0) {
        b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
        b.lastRefillMs = now;
    }
    if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true, remaining: Math.floor(b.tokens), capacity, retry_after_seconds: 0 };
    }
    const deficit = 1 - b.tokens;
    const retrySec = Math.ceil(deficit / (b.refillPerMs * 1000));
    return { allowed: false, remaining: 0, capacity, retry_after_seconds: retrySec };
}

function _resetMfrBucket(mfr_ext_id) {
    _mfrBuckets.delete(mfr_ext_id);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function tierBonusDefault(tier) {
    return TIER_DEFAULT_BONUS[tier] != null ? TIER_DEFAULT_BONUS[tier] : 50;
}

function serializeMfrPublic(row) {
    if (!row) return null;
    return {
        manufacturer_id: row.manufacturer_id,
        name: row.name,
        legal_entity: row.legal_entity || null,
        country: row.country || null,
        homepage: row.homepage || null,
        description: row.description || null,
        pubkey: row.pubkey_ed25519,
        status: row.status,
        tier: row.tier,
        rep_bonus: row.rep_bonus,
        verified_at: row.verified_at || null,
        suspended_at: row.suspended_at || null,
        revoked_at: row.revoked_at || null,
        attestation_count: row.attestation_count || 0,
        agent_count: row.agent_count || 0,
        created_at: row.created_at,
    };
}

function serializeMfrAdmin(row) {
    return {
        ...serializeMfrPublic(row),
        contact_email: row.contact_email || null,
        verified_by: row.verified_by || null,
        suspended_by: row.suspended_by || null,
        suspend_reason: row.suspend_reason || null,
        revoked_by: row.revoked_by || null,
        revoke_reason: row.revoke_reason || null,
        kyc_metadata: row.kyc_metadata || null,
        updated_at: row.updated_at,
    };
}

// ----------------------------------------------------------------------------
// Lookup
// ----------------------------------------------------------------------------
async function lookupByExtId(client, manufacturer_id) {
    if (!VALID_MFR_ID.test(manufacturer_id || '')) return null;
    const r = await client.query(
        `SELECT * FROM manufacturers WHERE manufacturer_id = $1`, [manufacturer_id]
    );
    return r.rowCount > 0 ? r.rows[0] : null;
}

async function lookupByPubkey(client, pubkey_ed25519) {
    if (!HEX64.test(pubkey_ed25519 || '')) return null;
    const r = await client.query(
        `SELECT * FROM manufacturers WHERE pubkey_ed25519 = $1`,
        [pubkey_ed25519.toLowerCase()]
    );
    return r.rowCount > 0 ? r.rows[0] : null;
}

async function listVerified(client, { limit = 100, offset = 0 } = {}) {
    const r = await client.query(
        `SELECT * FROM manufacturers
         WHERE status = 'VERIFIED'
         ORDER BY tier DESC, verified_at DESC NULLS LAST
         LIMIT $1 OFFSET $2`,
        [Math.min(limit, 500), offset]
    );
    const total = await client.query(
        `SELECT COUNT(*)::int AS c FROM manufacturers WHERE status = 'VERIFIED'`
    );
    return {
        count: r.rowCount,
        total: total.rows[0].c,
        limit, offset,
        manufacturers: r.rows.map(serializeMfrPublic),
    };
}

// ----------------------------------------------------------------------------
// Admin: register / verify / suspend / revoke
// ----------------------------------------------------------------------------
/**
 * Admin: register a new manufacturer in PENDING status. Caller (server.js)
 * already enforces admin auth.
 *
 * @param {pg.Pool | pg.PoolClient} client
 * @param {object} input
 *   - manufacturer_id (required, /^[A-Z0-9_]{2,64}$/)
 *   - name (required)
 *   - pubkey (required, 32B hex)
 *   - legal_entity, country, contact_email, homepage, description (optional)
 *   - tier (optional, default 'BRONZE'); admin can adjust later via verify
 *   - kyc_metadata (optional JSONB)
 *   - admin_user, client_ip (for audit)
 */
async function registerMfr(client, input) {
    const mid = (input.manufacturer_id || '').toUpperCase();
    if (!VALID_MFR_ID.test(mid)) return { error: 'INVALID_MANUFACTURER_ID', message: 'manufacturer_id must match ^[A-Z0-9_]{2,64}$' };
    const name = String(input.name || '').trim();
    if (name.length < 2 || name.length > 128) return { error: 'INVALID_NAME' };
    const pubkey = String(input.pubkey || '').toLowerCase();
    if (!HEX64.test(pubkey)) return { error: 'INVALID_PUBKEY', message: 'pubkey must be 32B hex (Ed25519)' };
    const tier = (input.tier || 'BRONZE').toUpperCase();
    if (!MFR_TIER_ENUM.has(tier)) return { error: 'INVALID_TIER' };

    // Pubkey uniqueness (separate from manufacturer_id uniqueness)
    const exPub = await lookupByPubkey(client, pubkey);
    if (exPub) return { error: 'PUBKEY_TAKEN', existing_manufacturer_id: exPub.manufacturer_id };
    const exMid = await lookupByExtId(client, mid);
    if (exMid) return { error: 'MANUFACTURER_ID_TAKEN', existing_pubkey: exMid.pubkey_ed25519 };

    try {
        const ins = await client.query(
            `INSERT INTO manufacturers (
                manufacturer_id, name, legal_entity, country, contact_email, homepage, description,
                pubkey_ed25519, status, tier, rep_bonus, kyc_metadata
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11)
            RETURNING *`,
            [
                mid, name, input.legal_entity || null, (input.country || '').toUpperCase() || null,
                input.contact_email || null, input.homepage || null, input.description || null,
                pubkey, tier, tierBonusDefault(tier),
                input.kyc_metadata ? JSON.stringify(input.kyc_metadata) : null,
            ]
        );
        return { ok: true, manufacturer: serializeMfrAdmin(ins.rows[0]) };
    } catch (e) {
        return { error: 'INSERT_FAIL' };
    }
}

async function verifyMfr(client, { manufacturer_id, admin_user, tier_override, kyc_metadata }) {
    const m = await lookupByExtId(client, manufacturer_id);
    if (!m) return { error: 'MANUFACTURER_NOT_FOUND' };
    if (m.status === 'REVOKED') return { error: 'IS_REVOKED' };
    const tier = tier_override ? String(tier_override).toUpperCase() : m.tier;
    if (!MFR_TIER_ENUM.has(tier)) return { error: 'INVALID_TIER' };
    const upd = await client.query(
        `UPDATE manufacturers
         SET status='VERIFIED', tier=$2, rep_bonus=$3,
             verified_at=CURRENT_TIMESTAMP, verified_by=$4,
             kyc_metadata = COALESCE($5::jsonb, kyc_metadata),
             suspended_at=NULL, suspended_by=NULL, suspend_reason=NULL
         WHERE id = $1
         RETURNING *`,
        [
            m.id, tier, tierBonusDefault(tier), admin_user || 'admin',
            kyc_metadata ? JSON.stringify(kyc_metadata) : null,
        ]
    );
    return { ok: true, manufacturer: serializeMfrAdmin(upd.rows[0]) };
}

async function suspendMfr(client, { manufacturer_id, admin_user, reason }) {
    const m = await lookupByExtId(client, manufacturer_id);
    if (!m) return { error: 'MANUFACTURER_NOT_FOUND' };
    const upd = await client.query(
        `UPDATE manufacturers
         SET status='SUSPENDED', suspended_at=CURRENT_TIMESTAMP, suspended_by=$2, suspend_reason=$3
         WHERE id = $1 RETURNING *`,
        [m.id, admin_user || 'admin', (reason || '').slice(0, 1000)]
    );
    return { ok: true, manufacturer: serializeMfrAdmin(upd.rows[0]) };
}

async function revokeMfr(client, { manufacturer_id, admin_user, reason }) {
    const m = await lookupByExtId(client, manufacturer_id);
    if (!m) return { error: 'MANUFACTURER_NOT_FOUND' };
    const upd = await client.query(
        `UPDATE manufacturers
         SET status='REVOKED', revoked_at=CURRENT_TIMESTAMP, revoked_by=$2, revoke_reason=$3
         WHERE id = $1 RETURNING *`,
        [m.id, admin_user || 'admin', (reason || '').slice(0, 1000)]
    );
    return { ok: true, manufacturer: serializeMfrAdmin(upd.rows[0]) };
}

// ----------------------------------------------------------------------------
// Public: submit attestation
// ----------------------------------------------------------------------------
/**
 * Manufacturer submits a signed attestation for an agent manifest. We:
 *   1. Lookup manufacturer by manufacturer_id
 *   2. Verify mfr_signature against sha256(canonical(manifest)) using mfr's pubkey
 *   3. INSERT manufacturer_attestations row (idempotent on (manufacturer_id, manifest_hash))
 *
 * @param {pg.Pool|pg.PoolClient} client
 * @param {object} input
 *   - manufacturer_id (required)
 *   - manifest (required) — full JSON, NOT just the hash, so we can re-derive hash
 *   - mfr_signature (required, 64B Ed25519 hex)
 *   - expected_agent_pubkey (optional pin)
 *   - expected_agent_name (optional pin)
 *   - attestation_metadata (optional JSONB)
 *   - expires_at (optional ISO string)
 */
async function submitAttestation(client, input) {
    const mid = (input.manufacturer_id || '').toUpperCase();
    const m = await lookupByExtId(client, mid);
    if (!m) return { error: 'MANUFACTURER_NOT_FOUND' };
    if (m.status !== 'VERIFIED') {
        return { error: 'MANUFACTURER_NOT_VERIFIED', status: m.status };
    }

    // Per-mfr token bucket (defense-in-depth on top of IP-keyed rate-limit).
    const bucket = _consumeMfrToken(mid, m.tier);
    if (!bucket.allowed) {
        return {
            error: 'MFR_RATE_LIMITED',
            message: `manufacturer ${mid} exceeded ${bucket.capacity} attestations/hour`,
            retry_after_seconds: bucket.retry_after_seconds,
            capacity_per_hour: bucket.capacity,
        };
    }

    const manifest = input.manifest;
    if (!manifest || typeof manifest !== 'object') return { error: 'MISSING_MANIFEST' };
    // Best-effort schema validation (manifest must at least parse as a v1 manifest)
    const v = manifestSchema.validate(manifest);
    if (!v.valid) return { error: 'MANIFEST_INVALID', validation_errors: v.errors };
    // Size caps — guard against compromised-mfr DB inflation attacks.
    if (_serializedSize(manifest.metadata) > MAX_MANIFEST_META_BYTES) {
        return {
            error: 'MANIFEST_METADATA_TOO_LARGE',
            message: `manifest.metadata exceeds ${MAX_MANIFEST_META_BYTES} bytes`,
            actual_bytes: _serializedSize(manifest.metadata),
            max_bytes: MAX_MANIFEST_META_BYTES,
        };
    }
    if (_serializedSize(input.attestation_metadata) > MAX_METADATA_BYTES) {
        return {
            error: 'ATTESTATION_METADATA_TOO_LARGE',
            message: `attestation_metadata exceeds ${MAX_METADATA_BYTES} bytes`,
            actual_bytes: _serializedSize(input.attestation_metadata),
            max_bytes: MAX_METADATA_BYTES,
        };
    }

    const manifestHashHex = manifestSchema.manifestHash(manifest);
    const sig = (input.mfr_signature || '').toLowerCase();
    if (!HEX128.test(sig)) return { error: 'INVALID_SIGNATURE_FORMAT' };

    const digestBuf = Buffer.from(manifestHashHex, 'hex');
    const ok = hubkeys.verify(digestBuf, sig, m.pubkey_ed25519);
    if (!ok) return { error: 'BAD_MFR_SIGNATURE' };

    const expectedPub = input.expected_agent_pubkey
        ? String(input.expected_agent_pubkey).toLowerCase() : null;
    if (expectedPub && !HEX64.test(expectedPub)) return { error: 'INVALID_EXPECTED_PUBKEY' };

    let expiresAt = null;
    if (input.expires_at) {
        const d = new Date(input.expires_at);
        if (!Number.isFinite(d.getTime())) return { error: 'INVALID_EXPIRES_AT' };
        expiresAt = d;
    }

    // Upsert (manufacturer_id, agent_manifest_hash)
    try {
        const r = await client.query(
            `INSERT INTO manufacturer_attestations (
                manufacturer_id, manufacturer_ext_id, agent_manifest_hash,
                expected_agent_pubkey, expected_agent_name, mfr_signature,
                attestation_metadata, expires_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (manufacturer_id, agent_manifest_hash) DO UPDATE
                SET mfr_signature = EXCLUDED.mfr_signature,
                    expected_agent_pubkey = COALESCE(EXCLUDED.expected_agent_pubkey, manufacturer_attestations.expected_agent_pubkey),
                    expected_agent_name = COALESCE(EXCLUDED.expected_agent_name, manufacturer_attestations.expected_agent_name),
                    attestation_metadata = COALESCE(EXCLUDED.attestation_metadata, manufacturer_attestations.attestation_metadata),
                    expires_at = COALESCE(EXCLUDED.expires_at, manufacturer_attestations.expires_at),
                    attested_at = NOW()
            RETURNING id, attested_at, agent_id IS NOT NULL AS consumed, revoked_at`,
            [
                m.id, m.manufacturer_id, manifestHashHex,
                expectedPub, input.expected_agent_name || null, sig,
                input.attestation_metadata ? JSON.stringify(input.attestation_metadata) : null,
                expiresAt,
            ]
        );
        // Bump counter
        await client.query(
            `UPDATE manufacturers SET attestation_count = attestation_count + 1 WHERE id = $1`,
            [m.id]
        );
        return {
            ok: true,
            attestation_id: Number(r.rows[0].id),
            manufacturer_id: m.manufacturer_id,
            manufacturer_pubkey: m.pubkey_ed25519,
            manifest_hash: manifestHashHex,
            attested_at: r.rows[0].attested_at,
            consumed: r.rows[0].consumed,
            revoked: !!r.rows[0].revoked_at,
        };
    } catch (e) {
        return { error: 'INSERT_FAIL' };
    }
}

// ----------------------------------------------------------------------------
// Internal: find usable attestation for a manifest at agent-registration time
// ----------------------------------------------------------------------------
/**
 * Called from the register flow. Returns the first usable attestation that:
 *   - Matches manifest_hash AND
 *   - Has not been consumed (agent_id IS NULL) AND
 *   - Has not been revoked AND
 *   - Has not expired AND
 *   - The mfr is currently VERIFIED AND
 *   - (if expected_agent_pubkey was pinned) matches the incoming pubkey AND
 *   - (if expected_agent_name pinned) matches the incoming agentName.
 *
 * If matches, returns the row (caller should then call markAttestationConsumed
 * with the agent_id in the same transaction).
 */
async function findUsableAttestation(client, { manifest_hash, agent_pubkey, agent_name }) {
    if (!HEX64.test(manifest_hash || '')) return null;
    const pub = (agent_pubkey || '').toLowerCase();
    const r = await client.query(
        `SELECT att.*,
                m.manufacturer_id AS mfr_ext_id, m.tier, m.rep_bonus, m.status AS mfr_status,
                m.pubkey_ed25519 AS mfr_pubkey
         FROM manufacturer_attestations att
         JOIN manufacturers m ON m.id = att.manufacturer_id
         WHERE att.agent_manifest_hash = $1
           AND att.agent_id IS NULL
           AND att.revoked_at IS NULL
           AND (att.expires_at IS NULL OR att.expires_at > NOW())
           AND m.status = 'VERIFIED'
         ORDER BY att.attested_at DESC
         LIMIT 5`,
        [manifest_hash]
    );
    for (const row of r.rows) {
        if (row.expected_agent_pubkey && pub && row.expected_agent_pubkey !== pub) continue;
        if (row.expected_agent_name && agent_name && row.expected_agent_name !== agent_name) continue;
        return row;
    }
    return null;
}

async function markAttestationConsumed(client, { attestation_id, agent_id }) {
    const r = await client.query(
        `UPDATE manufacturer_attestations
         SET agent_id = $2, consumed_at = NOW()
         WHERE id = $1 AND agent_id IS NULL AND revoked_at IS NULL
         RETURNING manufacturer_id`,
        [attestation_id, agent_id]
    );
    if (r.rowCount > 0) {
        await client.query(
            `UPDATE manufacturers SET agent_count = agent_count + 1 WHERE id = $1`,
            [r.rows[0].manufacturer_id]
        );
        return { ok: true };
    }
    return { ok: false, reason: 'already_consumed_or_revoked' };
}

// ----------------------------------------------------------------------------
// Public attestation revocation (mfr or admin)
// ----------------------------------------------------------------------------
async function revokeAttestation(client, { attestation_id, revoked_by, reason }) {
    const r = await client.query(
        `UPDATE manufacturer_attestations
         SET revoked_at = NOW(), revoked_by = $2, revoke_reason = $3
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING manufacturer_id, agent_id`,
        [attestation_id, revoked_by || 'admin', (reason || '').slice(0, 1000)]
    );
    return r.rowCount > 0 ? { ok: true, ...r.rows[0] } : { error: 'NOT_FOUND_OR_ALREADY_REVOKED' };
}

module.exports = {
    MFR_STATUS_ENUM,
    MFR_TIER_ENUM,
    TIER_DEFAULT_BONUS,
    tierBonusDefault,
    serializeMfrPublic,
    serializeMfrAdmin,
    lookupByExtId,
    lookupByPubkey,
    listVerified,
    registerMfr,
    verifyMfr,
    suspendMfr,
    revokeMfr,
    submitAttestation,
    findUsableAttestation,
    markAttestationConsumed,
    revokeAttestation,
    // Internals exposed for tests
    _consumeMfrToken,
    _resetMfrBucket,
    _tierRateLimit,
};
