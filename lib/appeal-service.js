// ============================================================================
// UMBRAXON KYA-Hub — Appeal Service (Phase 2.3, Dispute Resolution)
// ============================================================================
// Operator bota môže podať kryptograficky podpísaný appeal proti konkrétnemu
// reputation_event (auto-slash, anomaly slash, peer report apply, atď.).
//
// Flow:
//   1) POST /api/agent/:kya_id/appeal
//      body: { against_event_id, appeal_text, evidence?, signature, nonce, timestamp }
//      - signature je Ed25519 nad sha256(canonical body)
//      - musí byť signed pubkey-om bota (agents.agent_pubkey)
//      - replay protection: UNIQUE(pubkey, nonce)
//      - jediný appeal per event (UNIQUE(kya_id, against_event_id))
//
//   2) Admin GET /api/admin/appeals?status=PENDING
//      Po review:
//        POST /api/admin/appeals/:id/resolve  body: { resolution: 'UPHELD'|'DISMISSED', note }
//
//   3) SLA auto-resolve: appeals s deadline < NOW() bez akcie → AUTO_UPHELD
//      (failsafe pro-agent; admin musí byť aktívny aby zlikvidoval false appeal)
//
//   4) UPHELD → reverz event (delta = -original_delta), agent reactivate ak bol SUSPENDED
// ============================================================================
const crypto = require('crypto');
const reputation = require('./reputation');

const SLA_HOURS = parseInt(process.env.APPEAL_SLA_HOURS || '72', 10);
const MIN_TEXT = 20;
const MAX_TEXT = 4000;

// Event types ktoré sa NEDAJÚ appeal-ovať (admin manual akcie, voluntary retire, atď.)
const NON_APPEALABLE_EVENTS = new Set([
    'ADMIN_RESTORE',
    'ADMIN_SLASH',           // admin slash je politické rozhodnutie, použi /api/admin/agent/:kya/restore
    'CERT_REISSUED',
    'CERT_REVOKED_VOLUNTARY',
    'VOLUNTARY_RETIRE',
    'APPEAL_REVERSAL',       // ne-appeal-uj reverz appeal-u rekurzívne
]);

/**
 * Vytvor canonical payload pre appeal signature.
 * Bot musí podpísať sha256(canonical) svojím privkey-om.
 */
function canonicalAppealPayload({ kya_id, against_event_id, appeal_text, evidence_hash, nonce, timestamp }) {
    // Normalize types deterministically aby klient aj server vyrobili rovnaký canonical
    return JSON.stringify({
        v: 1,
        kya_id: String(kya_id || ''),
        against_event_id: (against_event_id != null && against_event_id !== '') ? Number(against_event_id) : null,
        appeal_text: String(appeal_text || ''),
        evidence_hash: evidence_hash || null,
        nonce: String(nonce || ''),
        timestamp: String(timestamp || ''),
    });
}

/**
 * Podaj nový appeal.
 * @returns { ok, appeal_id, sla_deadline } alebo { error, message }
 */
