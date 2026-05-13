// ============================================================================
// UMBRAXON KYA-Hub — Reputation Engine (Phase 2)
// ============================================================================
// Centralizovaný "spravodajca" reputácie. Aplikuje events atómovo v transakcii:
//   1. UPDATE agents.reputation_score
//   2. INSERT reputation_events
//   3. Ak zóna prepadla pod operational → revoke cert + status SUSPENDED
//   4. Ak zóna sa zlepšila späť → reactivate cert (manuálne cez ADMIN_RESTORE)
//
// Volá sa z:
//   - /api/agent/:kya/action       (bot self-report)
//   - /api/agent/:kya/report       (peer/anonymous report)
//   - /api/admin/agent/:kya/slash  (admin manual)
//   - decay-worker.js              (inactivity decay)
// ============================================================================
const reputation = require('./reputation');

/**
 * Atómovo aplikuje event do DB v rámci client transakcie.
 * 
 * @param {pg.PoolClient} client - PG client v BEGIN transakcii
 * @param {object} input
 *   - agent_id, kya_id (povinné)
 *   - event_type (kľúč zo SLASHING alebo custom)
 *   - delta (číselný; override default delta zo SLASHING)
 *   - source ('self' | 'peer' | 'admin' | 'system' | 'decay')
 *   - reason (text)
 *   - evidence (jsonb)
 *   - reporter_kya_id, reporter_pubkey, related_report_id, related_action_id, admin_user
 *   - client_ip, user_agent
 * 
 * @returns {object} { applied, newScore, oldScore, newZone, oldZone, eventId, sideEffects }
 */
