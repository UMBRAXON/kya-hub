// ============================================================================
// UMBRAXON KYA-Hub — Retire Service (Phase 2.3, Exit Strategy)
// ============================================================================
// Bot operator môže legitímne stiahnuť bota cez kryptograficky podpísaný
// retire request. Po retire:
//   - cert je REVOKED s reason="VOLUNTARY_RETIRE"
//   - agent.status = RETIRED, retired_at, retire_reason, retire_signature
//   - pubkey_blacklisted = TRUE (rovnaký pubkey nemôže registrovať znovu)
//   - reputation_event RECORDED type=VOLUNTARY_RETIRE (delta=0, tombstone)
//   - certificate_status endpoint → 410 GONE + reason=VOLUNTARY_RETIRE
//
// Admin purge:
//   - POST /api/admin/agent/:kya_id/purge → fyzické zmazanie (GDPR full-delete)
//   - Voliteľne zachová hash riadkov ako audit (audit_purged_kya_hashes)
// ============================================================================
const crypto = require('crypto');

function canonicalRetirePayload({ kya_id, retire_reason, nonce, timestamp }) {
    return JSON.stringify({
        v: 1,
        op: 'retire',
        kya_id: String(kya_id || ''),
        retire_reason: retire_reason ? String(retire_reason) : null,
        nonce: String(nonce || ''),
        timestamp: String(timestamp || ''),
    });
}

/**
 * Vykonaj retire request.
 * Bot odovzdá signed payload, my overíme a označíme agenta ako RETIRED.
 */
async function retire(pool, hubkeys, { kya_id, retire_reason, signature, nonce, timestamp, client_ip, user_agent }) {
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id || '')) return { error: 'INVALID_KYA_ID' };
    if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) return { error: 'BAD_SIGNATURE_FORMAT' };
    if (!nonce || !/^[0-9a-fA-F]{16,64}$/.test(nonce)) return { error: 'INVALID_NONCE_FORMAT' };
    if (!timestamp) return { error: 'MISSING_TIMESTAMP' };
    if (retire_reason && (typeof retire_reason !== 'string' || retire_reason.length > 500)) {
        return { error: 'INVALID_RETIRE_REASON', message: 'max 500 chars' };
    }
    
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
        return { error: 'TIMESTAMP_SKEW' };
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const ag = await client.query(
            `SELECT id, kya_id, agent_name, agent_pubkey, status, retired_at, reputation_score
             FROM agents WHERE kya_id = $1 FOR UPDATE`,
            [kya_id]
        );
        if (ag.rowCount === 0) {
            await client.query('COMMIT');
            return { error: 'AGENT_NOT_FOUND' };
        }
        const a = ag.rows[0];
        if (a.retired_at) {
            await client.query('COMMIT');
            return { error: 'ALREADY_RETIRED', retired_at: a.retired_at };
        }
        if (!a.agent_pubkey) {
            await client.query('COMMIT');
            return { error: 'AGENT_HAS_NO_PUBKEY' };
        }
        
        // Verifikuj signature
        const canonical = canonicalRetirePayload({ kya_id, retire_reason, nonce, timestamp });
        const digest = crypto.createHash('sha256').update(canonical).digest();
        if (!hubkeys.verify(digest, signature, a.agent_pubkey)) {
            await client.query('COMMIT');
            return { error: 'BAD_SIGNATURE' };
        }
        
        const revokeReason = `Voluntary retire by owner: ${(retire_reason || 'no reason given').slice(0, 200)}`;
        
        // Revoke current cert
        const certRev = await client.query(
            `UPDATE certificates
             SET revoked_at = NOW(), revoke_reason = $1
             WHERE kya_id = $2 AND is_current = TRUE AND revoked_at IS NULL
             RETURNING serial, revoked_at`,
            [revokeReason, kya_id]
        );

        // Phase 5 — record each revoked cert into revocation_events (CRL ledger)
        try {
            const crl = require('./crl');
            for (const row of certRev.rows) {
                await crl.recordRevocation(client, {
                    cert_serial: row.serial,
                    kya_id,
                    agent_id: a.id,
                    revoked_at: row.revoked_at,
                    revoked_by: 'owner',
                    revocation_reason: revokeReason,
                    revocation_category: 'VOLUNTARY_RETIRE',
                    detail: { retire_reason: retire_reason || null, nonce, signature_prefix: signature.slice(0, 16) },
                    client_ip,
                });
            }
        } catch (_) { /* never break retire on CRL insert failure */ }
        
        // Update agent → RETIRED
        await client.query(
            `UPDATE agents SET
                status = 'RETIRED',
                is_active = FALSE,
                retired_at = NOW(),
                retire_reason = $1,
                retire_signature = $2,
                pubkey_blacklisted = TRUE,
                revoked_at = NOW(),
                revoke_reason = $3
             WHERE id = $4`,
            [retire_reason || null, signature, revokeReason, a.id]
        );
        
        // Audit event (delta=0 — retire nemení skóre)
        const oldScore = a.reputation_score || 0;
        await client.query(
            `INSERT INTO reputation_events (
                agent_id, kya_id, event_type, source, delta, score_before, score_after,
                zone_before, zone_after, reason, evidence, client_ip, user_agent
             ) VALUES ($1, $2, 'VOLUNTARY_RETIRE', 'self', 0, $3, $3, 'RETIRED', 'RETIRED', $4, $5, $6, $7)`,
            [
                a.id, kya_id, oldScore,
                revokeReason,
                JSON.stringify({ retire_reason: retire_reason || null, nonce, signature_prefix: signature.slice(0, 16), revoked_certs: certRev.rows.map(r => r.serial) }),
                client_ip || null, user_agent || null,
            ]
        );
        
        await client.query('COMMIT');
        
        return {
            ok: true,
            kya_id,
            agent_name: a.agent_name,
            status: 'RETIRED',
            retired_at: new Date().toISOString(),
            revoked_certs: certRev.rows.map(r => r.serial),
            pubkey_blacklisted: true,
        };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Admin: fyzické vymazanie agenta a všetkých súvisiacich záznamov (GDPR).
 * Zachováva audit_purged_kya_hashes pre dôkaz "existoval ale bol purged".
 *
 * POZNÁMKA: certifikáty NEMAŽEME (forenzika), ale označíme is_current=FALSE.
 * action_log a reputation_events tiež ostávajú (CASCADE iba pri DELETE FROM agents).
 *
 * Ak chce admin skutočne full-delete, použije DELETE agent → CASCADE.
 */