async function submitAppeal(pool, hubkeys, { kya_id, against_event_id, appeal_text, evidence, signature, nonce, timestamp, client_ip, user_agent }) {
    // Vstupná validácia
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id || '')) return { error: 'INVALID_KYA_ID' };
    if (typeof appeal_text !== 'string' || appeal_text.length < MIN_TEXT || appeal_text.length > MAX_TEXT) {
        return { error: 'INVALID_APPEAL_TEXT', message: `${MIN_TEXT}-${MAX_TEXT} chars required` };
    }
    if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) return { error: 'BAD_SIGNATURE_FORMAT' };
    if (!nonce || !/^[0-9a-fA-F]{16,64}$/.test(nonce)) return { error: 'INVALID_NONCE_FORMAT' };
    if (!timestamp) return { error: 'MISSING_TIMESTAMP' };
    
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
        return { error: 'TIMESTAMP_SKEW' };
    }
    
    // Načítaj agenta
    const ag = await pool.query(
        `SELECT id, kya_id, agent_pubkey, reputation_score, status, retired_at, pubkey_blacklisted
         FROM agents WHERE kya_id = $1`,
        [kya_id]
    );
    if (ag.rowCount === 0) return { error: 'AGENT_NOT_FOUND' };
    const agent = ag.rows[0];
    
    if (agent.retired_at) return { error: 'AGENT_RETIRED', message: 'Retired agent cannot appeal' };
    if (!agent.agent_pubkey) return { error: 'AGENT_HAS_NO_PUBKEY' };
    
    // Načítaj event ktorý sa appealuje (voliteľné — môžeš appealovať aj generický stav bez konkrétneho eventu, napr. cumulative anomaly)
    let event = null;
    if (against_event_id) {
        const ev = await pool.query(
            `SELECT id, event_type, delta, source, occurred_at FROM reputation_events
             WHERE id = $1 AND kya_id = $2`,
            [against_event_id, kya_id]
        );
        if (ev.rowCount === 0) return { error: 'EVENT_NOT_FOUND' };
        event = ev.rows[0];
        if (NON_APPEALABLE_EVENTS.has(event.event_type)) {
            return { error: 'EVENT_NOT_APPEALABLE', event_type: event.event_type };
        }
        if (event.delta >= 0) {
            return { error: 'POSITIVE_EVENT_NOT_APPEALABLE', message: 'Iba slashing eventy možno apelovat' };
        }
    }
    
    // Verifikuj signature
    const evidenceHash = evidence ? crypto.createHash('sha256')
        .update(typeof evidence === 'string' ? evidence : JSON.stringify(evidence))
        .digest('hex') : null;
    const canonical = canonicalAppealPayload({
        kya_id, against_event_id, appeal_text, evidence_hash: evidenceHash, nonce, timestamp,
    });
    const digest = crypto.createHash('sha256').update(canonical).digest();
    if (!hubkeys.verify(digest, signature, agent.agent_pubkey)) {
        return { error: 'BAD_SIGNATURE' };
    }
    
    const sla = new Date(Date.now() + SLA_HOURS * 3600 * 1000);
    
    try {
        const ins = await pool.query(
            `INSERT INTO appeals (
                agent_id, kya_id, against_event_id, against_event_type, against_delta,
                status, submitted_by_pubkey, appeal_text, evidence, evidence_hash,
                signature, nonce, bot_timestamp, sla_deadline,
                client_ip, user_agent
            ) VALUES ($1,$2,$3,$4,$5, 'PENDING', $6,$7,$8,$9, $10,$11,$12,$13, $14,$15)
            RETURNING id, sla_deadline`,
            [
                agent.id, kya_id, against_event_id || null,
                event ? event.event_type : null,
                event ? event.delta : null,
                agent.agent_pubkey, appeal_text,
                evidence ? JSON.stringify(evidence) : null, evidenceHash,
                signature, nonce, new Date(tsMs), sla,
                client_ip || null, user_agent || null,
            ]
        );
        return {
            ok: true,
            appeal_id: ins.rows[0].id,
            sla_deadline: ins.rows[0].sla_deadline,
            status: 'PENDING',
            sla_hours: SLA_HOURS,
        };
    } catch (e) {
        if (e.code === '23505') {
            if (e.constraint === 'uniq_appeal_nonce') return { error: 'REPLAY_NONCE_REUSED' };
            if (e.constraint === 'uniq_appeal_per_event') return { error: 'APPEAL_ALREADY_EXISTS_FOR_EVENT' };
            return { error: 'DUPLICATE', detail: e.constraint };
        }
        throw e;
    }
}

/**
 * List appeals (verejné — bot/owner audit).
 */
async function listForAgent(pool, kya_id, { limit = 50, offset = 0 } = {}) {
    const r = await pool.query(
        `SELECT id, against_event_id, against_event_type, against_delta, status,
                submitted_at, sla_deadline, resolved_at, admin_resolution, resolution_note,
                reverse_event_id, appeal_text
         FROM appeals WHERE kya_id = $1
         ORDER BY submitted_at DESC LIMIT $2 OFFSET $3`,
        [kya_id, limit, offset]
    );
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM appeals WHERE kya_id = $1`, [kya_id]);
    return { count: r.rowCount, total: total.rows[0].n, appeals: r.rows };
}

/**
 * Admin: list pending / all appeals.
 */
async function listForAdmin(pool, { status = 'PENDING', limit = 100, offset = 0 } = {}) {
    const where = status === 'all' ? '' : 'WHERE status = $1';
    const params = status === 'all' ? [limit, offset] : [status, limit, offset];
    const r = await pool.query(
        `SELECT id, agent_id, kya_id, against_event_id, against_event_type, against_delta,
                status, priority, submitted_by_pubkey, appeal_text, evidence,
                submitted_at, sla_deadline, resolved_at, admin_resolution, resolution_note,
                client_ip, user_agent
         FROM appeals ${where}
         ORDER BY priority DESC, submitted_at ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return { count: r.rowCount, appeals: r.rows };
}

/**
 * Admin: resolve appeal.
 * - UPHELD: vytvor reverz reputation_event (delta = -against_delta), reactivate agent ak SUSPENDED
 * - DISMISSED: žiadny effect, len mark
 */
