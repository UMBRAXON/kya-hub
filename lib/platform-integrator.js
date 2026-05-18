// ============================================================================
// UMBRAXON KYA-Hub — Integrator / plug-in read model (Platform API layer)
// ============================================================================
// Aggregates public agent + cert + reputation for third-party verify flows.
// Does not replace GET /api/cert/* — additive v1 surface for SDKs and plugins.
// ============================================================================

const reputation = require('./reputation');
const ttlCache = require('./ttl-cache');
const sandbox = require('./platform-integrator-sandbox');

const KYA_ID_RE = /^UMBRA-[A-F0-9]{6}$/;
const CACHE_TTL_MS = parseInt(process.env.INTEGRATOR_READ_CACHE_MS || '60000', 10);

function invalidKyaId(kya_id) {
    if (sandbox.isSandboxKyaId(kya_id)) return false;
    return !KYA_ID_RE.test(kya_id || '');
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} kya_id
 */
async function fetchAgentRow(pool, kya_id) {
    const r = await pool.query(
        `SELECT a.kya_id, a.agent_name, a.tier, a.conduct_grade, a.reputation_score,
                a.violations_count, a.total_slashed, a.is_active, a.status,
                a.manufacturer_id, a.manufacturer_verified,
                a.valid_until, a.last_heartbeat_at, a.heartbeat_count, a.is_dormant,
                a.suspended_at, a.retired_at, a.retire_reason, a.discovery_opt_in,
                a.agent_pubkey AS public_key,
                c.serial, c.issued_at AS cert_issued_at, c.valid_until AS cert_valid_until,
                c.revoked_at, c.revoke_reason, c.cert_body
         FROM agents a
         LEFT JOIN certificates c ON c.kya_id = a.kya_id AND c.is_current = TRUE
         WHERE a.kya_id = $1`,
        [kya_id]
    );
    return r.rowCount === 0 ? null : r.rows[0];
}

function livenessFromRow(a) {
    let daysSinceHeartbeat = null;
    let livenessStatus = 'NEVER_SEEN';
    if (a.last_heartbeat_at) {
        daysSinceHeartbeat = Math.floor(
            (Date.now() - new Date(a.last_heartbeat_at).getTime()) / (24 * 3600 * 1000)
        );
        if (daysSinceHeartbeat < reputation.INACTIVITY_DECAY.warnAfterDays) livenessStatus = 'ACTIVE';
        else if (daysSinceHeartbeat < reputation.INACTIVITY_DECAY.heavyAfterDays) livenessStatus = 'WARNING_DECAY';
        else if (daysSinceHeartbeat < reputation.INACTIVITY_DECAY.dormantAfterDays) livenessStatus = 'HEAVY_DECAY';
        else livenessStatus = 'DORMANT';
    }
    return {
        last_heartbeat_at: a.last_heartbeat_at,
        heartbeat_count: a.heartbeat_count || 0,
        days_since_heartbeat: daysSinceHeartbeat,
        is_dormant: !!a.is_dormant,
        status: livenessStatus,
    };
}

function trustSummary(row) {
    if (!row) return { verified: false, trust_level: 'UNKNOWN', reasons: ['AGENT_NOT_FOUND'] };
    const reasons = [];
    if (row.retired_at) {
        return { verified: false, trust_level: 'RETIRED', reasons: ['RETIRED'] };
    }
    if (!row.serial) {
        return { verified: false, trust_level: 'UNREGISTERED', reasons: ['NO_CERTIFICATE'] };
    }
    if (row.revoked_at) {
        return { verified: false, trust_level: 'REVOKED', reasons: ['CERT_REVOKED'] };
    }
    const expired = row.cert_valid_until && new Date(row.cert_valid_until) < new Date();
    if (expired) {
        return { verified: false, trust_level: 'EXPIRED', reasons: ['CERT_EXPIRED'] };
    }
    if (row.suspended_at) reasons.push('SUSPENDED');
    if (!row.is_active) reasons.push('INACTIVE');
    if (row.status !== 'VERIFIED') reasons.push(`STATUS_${row.status}`);
    const verified =
        reasons.length === 0 &&
        row.is_active &&
        row.status === 'VERIFIED';
    return {
        verified,
        trust_level: verified ? 'TRUSTED' : 'LIMITED',
        reasons: reasons.length ? reasons : undefined,
    };
}