async function adminPurge(pool, { kya_id, admin_user, client_ip, hard_delete = false }) {
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id || '')) return { error: 'INVALID_KYA_ID' };
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const ag = await client.query(
            `SELECT id, kya_id, agent_pubkey, status, retired_at FROM agents WHERE kya_id = $1 FOR UPDATE`,
            [kya_id]
        );
        if (ag.rowCount === 0) {
            await client.query('COMMIT');
            return { error: 'AGENT_NOT_FOUND' };
        }
        const a = ag.rows[0];
        
        // Anchor hash pre audit (môžeme dokázať "existoval kya_id=X s pubkey=Y")
        const auditHash = crypto.createHash('sha256')
            .update(`${a.kya_id}:${a.agent_pubkey || 'no-pubkey'}:${a.id}`)
            .digest('hex');
        
        if (hard_delete) {
            // CASCADE delete (certs, events, action_log, heartbeats, appeals — všetko)
            await client.query(`DELETE FROM agents WHERE id = $1`, [a.id]);
        } else {
            // Soft purge: pseudonymizuj
            await client.query(
                `UPDATE agents SET
                    status = 'PURGED',
                    is_active = FALSE,
                    agent_pubkey = NULL,
                    agent_manifest = '{"purged": true}'::jsonb,
                    pubkey_blacklisted = TRUE,
                    retire_reason = $1,
                    revoked_at = COALESCE(revoked_at, NOW()),
                    revoke_reason = COALESCE(revoke_reason, 'GDPR purge by admin')
                 WHERE id = $2`,
                [`GDPR purge by ${admin_user || 'admin'}`, a.id]
            );
            // Mark all certs as revoked
            const purged = await client.query(
                `UPDATE certificates SET revoked_at = COALESCE(revoked_at, NOW()),
                                         revoke_reason = COALESCE(revoke_reason, 'GDPR purge'),
                                         is_current = FALSE
                 WHERE kya_id = $1
                 RETURNING serial, revoked_at`,
                [kya_id]
            );
            // Phase 5 — log GDPR purge revocations into CRL ledger
            try {
                const crl = require('./crl');
                for (const row of purged.rows) {
                    await crl.recordRevocation(client, {
                        cert_serial: row.serial,
                        kya_id,
                        agent_id: a.id,
                        revoked_at: row.revoked_at,
                        revoked_by: 'gdpr_purge',
                        revocation_reason: `GDPR purge by ${admin_user || 'admin'}`,
                        revocation_category: 'GDPR_PURGE',
                        admin_user, client_ip,
                    });
                }
            } catch (_) { /* never break purge on CRL insert failure */ }
        }
        
        await client.query('COMMIT');
        return {
            ok: true,
            kya_id,
            hard_delete: !!hard_delete,
            audit_hash: auditHash,
            purged_by: admin_user || 'admin',
            purged_at: new Date().toISOString(),
        };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Skontroluje či je daný pubkey blacklisted (nemôže registrovať nového agenta).
 */
async function isPubkeyBlacklisted(pool, pubkey) {
    if (!pubkey) return false;
    const r = await pool.query(
        `SELECT id, kya_id, retire_reason FROM agents
         WHERE agent_pubkey = $1 AND pubkey_blacklisted = TRUE LIMIT 1`,
        [pubkey.toLowerCase()]
    );
    if (r.rowCount === 0) return false;
    return { kya_id: r.rows[0].kya_id, reason: r.rows[0].retire_reason };
}

module.exports = {
    retire,
    adminPurge,
    isPubkeyBlacklisted,
    canonicalRetirePayload,
};