async function resolveAppeal(pool, repEngine, { appeal_id, resolution, note, admin_user, client_ip }) {
    if (!['UPHELD', 'DISMISSED'].includes(resolution)) {
        return { error: 'INVALID_RESOLUTION', allowed: ['UPHELD', 'DISMISSED'] };
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Lock appeal row
        const ap = await client.query(
            `SELECT id, agent_id, kya_id, against_event_id, against_event_type, against_delta, status
             FROM appeals WHERE id = $1 FOR UPDATE`,
            [appeal_id]
        );
        if (ap.rowCount === 0) {
            await client.query('ROLLBACK');
            return { error: 'APPEAL_NOT_FOUND' };
        }
        const a = ap.rows[0];
        if (a.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return { error: 'ALREADY_RESOLVED', current_status: a.status };
        }
        
        let reverseEventId = null;
        if (resolution === 'UPHELD' && a.against_delta && a.against_delta < 0) {
            const reverseDelta = -a.against_delta; // pozitívne číslo
            const reverseRes = await repEngine.applyEvent(client, {
                agent_id: a.agent_id,
                kya_id: a.kya_id,
                event_type: 'APPEAL_REVERSAL',
                source: 'admin',
                delta: reverseDelta,
                reason: `Appeal #${appeal_id} UPHELD: reverz ${a.against_event_type || 'event'}#${a.against_event_id || 'n/a'} (delta=${a.against_delta}, restore=+${reverseDelta}). Note: ${(note || '').slice(0, 200)}`,
                evidence: {
                    appeal_id,
                    original_event_id: a.against_event_id,
                    original_event_type: a.against_event_type,
                    admin_resolution_note: note,
                },
                admin_user,
                client_ip,
            });
            reverseEventId = reverseRes.eventId;
        }
        
        await client.query(
            `UPDATE appeals SET
                status = $1,
                admin_resolution = $1,
                resolution_note = $2,
                resolved_at = NOW(),
                resolved_by = $3,
                reverse_event_id = $4
             WHERE id = $5`,
            [resolution, note || null, admin_user || null, reverseEventId, appeal_id]
        );
        
        await client.query('COMMIT');
        return {
            ok: true,
            appeal_id,
            resolution,
            reverse_event_id: reverseEventId,
        };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * SLA tick: pending appeals s deadline < NOW() → AUTO_UPHELD.
 * Volá decay-worker / scheduled tick.
 * @returns { processed, upheld_ids }
 */
async function processSlaExpirations(pool, repEngine, logger) {
    const expired = await pool.query(
        `SELECT id, agent_id, kya_id, against_event_id, against_event_type, against_delta
         FROM appeals WHERE status = 'PENDING' AND sla_deadline < NOW()
         LIMIT 100`
    );
    if (expired.rowCount === 0) return { processed: 0, upheld_ids: [] };
    
    const log = logger || console;
    const upheldIds = [];
    
    for (const ap of expired.rows) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // Re-check status (race condition guard)
            const cur = await client.query(
                `SELECT status FROM appeals WHERE id = $1 FOR UPDATE`,
                [ap.id]
            );
            if (cur.rows[0].status !== 'PENDING') {
                await client.query('ROLLBACK');
                continue;
            }
            
            let reverseEventId = null;
            if (ap.against_delta && ap.against_delta < 0) {
                const r = await repEngine.applyEvent(client, {
                    agent_id: ap.agent_id,
                    kya_id: ap.kya_id,
                    event_type: 'APPEAL_REVERSAL',
                    source: 'system',
                    delta: -ap.against_delta,
                    reason: `Auto-upheld (SLA expired): appeal #${ap.id} against event #${ap.against_event_id || 'n/a'}`,
                    evidence: { appeal_id: ap.id, auto_upheld_reason: 'SLA_EXPIRED' },
                    admin_user: 'system',
                });
                reverseEventId = r.eventId;
            }
            
            await client.query(
                `UPDATE appeals SET
                    status = 'EXPIRED_AUTO_UPHELD',
                    admin_resolution = 'AUTO_UPHELD_SLA',
                    resolved_at = NOW(),
                    resolved_by = 'system',
                    reverse_event_id = $1
                 WHERE id = $2`,
                [reverseEventId, ap.id]
            );
            
            await client.query('COMMIT');
            upheldIds.push(ap.id);
            (log.info || console.log).call(log, { appeal_id: ap.id, kya_id: ap.kya_id }, 'appeal AUTO_UPHELD (SLA expired)');
        } catch (e) {
            await client.query('ROLLBACK');
            (log.error || console.error).call(log, { appeal_id: ap.id, err: e.message }, 'SLA auto-uphold FAIL');
        } finally {
            client.release();
        }
    }
    
    return { processed: expired.rowCount, upheld_ids: upheldIds };
}

module.exports = {
    submitAppeal,
    listForAgent,
    listForAdmin,
    resolveAppeal,
    processSlaExpirations,
    canonicalAppealPayload,
    NON_APPEALABLE_EVENTS,
    SLA_HOURS,
    MIN_TEXT,
    MAX_TEXT,
};
