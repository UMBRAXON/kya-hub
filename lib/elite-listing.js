// ============================================================================
// ELITE public listing liveness — paid heartbeat + grace + reactivation
//
// IMPORTANT: This module affects ONLY tier === 'ELITE' (anchored) agents.
// BASIC tier is untouched — no listing fees, no status column semantics.
// ============================================================================
const crypto = require('crypto');

const HEARTBEAT_DAYS = parseInt(process.env.ELITE_LISTING_HEARTBEAT_DAYS || '30', 10);
const GRACE_DAYS = parseInt(process.env.ELITE_LISTING_GRACE_DAYS || '30', 10);
const HEARTBEAT_SATS = parseInt(process.env.ELITE_LISTING_HEARTBEAT_SATS || '150', 10);
const REACTIVATION_SATS = parseInt(process.env.ELITE_LISTING_REACTIVATION_SATS || '5000', 10);

/**
 * Static policy exposed in GET /api/tiers and elite-listing responses (docs for bots).
 * Does not change fee amounts or state-machine behaviour.
 */
function cfgSummary() {
    return {
        heartbeat_interval_days: HEARTBEAT_DAYS,
        grace_days: GRACE_DAYS,
        heartbeat_fee_sats: HEARTBEAT_SATS,
        reactivation_fee_sats: REACTIVATION_SATS,
        listing_clock_starts_when: 'anchor_confirmed',
        interval_type: 'rolling_days',
        first_listing_period_included: true,
        first_listing_period_note:
            'The first public-listing interval (~heartbeat_interval_days) begins when anchor_status '
            + 'becomes ANCHORED, not when registration is paid. No separate 150 sats invoice is required '
            + 'before the first next_heartbeat_due_at.',
        reputation_heartbeat: {
            endpoint: 'POST /api/agent/{kya_id}/heartbeat',
            fee_sats: 0,
            purpose: 'Reputation liveness and decay only — not the paid ELITE discovery listing fee.',
        },
        paid_listing_heartbeat: {
            endpoint: 'POST /api/agent/{kya_id}/elite-listing/pay-invoice',
            kind: 'heartbeat',
            fee_sats: HEARTBEAT_SATS,
            purpose: 'Stay in GET /api/whitelist/elite and discovery feed while LISTED or GRACE.',
        },
        bot_integration: {
            poll_status: 'GET /api/agent/{kya_id}/elite-listing',
            poll_anchor: 'GET /api/agent/{kya_id}',
            recommended_poll_interval_hours: 24,
            pay_before_field: 'next_heartbeat_due_at',
        },
    };
}

function recommendedListingAction(a, nowMs = Date.now()) {
    if (a.anchor_status !== 'ANCHORED') {
        return {
            code: 'WAIT_FOR_ANCHOR',
            message:
                'Listing clock starts at anchor_confirmed (after on-chain OP_RETURN), not at registration payment. '
                + 'Poll GET /api/agent/{kya_id} until anchor_status is ANCHORED, then GET /api/agent/{kya_id}/elite-listing.',
        };
    }
    const ls = a.elite_listing_status || 'LISTED';
    if (ls === 'DELISTED') {
        return {
            code: 'PAY_REACTIVATION_OR_REDEEM_FREE',
            message:
                `Agent is delisted from the public index. Pay ${REACTIVATION_SATS} sats (kind=reactivation) `
                + 'or POST .../elite-listing/redeem-free once per calendar year.',
        };
    }
    const nextMs = a.elite_listing_next_due_at
        ? new Date(a.elite_listing_next_due_at).getTime()
        : null;
    if (ls === 'GRACE' || (ls === 'LISTED' && nextMs != null && nowMs >= nextMs)) {
        return {
            code: 'PAY_LISTING_HEARTBEAT',
            message:
                `Pay listing heartbeat (${HEARTBEAT_SATS} sats, kind=heartbeat) before grace ends to stay in the discovery index.`,
            due_at: a.elite_listing_next_due_at,
        };
    }
    return {
        code: 'OK_UNTIL_DUE',
        message:
            `No paid listing heartbeat required yet. First ~${HEARTBEAT_DAYS} days after anchor are included with ELITE registration; `
            + `pay ${HEARTBEAT_SATS} sats before next_heartbeat_due_at.`,
        due_at: a.elite_listing_next_due_at,
    };
}

function _nextDueFrom(now = new Date()) {
    return new Date(now.getTime() + HEARTBEAT_DAYS * 86400000);
}