async function applyEvent(client, input) {
    const {
        agent_id, kya_id, event_type, source, reason, evidence,
        reporter_kya_id, reporter_pubkey, related_report_id, related_action_id, admin_user,
        client_ip, user_agent,
    } = input;
    
    let delta = (input.delta !== undefined && input.delta !== null)
        ? parseInt(input.delta, 10)
        : (reputation.SLASHING[event_type] || 0);
    
    if (!Number.isFinite(delta)) throw new Error('Invalid delta');
    if (!agent_id || !kya_id) throw new Error('agent_id + kya_id required');
    
    // 1) Načítaj aktuálne skóre a zamkni riadok
    const cur = await client.query(
        `SELECT reputation_score, status, is_active FROM agents WHERE id = $1 FOR UPDATE`,
        [agent_id]
    );
    if (cur.rowCount === 0) throw new Error('Agent not found');
    const oldScore = cur.rows[0].reputation_score || 0;
    const oldZone = reputation.zoneOf(oldScore);
    
    // 2) Clamp new score
    const newScore = Math.max(reputation.MIN_SCORE, Math.min(reputation.MAX_SCORE, oldScore + delta));
    const newZone = reputation.zoneOf(newScore);
    const actualDelta = newScore - oldScore;
    
    // 3) UPDATE agents
    await client.query(
        `UPDATE agents SET reputation_score = $1, last_score_change_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [newScore, agent_id]
    );
    
    // 4) INSERT reputation_event
    const evRes = await client.query(
        `INSERT INTO reputation_events (
            agent_id, kya_id, event_type, source, delta, score_before, score_after, zone_before, zone_after,
            reason, evidence, reporter_kya_id, reporter_pubkey, related_report_id, related_action_id, admin_user,
            client_ip, user_agent
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING id`,
        [
            agent_id, kya_id, event_type, source, actualDelta, oldScore, newScore, oldZone, newZone,
            reason || null, evidence ? JSON.stringify(evidence) : null,
            reporter_kya_id || null, reporter_pubkey || null,
            related_report_id || null, related_action_id || null, admin_user || null,
            client_ip || null, user_agent || null,
        ]
    );
    const eventId = evRes.rows[0].id;
    
    // 5) Side-effects pri zmene zóny
    const sideEffects = [];
    
    // SUSPENDED prepad → revoke cert + deactivate agent
    if (newZone === 'SUSPENDED' && oldZone !== 'SUSPENDED') {
        const revokeReason = `Agent prepadol do SUSPENDED zóny (event #${eventId}: ${event_type})`;
        const certUpdate = await client.query(
            `UPDATE certificates 
             SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = $1
             WHERE kya_id = $2 AND is_current = TRUE AND revoked_at IS NULL
             RETURNING serial, revoked_at`,
            [revokeReason, kya_id]
        );
        await client.query(
            `UPDATE agents SET status = 'SUSPENDED', is_active = FALSE, suspended_at = CURRENT_TIMESTAMP,
                               revoked_at = CURRENT_TIMESTAMP, revoke_reason = $1
             WHERE id = $2`,
            [revokeReason, agent_id]
        );
        // Phase 5 — record each revoked cert into revocation_events (CRL ledger)
        try {
            const crl = require('./crl');
            for (const row of certUpdate.rows) {
                await crl.recordRevocation(client, {
                    cert_serial: row.serial,
                    kya_id,
                    agent_id,
                    revoked_at: row.revoked_at,
                    revoked_by: 'reputation-engine',
                    revocation_reason: revokeReason,
                    revocation_category: 'SUSPENDED_ZONE',
                    detail: { event_id: eventId, event_type },
                });
            }
        } catch (_) { /* CRL insert must never break the slash flow */ }
        sideEffects.push({
            type: 'CERT_REVOKED',
            certs: certUpdate.rows.map(r => r.serial),
            reason: revokeReason,
        });
    }
    
    // Návrat zo SUSPENDED (typicky cez ADMIN_RESTORE) → reactivate agent
    // POZN: cert reissue je samostatný admin step (nie auto)
    if (oldZone === 'SUSPENDED' && newZone !== 'SUSPENDED') {
        await client.query(
            `UPDATE agents SET status = 'VERIFIED', is_active = TRUE, suspended_at = NULL
             WHERE id = $1`,
            [agent_id]
        );
        sideEffects.push({
            type: 'AGENT_REACTIVATED',
            note: 'Agent znovu operational. Cert reissue je manuálne cez admin endpoint.',
        });
    }
    
    return {
        applied: true,
        eventId,
        oldScore,
        newScore,
        delta: actualDelta,
        oldZone,
        newZone,
        sideEffects,
    };
}

/**
 * Helper na overenie rate limitu pre self-action (pozitívne actions).
 * Vráti { allowed, reason, counters: { perHour, perDay, perMonth } }.
 */
async function checkSelfActionRateLimit(client, { agent_id, action_type }) {
    const rule = reputation.SELF_ACTION_RULES[action_type];
    if (!rule) return { allowed: false, reason: 'UNKNOWN_ACTION_TYPE' };
    
    // Negatívne actions sa nepočítajú pod rate limit (priznanie = vždy aplikované)
    if (rule.delta <= 0) return { allowed: true, reason: 'NEGATIVE_OR_NEUTRAL_NO_LIMIT' };
    
    const limits = reputation.SELF_RATE_LIMITS;
    
    const r = await client.query(
        `SELECT
            COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '1 hour'   AND score_delta > 0) AS h,
            COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '1 day'    AND score_delta > 0) AS d,
            COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '30 days'  AND score_delta > 0) AS m
         FROM action_log WHERE agent_id = $1`,
        [agent_id]
    );
    const { h, d, m } = r.rows[0];
    const counters = { perHour: parseInt(h, 10), perDay: parseInt(d, 10), perMonth: parseInt(m, 10) };
    
    if (counters.perHour >= limits.perHourMaxPositive) return { allowed: false, reason: 'RATE_LIMIT_HOUR', counters };
    if (counters.perDay >= limits.perDayMaxPositive) return { allowed: false, reason: 'RATE_LIMIT_DAY', counters };
    if (counters.perMonth >= limits.perMonthMaxPositive) return { allowed: false, reason: 'RATE_LIMIT_MONTH', counters };
    
    return { allowed: true, reason: 'OK', counters };
}

/**
 * Helper na overenie rate limitu pre peer reports.
 */
async function checkPeerReportRateLimit(client, { reporter_kya_id, target_kya_id }) {
    const limits = reputation.PEER_REPORT_LIMITS;
    
    const r = await client.query(
        `SELECT
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day' AND target_kya_id = $2) AS against_target,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') AS total
         FROM reports WHERE reporter_kya_id = $1`,
        [reporter_kya_id, target_kya_id]
    );
    const { against_target, total } = r.rows[0];
    const counters = { againstTarget: parseInt(against_target, 10), totalToday: parseInt(total, 10) };
    
    if (counters.againstTarget >= limits.perDayPerTarget) return { allowed: false, reason: 'TOO_MANY_AGAINST_TARGET', counters };
    if (counters.totalToday >= limits.perDayTotal) return { allowed: false, reason: 'TOO_MANY_TODAY', counters };
    
    return { allowed: true, counters };
}

module.exports = {
    applyEvent,
    checkSelfActionRateLimit,
    checkPeerReportRateLimit,
};
