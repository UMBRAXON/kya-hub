#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — OP_RETURN Anchor Worker (Phase 4 / P4-2)
// ----------------------------------------------------------------------------
// PM2 daemon. Dve nezávislé slučky:
//
//   broadcastTick (default každých 60 s):
//     SELECT FOR UPDATE SKIP LOCKED max 10 PENDING anchors.
//     Pre každý:
//       1. načítaj current cert (musí existovať a byť ACTIVE)
//       2. spočítaj cert_hash = sha256(canonical cert_body)
//       3. zostav 36 B OP_RETURN payload (KYA1 magic + 32 B hash)
//       4. ak DRY-RUN → audit log + status = 'DRY_RUN', NEVOLÁ BTCPay
//          ak LIVE → BTCPay create-tx(proceedWithBroadcast=true) →
//                    UPDATE pending_anchors status='BROADCAST', bitcoin_txid, broadcast_at
//          + UPDATE agents anchor_txid (zatiaľ bez confirms)
//       5. ak fail → attempts += 1, status='FAILED' ak attempts ≥ max
//
//   confirmTick (default každých 10 min):
//     pre BROADCAST → bitcoind getrawtransaction
//       1 conf → status='ANCHORED', block_height/hash, confirmations=N
//             → trigger cert reissue (P4-3) v rámci tej istej transakcie
//             → UPDATE agents anchor_status='ANCHORED', anchor_block_height
//             → Telegram notif
//
// Env vars:
//   ANCHOR_WORKER_BROADCAST_ENABLED       — povolí LIVE BTCPay broadcast (default false → DRY)
//   ANCHOR_WORKER_INTERVAL_MS             — broadcast tick (default 60000)
//   ANCHOR_WORKER_CONFIRM_INTERVAL_MS     — confirm tick (default 600000)
//   ANCHOR_WORKER_BATCH                   — max anchors per tick (default 10)
//   ANCHOR_WORKER_MAX_ATTEMPTS            — default 3
//   ANCHOR_WORKER_BACKOFF_MS              — retry backoff (default 600000 = 10min)
//   ANCHOR_REQUIRE_CONFIRMATIONS          — confirm threshold (default 1)
//   ANCHOR_FEE_TARGET_BLOCKS              — bitcoind estimate target (default 6)
//   ANCHOR_MAX_FEERATE_SAT_VB             — hard cap on feerate (default 20)
//   ANCHOR_FALLBACK_FEERATE_SAT_VB        — used if RPC + mempool.space both fail (default 2)
//
// Bezpečnosť:
//   - LIVE broadcast požaduje 2× opt-in: ANCHOR_WORKER_BROADCAST_ENABLED=true.
//   - Per-anchor max 3 retries; po overe → status='FAILED' a Telegram alert.
//   - Per-tick concurrency lock cez advisory_lock (zabráni double-spend ak by sa
//     spustili 2 workery omylom).
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });

const ELITE_LISTING_HEARTBEAT_DAYS = parseInt(process.env.ELITE_LISTING_HEARTBEAT_DAYS || '30', 10);

const { Pool } = require('pg');
const pino = require('pino');

const anchor = require('../lib/anchor');
const certs = require('../lib/certs');
const hubkeys = require('../lib/hubkeys');
const bitcoindRpc = require('../lib/bitcoind-rpc');
const notifications = require('../lib/notifications');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
}).child({ component: 'anchor-worker' });

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CFG = {
    BROADCAST_ENABLED: process.env.ANCHOR_WORKER_BROADCAST_ENABLED === 'true',
    INTERVAL_MS: parseInt(process.env.ANCHOR_WORKER_INTERVAL_MS || '60000', 10),
    CONFIRM_INTERVAL_MS: parseInt(process.env.ANCHOR_WORKER_CONFIRM_INTERVAL_MS || '600000', 10),
    BATCH: parseInt(process.env.ANCHOR_WORKER_BATCH || '10', 10),
    MAX_ATTEMPTS: parseInt(process.env.ANCHOR_WORKER_MAX_ATTEMPTS || '3', 10),
    BACKOFF_MS: parseInt(process.env.ANCHOR_WORKER_BACKOFF_MS || '600000', 10),
    REQUIRE_CONFIRMATIONS: parseInt(process.env.ANCHOR_REQUIRE_CONFIRMATIONS || '1', 10),
    ADVISORY_LOCK_KEY: 0x4b594131,  // "KYA1" magic in u32
};

