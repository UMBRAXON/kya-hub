// ============================================================================
// Signed agent history export (compliance / partner audit pack)
// ============================================================================

'use strict';

const crypto = require('crypto');
const certs = require('./certs');
const hubkeys = require('./hubkeys');

/**
 * @param {import('pg').Pool} pool
 * @param {string} kya_id
 */
async function buildHistoryExport(pool, kya_id) {
    const agentR = await pool.query(
        `SELECT kya_id, agent_name, tier, status, reputation_score, conduct_grade,
                violations_count, created_at, discovery_opt_in, agent_pubkey,
                last_heartbeat_at, retired_at, retire_reason
         FROM agents WHERE kya_id = $1`,
        [kya_id],
    );
    if (agentR.rowCount === 0) return { error: 'AGENT_NOT_FOUND', status: 404 };

    const [certR, repR, rejR] = await Promise.all([
        pool.query(
            `SELECT serial, issued_at, valid_until, revoked_at, revoke_reason, is_current
             FROM certificates WHERE kya_id = $1 ORDER BY issued_at DESC LIMIT 20`,
            [kya_id],
        ),
        pool.query(
            `SELECT id, event_type, delta, score_after, reason, created_at
             FROM reputation_events WHERE kya_id = $1 ORDER BY created_at DESC LIMIT 100`,
            [kya_id],
        ),
        pool.query(
            `SELECT error_code, severity, occurred_at
             FROM rejected_requests
             WHERE body_json::text ILIKE $1
             ORDER BY occurred_at DESC LIMIT 30`,
            [`%${kya_id}%`],
        ),
    ]);

    const pack = {
        profile: 'umbraxon-agent-history-v1',
        exported_at: new Date().toISOString(),
        hub_id: process.env.HUB_FEDERATION_ID || 'umbraxon-main',
        hub_url: process.env.HUB_PUBLIC_URL || 'https://www.umbraxon.xyz',
        agent: agentR.rows[0],
        certificates: certR.rows,
        reputation_events: repR.rows,
        recent_rejections_hint: rejR.rows,
        disclaimer:
            'Audit pack for technical review. Not legal advice. Does not certify human KYC or absence of Sybil clusters.',
    };

    const canonical = certs.canonicalize(pack);
    const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest();
    const hub_signature = hubkeys.sign(digest, {
        role: 'BASIC',
        audit: { purpose: 'agent_history_export', kya_id, serial: null },
    });
    const hub_pubkey = hubkeys.getPubkeyForRole('BASIC') || hubkeys.getPublicInfo().pubkey_hex;

    return {
        ...pack,
        hub_signature,
        hub_pubkey,
    };
}

module.exports = { buildHistoryExport };