/**
 * State machine transitions (hourly sweep). LISTED + overdue → GRACE.
 * GRACE + grace_until passed → DELISTED.
 */
async function sweep(pool, log) {
    const out = { to_grace: 0, to_delisted: 0 };
    const r1 = await pool.query(
        `UPDATE agents SET
            elite_listing_status = 'GRACE',
            elite_listing_grace_until = elite_listing_next_due_at + ($1::int * INTERVAL '1 day'),
            elite_listing_miss_streak = elite_listing_miss_streak + 1
         WHERE tier = 'ELITE'
           AND anchor_status = 'ANCHORED'
           AND is_active = TRUE
           AND retired_at IS NULL
           AND elite_listing_status = 'LISTED'
           AND elite_listing_next_due_at IS NOT NULL
           AND elite_listing_next_due_at < NOW()
         RETURNING kya_id`,
        [GRACE_DAYS]
    );
    out.to_grace = r1.rowCount;
    const r2 = await pool.query(
        `UPDATE agents SET
            elite_listing_status = 'DELISTED'
         WHERE tier = 'ELITE'
           AND anchor_status = 'ANCHORED'
           AND is_active = TRUE
           AND retired_at IS NULL
           AND elite_listing_status = 'GRACE'
           AND elite_listing_grace_until IS NOT NULL
           AND elite_listing_grace_until < NOW()
         RETURNING kya_id`
    );
    out.to_delisted = r2.rowCount;
    if ((out.to_grace || out.to_delisted) && log) {
        log.warn({ worker: 'elite-listing-sweep', ...out }, 'ELITE listing state transitions');
    }
    if (out.to_grace + out.to_delisted > 0) {
        try {
            process.emit('kya:whitelist-invalidate');
        } catch (_) { /* no listeners */ }
    }
    return out;
}

async function getPublicStatus(pool, kya_id) {
    const policy = cfgSummary();
    const r = await pool.query(
        `SELECT kya_id, tier, anchor_status, status, anchor_confirmed_at,
                elite_listing_status, elite_listing_next_due_at, elite_listing_grace_until,
                elite_listing_heartbeat_paid_at, elite_listing_miss_streak,
                elite_listing_free_reactivation_year
           FROM agents WHERE kya_id = $1`,
        [kya_id]
    );
    if (r.rowCount === 0) return { error: 'AGENT_NOT_FOUND', policy };
    const a = r.rows[0];
    if (a.tier !== 'ELITE') {
        return { error: 'NOT_ELITE', tier: a.tier, policy };
    }
    const now = Date.now();
    const next = a.elite_listing_next_due_at ? new Date(a.elite_listing_next_due_at).getTime() : null;
    const grace = a.elite_listing_grace_until ? new Date(a.elite_listing_grace_until).getTime() : null;
    const action = recommendedListingAction(a, now);
    return {
        kya_id: a.kya_id,
        tier: a.tier,
        anchor_status: a.anchor_status,
        agent_status: a.status,
        listing_status: a.elite_listing_status || 'LISTED',
        listing_period_started_at: a.anchor_confirmed_at || null,
        next_heartbeat_due_at: a.elite_listing_next_due_at,
        grace_until: a.elite_listing_grace_until,
        last_paid_heartbeat_at: a.elite_listing_heartbeat_paid_at,
        last_listing_period_mark_at: a.elite_listing_heartbeat_paid_at,
        miss_streak: a.elite_listing_miss_streak || 0,
        policy,
        fees: policy,
        recommended_action: action,
        free_reactivation_used_year: a.elite_listing_free_reactivation_year,
        seconds_until_due: next != null ? Math.max(0, Math.floor((next - now) / 1000)) : null,
        seconds_until_grace_end: grace != null ? Math.max(0, Math.floor((grace - now) / 1000)) : null,
        publicly_indexed: a.anchor_status === 'ANCHORED'
            && a.status === 'VERIFIED'
            && (a.elite_listing_status === 'LISTED' || a.elite_listing_status == null),
    };
}