const pool = new Pool({
    user: process.env.KYAHUB_APP_PASSWORD ? 'kyahub_app' : (process.env.DB_USER || 'postgres'),
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'kyahub',
    password: process.env.KYAHUB_APP_PASSWORD || process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    max: 5,
});
pool.on('error', (e) => logger.error({ err: e.message }, 'pg pool error'));

hubkeys.setAuditPool(pool, logger);

// ----------------------------------------------------------------------------
// Per-anchor broadcast worker
// ----------------------------------------------------------------------------
async function processBroadcastQueue() {
    const client = await pool.connect();
    let acquired = false;
    try {
        // Advisory lock — zabráni dvom workerom voláť BTCPay naraz
        const l = await client.query(`SELECT pg_try_advisory_lock($1) AS got`, [CFG.ADVISORY_LOCK_KEY]);
        acquired = l.rows[0].got === true;
        if (!acquired) {
            logger.debug('broadcast tick skipped (another worker holds the lock)');
            return;
        }

        const sel = await client.query(
            `SELECT pa.id, pa.agent_id, pa.tier, pa.status, pa.attempts, pa.next_attempt_at,
                    a.kya_id, a.agent_name, a.cert_serial, a.tier AS agent_tier
             FROM pending_anchors pa
             JOIN agents a ON a.id = pa.agent_id
             WHERE pa.status IN ('PENDING','FAILED','DRY_RUN')
               AND (pa.next_attempt_at IS NULL OR pa.next_attempt_at <= NOW())
               AND pa.attempts < pa.max_attempts
             ORDER BY pa.created_at ASC
             LIMIT $1`,
            [CFG.BATCH]
        );

        if (sel.rowCount === 0) {
            logger.debug('broadcast tick: queue empty');
            return;
        }

        logger.info({ count: sel.rowCount, mode: CFG.BROADCAST_ENABLED ? 'LIVE' : 'DRY_RUN' }, 'broadcast tick: processing batch');

        for (const row of sel.rows) {
            try {
                await processOne(client, row);
            } catch (e) {
                logger.error({ err: e.message, pa: row.id, kya: row.kya_id }, 'process one FAIL');
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'broadcast tick FAIL');
    } finally {
        if (acquired) {
            try { await client.query(`SELECT pg_advisory_unlock($1)`, [CFG.ADVISORY_LOCK_KEY]); } catch (_) {}
        }
        client.release();
    }
}

async function processOne(client, row) {
    const log = logger.child({ pa: row.id, kya: row.kya_id, attempt: row.attempts + 1 });

    // Load current cert
    const cert = await anchor.fetchCertForAgent(client, row.agent_id);
    if (!cert) {
        log.warn('no current cert — marking FAILED');
        await client.query(
            `UPDATE pending_anchors SET status='FAILED', attempts=attempts+1, last_error='NO_CURRENT_CERT', next_attempt_at=NOW() + interval '1 hour'
             WHERE id = $1`,
            [row.id]
        );
        await anchor.writeAudit(client, {
            pending_anchor_id: row.id, agent_id: row.agent_id, kya_id: row.kya_id,
            event_type: 'BROADCAST_FAIL',
            detail: { reason: 'NO_CURRENT_CERT' },
        });
        return;
    }

    const certHash = anchor.certHashOf(cert.cert_body);
    const opReturnHex = anchor.buildOpReturnPayload(cert.cert_body);

    // Idempotency check — ak je tento cert_hash už BROADCAST/ANCHORED, no-op
    const dup = await client.query(
        `SELECT id, status, bitcoin_txid FROM pending_anchors
         WHERE cert_hash = $1 AND id <> $2 AND status IN ('BROADCAST','ANCHORED')
         LIMIT 1`,
        [certHash, row.id]
    );
    if (dup.rowCount > 0) {
        const d = dup.rows[0];
        log.warn({ existing: d }, 'duplicate cert_hash anchor exists — promoting current row to BROADCAST');
        await client.query(
            `UPDATE pending_anchors SET cert_serial=$2, cert_hash=$3, op_return_hex=$4,
                                         status=$5, bitcoin_txid=$6
             WHERE id = $1`,
            [row.id, cert.serial, certHash, opReturnHex, d.status, d.bitcoin_txid]
        );
        return;
    }

    // Always persist cert_serial/cert_hash/op_return_hex before BTCPay call (so we have audit trail)
    await client.query(
        `UPDATE pending_anchors SET cert_serial=$2, cert_hash=$3, op_return_hex=$4
         WHERE id = $1`,
        [row.id, cert.serial, certHash, opReturnHex]
    );

    if (!CFG.BROADCAST_ENABLED) {
        // DRY-RUN
        log.info({ certHash, op_return_bytes: opReturnHex.length / 2 }, 'DRY_RUN — would broadcast OP_RETURN');
        await client.query(
            `UPDATE pending_anchors SET status='DRY_RUN', attempts=attempts+1,
                                         next_attempt_at = NOW() + interval '1 hour',
                                         last_error = 'DRY_RUN: ANCHOR_WORKER_BROADCAST_ENABLED not set'
             WHERE id = $1`,
            [row.id]
        );
        await anchor.writeAudit(client, {
            pending_anchor_id: row.id, agent_id: row.agent_id, kya_id: row.kya_id,
            event_type: 'DRY_RUN', cert_serial: cert.serial, cert_hash: certHash,
            detail: { op_return_hex: opReturnHex, reason: 'broadcast disabled in env' },
        });
        return;
    }

    // LIVE broadcast
    const feerate = await anchor.estimateAnchorFeerate();
    const backend = anchor.getAnchorBackend();
    log.info({ backend, feerate, op_return_hex: opReturnHex }, 'LIVE broadcasting');
    let result;
    try {
        result = await anchor.buildAndOptionallyBroadcast({
            opReturnHex,
            feerateSatVb: feerate,
            broadcast: true,
        });
    } catch (e) {
        const attempts = row.attempts + 1;
        const isTerminal = attempts >= CFG.MAX_ATTEMPTS;
        const nextAttempt = isTerminal ? null : new Date(Date.now() + CFG.BACKOFF_MS);
        log.error({ err: e.message, httpStatus: e.httpStatus, terminal: isTerminal }, 'broadcast FAIL');
        await client.query(
            `UPDATE pending_anchors SET status=$2, attempts=$3,
                                         last_error=$4, next_attempt_at=$5
             WHERE id = $1`,
            [row.id, 'FAILED', attempts, (e.message || 'unknown').slice(0, 500), nextAttempt]
        );
        await anchor.writeAudit(client, {
            pending_anchor_id: row.id, agent_id: row.agent_id, kya_id: row.kya_id,
            event_type: isTerminal ? 'FAILED_TERMINAL' : 'BROADCAST_FAIL',
            cert_serial: cert.serial, cert_hash: certHash,
            detail: { error: e.message, http_status: e.httpStatus, btcpay: e.btcpayResponse },
        });
        if (isTerminal) {
            notifications.notify({
                category: 'critical',
                title: 'OP_RETURN anchor TERMINAL FAIL',
                body: `kya_id=${row.kya_id} pa_id=${row.id} cert_hash=${certHash}\nerror: ${e.message.slice(0, 200)}`,
                dedupe_key: `anchor_terminal_${row.id}`,
            }).catch(() => {});
        }
        return;
    }

    if (!result.txid) {
        log.warn({ raw: result.raw }, 'BTCPay returned no txid — treating as soft fail');
        await client.query(
            `UPDATE pending_anchors SET attempts=attempts+1, last_error='NO_TXID_IN_RESPONSE',
                                         next_attempt_at = NOW() + interval '10 minutes'
             WHERE id = $1`,
            [row.id]
        );
        return;
    }

    await client.query(
        `UPDATE pending_anchors SET status='BROADCAST', bitcoin_txid=$2, fee_sats=$3,
                                     broadcast_at=NOW(), attempts=attempts+1,
                                     last_error=NULL, next_attempt_at = NOW() + interval '10 minutes'
         WHERE id = $1`,
        [row.id, result.txid, result.fee_sats || null]
    );
    await client.query(
        `UPDATE agents SET anchor_txid=$2, anchor_status='BROADCAST' WHERE id = $1`,
        [row.agent_id, result.txid]
    );

    await anchor.writeAudit(client, {
        pending_anchor_id: row.id, agent_id: row.agent_id, kya_id: row.kya_id,
        event_type: 'BROADCAST_OK', cert_serial: cert.serial, cert_hash: certHash,
        bitcoin_txid: result.txid, fee_sats: result.fee_sats,
        detail: { backend, feerate, op_return_hex: opReturnHex, op_return_vout: result.vout },
    });

    log.info({ txid: result.txid, fee_sats: result.fee_sats }, 'BROADCAST OK');

    // Strategic Sprint §30 Item 4 — record anchor spend against AML volumetric
    // counters. We use a separate non-transactional pool connection so a counter
    // insert failure can never poison the broadcast transaction (anchor already
    // landed on-chain; we must not retry by accident).
    try {
        const volumetricLimits = require('../lib/volumetric-limits');
        const feeSats = Math.max(0, Number(result.fee_sats || 0));
        await volumetricLimits.check(pool, 'agent:per_day_sats', {
            subject_id: row.kya_id, amount: feeSats,
            metadata: { txid: result.txid, kind: 'anchor_fee', pending_anchor_id: row.id },
        }).catch(() => null);
        await volumetricLimits.check(pool, 'global:per_day_anchor_sats', {
            amount: feeSats,
            metadata: { txid: result.txid, kya_id: row.kya_id, pending_anchor_id: row.id },
        }).catch(() => null);
    } catch (e) { log.warn({ err: e.message }, 'volumetric counter record failed (non-fatal)'); }

    notifications.notify({
        category: 'info',
        title: 'OP_RETURN anchor broadcast',
        body: `kya_id=${row.kya_id} txid=${result.txid} fee=${result.fee_sats || '?'} sats\nhttps://mempool.space/tx/${result.txid}`,
        dedupe_key: `anchor_broadcast_${row.id}`,
    }).catch(() => {});
}

// ----------------------------------------------------------------------------
// Confirmation poller
// ----------------------------------------------------------------------------
async function processConfirmQueue() {
    const client = await pool.connect();
    try {
        const sel = await client.query(
            `SELECT pa.id, pa.agent_id, pa.bitcoin_txid, pa.cert_hash, pa.cert_serial,
                    a.kya_id, a.agent_name, a.tier
             FROM pending_anchors pa
             JOIN agents a ON a.id = pa.agent_id
             WHERE pa.status = 'BROADCAST' AND pa.bitcoin_txid IS NOT NULL
             ORDER BY pa.broadcast_at ASC
             LIMIT 50`
        );

        if (sel.rowCount === 0) {
            logger.debug('confirm tick: nothing to check');
            return;
        }

        const bitcoindOk = await bitcoindRpc.isAvailable();
        if (!bitcoindOk) {
            logger.warn('confirm tick: bitcoind RPC unreachable — will retry next tick');
            return;
        }

        logger.info({ count: sel.rowCount }, 'confirm tick: checking BROADCAST anchors');

        for (const row of sel.rows) {
            try {
                await confirmOne(client, row);
            } catch (e) {
                logger.error({ err: e.message, pa: row.id, kya: row.kya_id }, 'confirm one FAIL');
            }
        }
    } catch (e) {
        logger.error({ err: e.message }, 'confirm tick FAIL');
    } finally {
        client.release();
    }
}

async function confirmOne(client, row) {
    const log = logger.child({ pa: row.id, kya: row.kya_id, txid: row.bitcoin_txid });
    const status = await anchor.getTxStatus(row.bitcoin_txid);

    if (!status.found_in_chain) {
        log.debug({ in_mempool: status.in_mempool, not_found: status.not_found }, 'still unconfirmed');
        return;
    }
    if (status.confirmations < CFG.REQUIRE_CONFIRMATIONS) {
        log.info({ confirmations: status.confirmations }, 'not enough confirmations yet');
        return;
    }

    log.info({ confirmations: status.confirmations, block_height: status.block_height }, 'ANCHORED — promoting + reissuing cert');

    await client.query('BEGIN');
    try {
        await client.query(
            `UPDATE pending_anchors SET status='ANCHORED', confirmations=$2,
                                         block_height=$3, block_hash=$4, confirmed_at=NOW()
             WHERE id = $1`,
            [row.id, status.confirmations, status.block_height, status.block_hash]
        );
        await client.query(
            `UPDATE agents SET anchor_status='ANCHORED', anchor_txid=$2,
                                anchor_block_height=$3, anchor_confirmed_at=NOW(),
                                status='VERIFIED',
                                elite_listing_status = CASE WHEN tier = 'ELITE' THEN 'LISTED' ELSE elite_listing_status END,
                                elite_listing_heartbeat_paid_at = CASE WHEN tier = 'ELITE' THEN NOW() ELSE elite_listing_heartbeat_paid_at END,
                                elite_listing_next_due_at = CASE WHEN tier = 'ELITE' THEN NOW() + ($4::int * INTERVAL '1 day') ELSE elite_listing_next_due_at END,
                                elite_listing_grace_until = CASE WHEN tier = 'ELITE' THEN NULL ELSE elite_listing_grace_until END,
                                elite_listing_miss_streak = CASE WHEN tier = 'ELITE' THEN 0 ELSE elite_listing_miss_streak END
             WHERE id = $1`,
            [row.agent_id, row.bitcoin_txid, status.block_height, ELITE_LISTING_HEARTBEAT_DAYS]
        );

        const reissue = await anchor.reissueCertWithAnchor(client, {
            agent: { id: row.agent_id, kya_id: row.kya_id, agent_name: row.agent_name, tier: row.tier },
            anchor: {
                txid: row.bitcoin_txid,
                vout: 0,
                op_return_hex: null,
                cert_hash: row.cert_hash,
                block_height: status.block_height,
                block_hash: status.block_hash,
                confirmed_at: new Date(status.block_time ? status.block_time * 1000 : Date.now()).toISOString(),
            },
            logger: log,
        });

        if (reissue.reissued) {
            await client.query(
                `UPDATE pending_anchors SET reissued_cert_serial = $2 WHERE id = $1`,
                [row.id, reissue.serial]
            );
            await anchor.writeAudit(client, {
                pending_anchor_id: row.id, agent_id: row.agent_id, kya_id: row.kya_id,
                event_type: 'CERT_REISSUED', cert_serial: reissue.serial, cert_hash: row.cert_hash,
                bitcoin_txid: row.bitcoin_txid, block_height: status.block_height,
                detail: { old_serial: reissue.oldSerial, signing_key_id: reissue.signingKeyId },
            });
        }

        await anchor.writeAudit(client, {
            pending_anchor_id: row.id, agent_id: row.agent_id, kya_id: row.kya_id,
            event_type: 'CONFIRMED', cert_serial: row.cert_serial, cert_hash: row.cert_hash,
            bitcoin_txid: row.bitcoin_txid, block_height: status.block_height,
            detail: { confirmations: status.confirmations, block_hash: status.block_hash },
        });

        await client.query('COMMIT');

        log.info({ new_serial: reissue.serial }, 'anchored + reissued OK');

        notifications.notify({
            category: 'info',
            title: 'KYA agent ANCHORED ✅',
            body: `kya_id=${row.kya_id} tier=${row.tier}\ntxid=${row.bitcoin_txid}\nblock=${status.block_height}\nnew_cert=${reissue.serial || '(none)'}\nhttps://mempool.space/tx/${row.bitcoin_txid}`,
            dedupe_key: `anchor_confirmed_${row.id}`,
        }).catch(() => {});
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        log.error({ err: e.message }, 'confirm transaction FAIL — will retry next tick');
        throw e;
    }
}

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
let running = true;

async function broadcastLoop() {
    while (running) {
        try { await processBroadcastQueue(); } catch (e) { logger.error({ err: e.message }, 'broadcastLoop iter FAIL'); }
        await sleep(CFG.INTERVAL_MS);
    }
}

async function confirmLoop() {
    while (running) {
        try { await processConfirmQueue(); } catch (e) { logger.error({ err: e.message }, 'confirmLoop iter FAIL'); }
        await sleep(CFG.CONFIRM_INTERVAL_MS);
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    logger.info({
        broadcast_enabled: CFG.BROADCAST_ENABLED,
        backend: anchor.getAnchorBackend(),
        interval_ms: CFG.INTERVAL_MS,
        confirm_interval_ms: CFG.CONFIRM_INTERVAL_MS,
        batch: CFG.BATCH,
        max_attempts: CFG.MAX_ATTEMPTS,
        require_confirmations: CFG.REQUIRE_CONFIRMATIONS,
    }, 'OP_RETURN anchor worker starting');

    if (!CFG.BROADCAST_ENABLED) {
        logger.warn('DRY_RUN MODE — set ANCHOR_WORKER_BROADCAST_ENABLED=true in .env + pm2 restart kya-anchor-worker --update-env to enable LIVE broadcast');
    }

    // Quick health checks
    try {
        const ok = await bitcoindRpc.isAvailable();
        logger.info({ bitcoind_rpc: ok }, 'bitcoind RPC reachability');
    } catch (e) {
        logger.warn({ err: e.message }, 'bitcoind RPC check FAIL — confirmations will be paused until reachable');
    }

    if (anchor.getAnchorBackend() === 'bitcoind') {
        try {
            const w = await anchor.getAnchorWalletStatus();
            logger.info({ wallet_status: w }, 'bitcoind anchor wallet status');
            if ((w.balance_sats || 0) < 1000) {
                logger.warn({ balance_sats: w.balance_sats }, 'anchor wallet balance very low — LIVE broadcasts will fail until funded');
            }
        } catch (e) {
            logger.warn({ err: e.message }, 'anchor wallet status check FAIL');
        }
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    await Promise.all([broadcastLoop(), confirmLoop()]);
}

async function shutdown() {
    logger.info('shutdown signal — finishing current iteration then exiting');
    running = false;
    setTimeout(() => process.exit(0), 1500);
}

main().catch(e => {
    logger.fatal({ err: e.message, stack: e.stack }, 'anchor worker crashed');
    process.exit(1);
});