/**
 * Full integrator view (cached).
 * @param {import('pg').Pool} pool
 * @param {string} kya_id
 * @param {{ skipCache?: boolean }} [opts]
 */
async function getAgentIntegratorView(pool, kya_id, opts = {}) {
    if (invalidKyaId(kya_id)) {
        return { error: 'INVALID_KYA_ID', status: 400 };
    }
    if (sandbox.isSandboxKyaId(kya_id)) {
        return sandbox.agentBody(kya_id);
    }
    const load = async () => {
        const row = await fetchAgentRow(pool, kya_id);
        if (!row) return { error: 'AGENT_NOT_FOUND', status: 404 };
        const trust = trustSummary(row);
        const repInfo = reputation.describe(row.reputation_score);
        const subject =
            row.cert_body &&
            row.cert_body.credentialSubject &&
            typeof row.cert_body.credentialSubject === 'object'
                ? row.cert_body.credentialSubject
                : null;
        return {
            status: 200,
            body: {
                api_version: '1.0',
                kya_id: row.kya_id,
                agent_name: row.agent_name,
                tier: row.tier,
                grade: row.conduct_grade,
                agent_status: row.status,
                public_key: row.public_key,
                trust,
                reputation: repInfo,
                liveness: livenessFromRow(row),
                certificate: row.serial
                    ? {
                          serial: row.serial,
                          issued_at: row.cert_issued_at,
                          valid_until: row.cert_valid_until,
                          revoked_at: row.revoked_at,
                          revoke_reason: row.revoke_reason,
                      }
                    : null,
                integrations: {
                    discovery_opt_in: !!row.discovery_opt_in,
                },
                payment_hints: subject && Array.isArray(subject.payment_hints)
                    ? subject.payment_hints
                    : [],
                links: {
                    cert: `/api/cert/${row.kya_id}`,
                    cert_status: `/api/cert/${row.kya_id}/status`,
                    reputation: `/api/agent/${row.kya_id}/reputation`,
                    embed_badge: `/api/embed/badge/${row.kya_id}?format=svg`,
                },
            },
        };
    };
    if (opts.skipCache) return load();
    return ttlCache.getOrLoad(`integrator:agent:${kya_id}`, load, CACHE_TTL_MS);
}

/**
 * Lightweight status for plug-in gate checks (cached).
 */
async function getAgentStatusGate(pool, kya_id, opts = {}) {
    if (invalidKyaId(kya_id)) {
        return { error: 'INVALID_KYA_ID', status: 400 };
    }
    if (sandbox.isSandboxKyaId(kya_id)) {
        return sandbox.statusBody(kya_id);
    }
    const load = async () => {
        const row = await fetchAgentRow(pool, kya_id);
        if (!row) return { error: 'AGENT_NOT_FOUND', status: 404 };
        const trust = trustSummary(row);
        return {
            status: 200,
            body: {
                kya_id: row.kya_id,
                agent_name: row.agent_name,
                verified: trust.verified,
                trust_level: trust.trust_level,
                reasons: trust.reasons,
                tier: row.tier,
                agent_status: row.status,
                serial: row.serial,
            },
            cert_body: opts.includeCertBody ? row.cert_body : undefined,
        };
    };
    if (opts.skipCache || opts.includeCertBody) return load();
    return ttlCache.getOrLoad(`integrator:status:${kya_id}`, load, CACHE_TTL_MS);
}

module.exports = {
    KYA_ID_RE,
    invalidKyaId,
    isSandboxKyaId: sandbox.isSandboxKyaId,
    getAgentIntegratorView,
    getAgentStatusGate,
    invalidateAgentCache: (kya_id) => {
        ttlCache.invalidate(`integrator:agent:${kya_id}`);
        ttlCache.invalidate(`integrator:status:${kya_id}`);
    },
};
