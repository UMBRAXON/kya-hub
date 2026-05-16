// ============================================================================
// UMBRAXON KYA-Hub — registration intent status (M2M polling)
// ============================================================================

const REG_ID_RE = /^REG-[0-9a-f]{24}$/i;

/**
 * @param {import('pg').Pool} pool
 * @param {string} registrationId
 * @param {{ lookupPayment?: (invoiceId: string) => Promise<object|null> }} opts
 */
async function getRegistrationStatus(pool, registrationId, opts = {}) {
    if (!REG_ID_RE.test(registrationId)) {
        return { ok: false, httpStatus: 400, body: { error: 'INVALID_REGISTRATION_ID' } };
    }

    const r = await pool.query(
        `SELECT registration_id, agent_name, agent_pubkey, tier_requested, invoice_id,
                status, created_at, expires_at, completed_at, manifest_hash
         FROM registration_intents
         WHERE registration_id = $1`,
        [registrationId]
    );
    if (r.rowCount === 0) {
        return { ok: false, httpStatus: 404, body: { error: 'REGISTRATION_NOT_FOUND' } };
    }
    const intent = r.rows[0];

    let paymentStatus = null;
    let paymentSource = null;
    if (intent.invoice_id && typeof opts.lookupPayment === 'function') {
        try {
            const pay = await opts.lookupPayment(intent.invoice_id);
            if (pay) {
                paymentStatus = pay.status || null;
                paymentSource = pay.source || null;
            }
        } catch (_) {
            paymentStatus = 'UNKNOWN';
        }
    }

    let kyaId = null;
    let certUrl = null;
    let agentStatus = null;
    if (intent.status === 'COMPLETED') {
        const ag = await pool.query(
            `SELECT kya_id, status FROM agents WHERE agent_name = $1 LIMIT 1`,
            [intent.agent_name]
        );
        if (ag.rowCount > 0) {
            kyaId = ag.rows[0].kya_id;
            agentStatus = ag.rows[0].status;
            certUrl = `/api/cert/${kyaId}`;
        }
    }

    const now = Date.now();
    const expired = intent.expires_at && new Date(intent.expires_at).getTime() < now;
    let lifecycle = intent.status;
    if (lifecycle === 'PENDING_PAYMENT' && expired) {
        lifecycle = 'EXPIRED';
    }

    return {
        ok: true,
        httpStatus: 200,
        body: {
            registration_id: intent.registration_id,
            status: lifecycle,
            intent_status: intent.status,
            agent_name: intent.agent_name,
            agent_pubkey: intent.agent_pubkey,
            tier_requested: intent.tier_requested,
            manifest_hash: intent.manifest_hash,
            invoice_id: intent.invoice_id,
            payment_status: paymentStatus,
            payment_source: paymentSource,
            kya_id: kyaId,
            agent_status: agentStatus,
            cert_url: certUrl,
            created_at: intent.created_at,
            expires_at: intent.expires_at,
            completed_at: intent.completed_at,
        },
    };
}

module.exports = {
    REG_ID_RE,
    getRegistrationStatus,
};