function _verifyListingSignature(agentPubkey, body, allowedKinds = ['heartbeat', 'reactivation']) {
    const { kind, nonce, timestamp, signature } = body || {};
    if (!kind || !nonce || !timestamp || !signature) {
        return { ok: false, error: 'MISSING_FIELDS', required: ['kind', 'nonce', 'timestamp', 'signature'] };
    }
    if (!allowedKinds.includes(kind)) {
        return { ok: false, error: 'INVALID_KIND', allowed: allowedKinds };
    }
    if (!/^[0-9a-fA-F]{128}$/.test(signature)) return { ok: false, error: 'INVALID_SIGNATURE_FORMAT' };
    const canonical = JSON.stringify({ kind, nonce, timestamp: String(timestamp) });
    const digest = crypto.createHash('sha256').update(canonical).digest();
    const hubkeys = require('./hubkeys');
    if (!hubkeys.verify(digest, signature, agentPubkey)) {
        return { ok: false, error: 'BAD_SIGNATURE' };
    }
    return { ok: true, kind, nonce, timestamp };
}

async function createPayInvoice(pool, {
    kya_id, kind, alby, btcpayAxios, cfg, logger,
}) {
    const r = await pool.query(
        `SELECT id, kya_id, agent_name, agent_pubkey, tier, anchor_status, status,
                elite_listing_status, elite_listing_free_reactivation_year
           FROM agents WHERE kya_id = $1`,
        [kya_id]
    );
    if (r.rowCount === 0) return { status: 404, body: { error: 'AGENT_NOT_FOUND' } };
    const a = r.rows[0];
    if (a.tier !== 'ELITE') return { status: 400, body: { error: 'NOT_ELITE' } };
    if (a.anchor_status !== 'ANCHORED' || a.status !== 'VERIFIED') {
        return { status: 409, body: { error: 'ELITE_NOT_READY', anchor_status: a.anchor_status, agent_status: a.status } };
    }
    const ls = a.elite_listing_status || 'LISTED';
    if (kind === 'heartbeat' && !['LISTED', 'GRACE'].includes(ls)) {
        return { status: 402, body: {
            error: 'HEARTBEAT_NOT_APPLICABLE',
            listing_status: ls,
            message: 'Heartbeat payment only when LISTED or GRACE. Use reactivation if DELISTED.',
        } };
    }
    if (kind === 'reactivation' && ls !== 'DELISTED') {
        return { status: 402, body: {
            error: 'REACTIVATION_NOT_APPLICABLE',
            listing_status: ls,
            message: 'Reactivation only when DELISTED.',
        } };
    }

    const amountSats = kind === 'heartbeat' ? HEARTBEAT_SATS : REACTIVATION_SATS;

    const metadata = {
        eliteListingPayment: kind,
        eliteListingKyaId: kya_id,
        eliteListingExpectedSats: amountSats,
        eliteListingAgentName: a.agent_name,
    };

    const useAlby = alby.isConfigured() && alby.isConnected();
    if (useAlby) {
        try {
            const inv = await alby.createInvoice({
                amountSats,
                description: `UMBRAXON ELITE listing ${kind}: ${a.agent_name}`,
                metadata,
            });
            return { status: 200, body: {
                method: 'alby-lightning',
                kind,
                amount_sats: amountSats,
                invoiceId: inv.paymentHash,
                paymentHash: inv.paymentHash,
                paymentRequest: inv.invoice,
                expiresAt: inv.expiresAt,
                metadata,
            } };
        } catch (e) {
            logger.warn({ err: e.message }, 'elite-listing Alby invoice FAIL — BTCPay fallback');
        }
    }

    try {
        const r2 = await btcpayAxios.post(
            `${cfg.BTCPAY_URL}/api/v1/stores/${cfg.BTCPAY_STORE_ID}/invoices`,
            {
                amount: amountSats,
                currency: 'SATS',
                metadata,
                checkout: { speedPolicy: 'HighSpeed', redirectURL: cfg.REDIRECT_URL },
            },
            { headers: { Authorization: `token ${cfg.BTCPAY_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        const invoice = r2.data;
        return { status: 200, body: {
            method: 'btcpay',
            kind,
            amount_sats: amountSats,
            invoiceId: invoice.id,
            checkoutLink: invoice.checkoutLink,
            metadata,
        } };
    } catch (e) {
        logger.error({ err: e.message }, 'elite-listing BTCPay invoice FAIL');
        return { status: 503, body: { error: 'INVOICE_FAILED', message: e.message } };
    }
}

async function redeemFreeReactivation(pool, kya_id) {
    const y = new Date().getUTCFullYear();
    const r = await pool.query(
        `UPDATE agents SET
            elite_listing_status = 'LISTED',
            elite_listing_heartbeat_paid_at = NOW(),
            elite_listing_next_due_at = NOW() + ($2::int * INTERVAL '1 day'),
            elite_listing_grace_until = NULL,
            elite_listing_miss_streak = 0,
            elite_listing_free_reactivation_year = $3
         WHERE kya_id = $1
           AND tier = 'ELITE'
           AND anchor_status = 'ANCHORED'
           AND status = 'VERIFIED'
           AND elite_listing_status = 'DELISTED'
           AND (elite_listing_free_reactivation_year IS NULL OR elite_listing_free_reactivation_year < $3)
         RETURNING kya_id`,
        [kya_id, HEARTBEAT_DAYS, y]
    );
    if (r.rowCount === 0) {
        return { ok: false, error: 'FREE_REACTIVATION_NOT_AVAILABLE' };
    }
    process.emit('kya:whitelist-invalidate');
    return { ok: true, kya_id, listing_status: 'LISTED', next_heartbeat_due_at: _nextDueFrom() };
}

async function recordReceiptAndUpdateAgent(client, {
    invoiceId, paymentHash, kya_id, kind, amountSats, source,
}) {
    const recIns = await client.query(
        `INSERT INTO elite_listing_payment_receipts (invoice_id, payment_hash, kya_id, kind, amount_sats, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (invoice_id) DO NOTHING
         RETURNING id`,
        [invoiceId, paymentHash || null, kya_id, kind, amountSats, source]
    );
    if (recIns.rowCount === 0) return { duplicate: true };

    if (kind === 'heartbeat') {
        await client.query(
            `UPDATE agents SET
                elite_listing_status = 'LISTED',
                elite_listing_heartbeat_paid_at = NOW(),
                elite_listing_next_due_at = NOW() + ($2::int * INTERVAL '1 day'),
                elite_listing_grace_until = NULL,
                elite_listing_miss_streak = 0
             WHERE kya_id = $1`,
            [kya_id, HEARTBEAT_DAYS]
        );
    } else if (kind === 'reactivation') {
        await client.query(
            `UPDATE agents SET
                elite_listing_status = 'LISTED',
                elite_listing_heartbeat_paid_at = NOW(),
                elite_listing_next_due_at = NOW() + ($2::int * INTERVAL '1 day'),
                elite_listing_grace_until = NULL,
                elite_listing_miss_streak = 0
             WHERE kya_id = $1`,
            [kya_id, HEARTBEAT_DAYS]
        );
    }
    process.emit('kya:whitelist-invalidate');
    return { duplicate: false };
}

/**
 * Process BTCPay or Alby-NWC settlement for elite listing invoice.
 */
async function handlePaymentSettled(pool, {
    invoiceId, paymentHash, amountSats, metadata, source, logger,
}) {
    const log = logger || console;
    const md = metadata || {};
    const kind = md.eliteListingPayment;
    if (kind !== 'heartbeat' && kind !== 'reactivation') return { handled: false };

    const kya_id = md.eliteListingKyaId;
    if (!kya_id || !/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) {
        log.warn({ md }, 'elite listing payment missing eliteListingKyaId');
        return { handled: true, ok: false, reason: 'bad_kya' };
    }
    const expected = kind === 'heartbeat' ? HEARTBEAT_SATS : REACTIVATION_SATS;
    const paid = parseInt(amountSats, 10) || parseInt(md.eliteListingExpectedSats, 10) || 0;
    if (paid < expected) {
        log.warn({ kya_id, kind, paid, expected }, 'elite listing underpayment — ignoring');
        return { handled: true, ok: false, reason: 'underpaid' };
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const res = await recordReceiptAndUpdateAgent(client, {
            invoiceId: invoiceId || paymentHash,
            paymentHash: paymentHash || invoiceId,
            kya_id,
            kind,
            amountSats: paid,
            source: source || 'unknown',
        });
        await client.query('COMMIT');
        if (res.duplicate) {
            log.info({ kya_id, invoiceId }, 'elite listing payment duplicate');
            return { handled: true, ok: true, duplicate: true };
        }
        log.info({ kya_id, kind, amountSats: paid, source }, 'elite listing payment applied');
        return { handled: true, ok: true };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        log.error({ err: e.message, kya_id }, 'elite listing payment FAIL');
        return { handled: true, ok: false, error: e.message };
    } finally {
        client.release();
    }
}

module.exports = {
    cfgSummary,
    HEARTBEAT_DAYS,
    GRACE_DAYS,
    HEARTBEAT_SATS,
    REACTIVATION_SATS,
    sweep,
    getPublicStatus,
    createPayInvoice,
    redeemFreeReactivation,
    handlePaymentSettled,
    _verifyListingSignature,
    _nextDueFrom,
};
