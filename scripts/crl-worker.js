#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — CRL Worker (Phase 5)
// ----------------------------------------------------------------------------
// PM2 daemon (or one-shot via `node scripts/crl-worker.js --once`). Does:
//
//   1. crlAnchorTick (default once every 24 h):
//      - SELECT all revocation_events with crl_anchor_id IS NULL
//      - If empty → no-op (or 'no_revocations' notification once every N days)
//      - Build Merkle tree, compute root + per-leaf proofs
//      - INSERT crl_anchors row (status='PENDING', op_return_hex, tree_snapshot)
//      - If LIVE → broadcast OP_RETURN via lib/anchor.bitcoindBuildAndOptionallyBroadcast
//                   with magic='KYAR' (4B "KYAR" + 32B Merkle root)
//                 → UPDATE crl_anchors status='BROADCAST', bitcoin_txid, fee_sats
//      - UPDATE all included revocation_events with crl_anchor_id, crl_anchored_at,
//        merkle_leaf_index, merkle_proof
//      - Generate signed CRL JSON file → /root/kya-hub/public/crl/crl-YYYY-MM-DD.json
//      - INSERT crl_signed_files row
//
//   2. crlConfirmTick (default every 10 min, just like anchor-worker):
//      - For status='BROADCAST' rows, poll lib/anchor.getTxStatus
//      - If confirmations ≥ ANCHOR_REQUIRE_CONFIRMATIONS → status='ANCHORED'
//      - Telegram alert
//
// Env knobs:
//   CRL_WORKER_BROADCAST_ENABLED   — must be 'true' to broadcast on-chain (default false → DRY_RUN)
//   CRL_WORKER_INTERVAL_MS         — anchor tick (default 24h)
//   CRL_WORKER_CONFIRM_INTERVAL_MS — confirm tick (default 10min)
//   CRL_WORKER_BATCH_MAX           — max leaves per epoch (default 10000)
//   CRL_WORKER_MIN_LEAVES          — skip epoch if fewer than N new revocations (default 0)
//   CRL_PUBLIC_DIR                 — where to write signed CRL JSON (default /root/kya-hub/public/crl)
//   CRL_PUBLIC_BASE_URL            — used in signed JSON 'issuer.url' (defaults to HUB_URL)
//
// Bezpečnosť (Phase 5 gate model — same as anchor worker Phase 4):
//   - LIVE broadcast vyžaduje EXPLICITNE CRL_WORKER_BROADCAST_ENABLED=true.
//   - Per-epoch advisory lock zabráni súbežnému anchor + CRL broadcastu.
//   - Cieľ ~ 200-500 sat/24h (jediný OP_RETURN denne).
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const pino = require('pino');

const anchor = require('../lib/anchor');
const bitcoindRpc = require('../lib/bitcoind-rpc');
const crl = require('../lib/crl');
const notifications = require('../lib/notifications');
const hubkeys = require('../lib/hubkeys');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
}).child({ component: 'crl-worker' });

const CFG = {
    BROADCAST_ENABLED: process.env.CRL_WORKER_BROADCAST_ENABLED === 'true',
    INTERVAL_MS: parseInt(process.env.CRL_WORKER_INTERVAL_MS || String(24 * 3600 * 1000), 10),
    CONFIRM_INTERVAL_MS: parseInt(process.env.CRL_WORKER_CONFIRM_INTERVAL_MS || '600000', 10),
    BATCH_MAX: parseInt(process.env.CRL_WORKER_BATCH_MAX || '10000', 10),
    MIN_LEAVES: parseInt(process.env.CRL_WORKER_MIN_LEAVES || '0', 10),
    MAX_ATTEMPTS: parseInt(process.env.CRL_WORKER_MAX_ATTEMPTS || '3', 10),
    BACKOFF_MS: parseInt(process.env.CRL_WORKER_BACKOFF_MS || '3600000', 10),
    REQUIRE_CONFIRMATIONS: parseInt(process.env.ANCHOR_REQUIRE_CONFIRMATIONS || '1', 10),
    PUBLIC_DIR: process.env.CRL_PUBLIC_DIR || path.join(__dirname, '..', 'public', 'crl'),
    PUBLIC_BASE_URL: process.env.CRL_PUBLIC_BASE_URL || process.env.HUB_URL || null,
    ADVISORY_LOCK_KEY: 0x4b594152, // "KYAR" magic as u32 — same trick as anchor worker
};

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(arr) {
    const out = { once: false, forceAnchor: false, dryRun: false };
    for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (a === '--once') out.once = true;
        else if (a === '--force') out.forceAnchor = true;
        else if (a === '--dry-run' || a === '--dry') out.dryRun = true;
        else if (a === '--help' || a === '-h') {
            console.log('Usage: node scripts/crl-worker.js [--once] [--force] [--dry-run]');
            process.exit(0);
        }
    }
    return out;
}

const pool = new Pool({
    user: process.env.KYAHUB_APP_PASSWORD ? 'kyahub_app' : (process.env.DB_USER || 'postgres'),
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'kyahub',
    password: process.env.KYAHUB_APP_PASSWORD || process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    max: 3,
});
pool.on('error', (e) => logger.error({ err: e.message }, 'pg pool error'));

hubkeys.setAuditPool(pool, logger);

// ----------------------------------------------------------------------------
// Anchor epoch
// ----------------------------------------------------------------------------
async function anchorEpoch({ broadcastOverride = null, forceEvenIfEmpty = false } = {}) {
    const client = await pool.connect();
    let acquired = false;
    try {
        const l = await client.query(`SELECT pg_try_advisory_lock($1) AS got`, [CFG.ADVISORY_LOCK_KEY]);
        acquired = l.rows[0].got === true;
        if (!acquired) {
            logger.warn('crl anchor skipped (another CRL worker holds advisory lock)');
            return { skipped: 'lock_held' };
        }

        // Collect un-anchored revocation events (ordered by id for determinism)
        const sel = await client.query(
            `SELECT id, cert_serial, kya_id, agent_id,
                    revoked_at, revoked_by, revocation_reason, revocation_category,
                    cert_hash, revocation_hash, detail
             FROM revocation_events
             WHERE crl_anchor_id IS NULL
             ORDER BY id ASC
             LIMIT $1`,
            [CFG.BATCH_MAX]
        );
        if (sel.rowCount === 0 && !forceEvenIfEmpty) {
            logger.info('crl anchor: no un-anchored revocations — skipping epoch');
            return { skipped: 'no_revocations' };
        }
        const rows = sel.rows;
        const leaves = rows.map(r => r.revocation_hash);

        const tree = crl.buildMerkleTree(leaves);
        const epochId = crl.epochIdFor(new Date());
        const epochLabel = crl.epochLabelFor(new Date());
        const opReturnHex = crl.buildCrlOpReturnPayload(tree.root);

        // Check if this epoch already exists (idempotency — daily cadence
        // means same epoch_id within the same UTC day). If a prior epoch
        // exists and is still PENDING/BROADCAST/ANCHORED, return that row.
        const existing = await client.query(
            `SELECT * FROM crl_anchors WHERE epoch_id = $1`,
            [epochId]
        );
        if (existing.rowCount > 0) {
            const e = existing.rows[0];
            // If the existing epoch has DIFFERENT root (would only happen
            // with a logic bug), surface a critical alert. Otherwise just
            // return idempotent.
            if (e.merkle_root !== tree.root) {
                logger.error({
                    existing_root: e.merkle_root, new_root: tree.root,
                    epoch_id: epochId,
                }, 'CRL epoch already exists with DIFFERENT root — refusing to override');
                return { skipped: 'epoch_root_mismatch', existing: e };
            }
            logger.info({ epoch_id: epochId, status: e.status, txid: e.bitcoin_txid }, 'crl epoch already exists — no-op');
            return { skipped: 'epoch_exists', existing: e };
        }

        logger.info({
            epoch_id: epochId, epoch_label: epochLabel,
            leaf_count: leaves.length,
            merkle_root: tree.root,
            op_return_hex: opReturnHex,
        }, 'CRL epoch built — preparing anchor');

        const willBroadcast = broadcastOverride === null ? CFG.BROADCAST_ENABLED : !!broadcastOverride;
        const initialStatus = willBroadcast ? 'PENDING' : 'DRY_RUN';

        // INSERT pending CRL anchor row (with tree_snapshot for offline lookup)
        const treeSnapshot = {
            levels: tree.levels,           // full Merkle levels (root last)
            leafCount: tree.leafCount,
            leafIds: rows.map(r => r.id),  // map leaf-position → revocation_events.id
        };
        const ins = await client.query(
            `INSERT INTO crl_anchors (
                epoch_id, epoch_label, merkle_root, leaf_count, op_return_hex,
                status, tree_snapshot, attempts, max_attempts
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING id`,
            [
                epochId, epochLabel, tree.root, leaves.length, opReturnHex,
                initialStatus, JSON.stringify(treeSnapshot), 0, CFG.MAX_ATTEMPTS,
            ]
        );
        const crlAnchorId = ins.rows[0].id;

        // Stamp each revocation_event with its leaf index + proof.
        // We do this BEFORE broadcast so the proofs are queryable even
        // during DRY_RUN epochs.
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const p = crl.buildProof(tree, i);
            await client.query(
                `UPDATE revocation_events
                 SET crl_anchor_id = $1,
                     crl_anchored_at = NOW(),
                     merkle_leaf_index = $2,
                     merkle_proof = $3
                 WHERE id = $4`,
                [crlAnchorId, i, JSON.stringify(p.proof), r.id]
            );
        }

        // Broadcast (or DRY_RUN)
        let bcResult = null;
        if (willBroadcast) {
            try {
                const feerate = await anchor.estimateAnchorFeerate();
                logger.info({ feerate, op_return_hex: opReturnHex }, 'LIVE CRL anchor broadcasting via bitcoind');
                bcResult = await anchor.buildAndOptionallyBroadcast({
                    opReturnHex,
                    feerateSatVb: feerate,
                    broadcast: true,
                });
                await client.query(
                    `UPDATE crl_anchors
                     SET status='BROADCAST', bitcoin_txid=$2, fee_sats=$3,
                         broadcast_at=NOW(), attempts=attempts+1, last_error=NULL,
                         next_attempt_at = NOW() + interval '10 minutes'
                     WHERE id=$1`,
                    [crlAnchorId, bcResult.txid, bcResult.fee_sats || null]
                );
                logger.info({ crl_anchor_id: crlAnchorId, txid: bcResult.txid }, 'CRL OP_RETURN BROADCAST OK');
            } catch (e) {
                logger.error({ err: e.message, crl_anchor_id: crlAnchorId }, 'CRL broadcast FAIL');
                await client.query(
                    `UPDATE crl_anchors SET status='FAILED', attempts=attempts+1,
                                            last_error=$2, next_attempt_at=NOW()+interval '1 hour'
                     WHERE id=$1`,
                    [crlAnchorId, (e.message || 'unknown').slice(0, 500)]
                );
                notifications.notify({
                    category: 'critical',
                    title: 'CRL anchor BROADCAST FAIL',
                    body: `epoch=${epochLabel} leaves=${leaves.length}\nerror: ${(e.message || '').slice(0, 200)}`,
                    dedupe_key: `crl_broadcast_fail_${epochId}`,
                }).catch(() => {});
                return {
                    anchored: false, error: e.message,
                    crl_anchor_id: crlAnchorId, epoch_id: epochId, epoch_label: epochLabel,
                };
            }
        } else {
            logger.warn({ crl_anchor_id: crlAnchorId, leaves: leaves.length, op_return_hex: opReturnHex }, 'DRY_RUN — would broadcast CRL OP_RETURN');
            await client.query(
                `UPDATE crl_anchors SET status='DRY_RUN', last_error='DRY_RUN: CRL_WORKER_BROADCAST_ENABLED not set'
                 WHERE id=$1`,
                [crlAnchorId]
            );
        }

        // Generate signed CRL JSON file. We do this AFTER broadcast attempt
        // so we can include bitcoin_txid in the file.
        const finalRow = (await client.query(`SELECT * FROM crl_anchors WHERE id=$1`, [crlAnchorId])).rows[0];
        const file = await generateSignedCrlFile(client, finalRow, rows, tree);

        notifications.notify({
            category: willBroadcast ? 'info' : 'warning',
            title: willBroadcast ? 'CRL epoch broadcast' : 'CRL epoch built (DRY_RUN)',
            body: (
                `epoch: ${epochLabel}\n` +
                `leaves: ${leaves.length}\n` +
                `merkle_root: ${tree.root.slice(0, 16)}…\n` +
                `status: ${finalRow.status}\n` +
                (finalRow.bitcoin_txid ? `txid: ${finalRow.bitcoin_txid}\nhttps://mempool.space/tx/${finalRow.bitcoin_txid}\n` : '') +
                (file ? `signed_crl: ${file.relUrl} (${file.size_bytes} B, role=${file.signed_by_role})` : '')
            ),
            dedupe_key: `crl_epoch_${epochId}`,
        }).catch(() => {});

        return {
            anchored: willBroadcast && bcResult && !!bcResult.txid,
            crl_anchor_id: crlAnchorId,
            epoch_id: epochId, epoch_label: epochLabel,
            merkle_root: tree.root,
            leaf_count: leaves.length,
            op_return_hex: opReturnHex,
            status: finalRow.status,
            bitcoin_txid: finalRow.bitcoin_txid || null,
            fee_sats: finalRow.fee_sats || null,
            signed_file: file,
        };
    } finally {
        if (acquired) {
            try { await client.query(`SELECT pg_advisory_unlock($1)`, [CFG.ADVISORY_LOCK_KEY]); } catch (_) {}
        }
        client.release();
    }
}

// ----------------------------------------------------------------------------
// Signed CRL JSON file generator (Phase 5b)
// ----------------------------------------------------------------------------
async function generateSignedCrlFile(client, crlAnchorRow, revRows, tree) {
    const epochLabel = crlAnchorRow.epoch_label;
    const epochId = crlAnchorRow.epoch_id;
    try {
        fs.mkdirSync(CFG.PUBLIC_DIR, { recursive: true, mode: 0o755 });
    } catch (_) { /* best effort */ }

    // Per-revocation snippet with proof
    const revocations = revRows.map((r, i) => {
        const p = crl.buildProof(tree, i);
        return {
            cert_serial: r.cert_serial,
            kya_id: r.kya_id,
            revoked_at: crl.canonicalIsoMs(r.revoked_at),
            revoked_by: r.revoked_by,
            revocation_reason: r.revocation_reason || null,
            revocation_category: r.revocation_category || 'OTHER',
            revocation_hash: r.revocation_hash,
            merkle_leaf_index: i,
            merkle_proof: p.proof,
        };
    });

    const body = crl.buildCrlBody({
        epoch_id: epochId,
        epoch_label: epochLabel,
        merkle_root: crlAnchorRow.merkle_root,
        leaf_count: crlAnchorRow.leaf_count,
        bitcoin_txid: crlAnchorRow.bitcoin_txid || null,
        revocations,
        generated_at: new Date().toISOString(),
        issuer_url: CFG.PUBLIC_BASE_URL,
    });
    const signed = crl.signCrlBody(body, { role: 'ROOT' });
    const json = JSON.stringify(signed, null, 2) + '\n';
    const sha256 = crypto.createHash('sha256').update(json).digest('hex');
    const filename = `${epochLabel.toLowerCase()}.json`; // crl-2026-05-12.json
    const fullPath = path.join(CFG.PUBLIC_DIR, filename);
    const tmpPath = fullPath + '.tmp';
    fs.writeFileSync(tmpPath, json, { mode: 0o644 });
    fs.renameSync(tmpPath, fullPath);

    // ALSO maintain a stable `latest.json` symlink pointing at the newest epoch
    try {
        const latest = path.join(CFG.PUBLIC_DIR, 'latest.json');
        try { fs.unlinkSync(latest); } catch (_) {}
        fs.symlinkSync(filename, latest);
    } catch (_) { /* best effort — symlink failures don't break anything */ }

    // INSERT crl_signed_files row
    await client.query(
        `INSERT INTO crl_signed_files (
            crl_anchor_id, epoch_id, epoch_label,
            file_path, file_sha256, file_size_bytes,
            signed_by_role, signed_by_pubkey, signature_hex,
            revocation_count, bitcoin_txid, merkle_root
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (epoch_id) DO UPDATE SET
            file_sha256 = EXCLUDED.file_sha256,
            file_size_bytes = EXCLUDED.file_size_bytes,
            signature_hex = EXCLUDED.signature_hex,
            bitcoin_txid = EXCLUDED.bitcoin_txid,
            generated_at = NOW()`,
        [
            crlAnchorRow.id, epochId, epochLabel,
            fullPath, sha256, Buffer.byteLength(json, 'utf8'),
            signed.proof.signingRole || 'ROOT',
            (signed.proof.verificationMethod || '').match(/ed25519:([0-9a-fA-F]{64})/)?.[1] || null,
            signed.proof.signatureValue,
            revRows.length,
            crlAnchorRow.bitcoin_txid || null,
            crlAnchorRow.merkle_root,
        ]
    );

    // Also store signature into crl_anchors for convenience
    await client.query(
        `UPDATE crl_anchors SET
            crl_signature_hex = $2, crl_signed_by_role = $3, crl_signed_by_pubkey = $4
         WHERE id = $1`,
        [
            crlAnchorRow.id,
            signed.proof.signatureValue,
            signed.proof.signingRole || 'ROOT',
            (signed.proof.verificationMethod || '').match(/ed25519:([0-9a-fA-F]{64})/)?.[1] || null,
        ]
    );

    return {
        path: fullPath,
        relUrl: `/crl/${filename}`,
        size_bytes: Buffer.byteLength(json, 'utf8'),
        sha256,
        signed_by_role: signed.proof.signingRole || 'ROOT',
    };
}

// ----------------------------------------------------------------------------
// Confirmation poller
// ----------------------------------------------------------------------------
async function confirmTick() {
    const client = await pool.connect();
    try {
        const sel = await client.query(
            `SELECT id, bitcoin_txid, merkle_root, epoch_id, epoch_label
             FROM crl_anchors
             WHERE status = 'BROADCAST' AND bitcoin_txid IS NOT NULL
             ORDER BY broadcast_at ASC LIMIT 20`
        );
        if (sel.rowCount === 0) return;
        const okRpc = await bitcoindRpc.isAvailable();
        if (!okRpc) { logger.warn('confirm tick: bitcoind unavailable'); return; }
        for (const row of sel.rows) {
            try {
                const status = await anchor.getTxStatus(row.bitcoin_txid);
                if (!status.found_in_chain) continue;
                if ((status.confirmations || 0) < CFG.REQUIRE_CONFIRMATIONS) continue;
                await client.query(
                    `UPDATE crl_anchors
                     SET status='ANCHORED', confirmations=$2, block_height=$3,
                         block_hash=$4, confirmed_at=NOW()
                     WHERE id=$1`,
                    [row.id, status.confirmations, status.block_height, status.block_hash]
                );
                logger.info({
                    crl_anchor_id: row.id, txid: row.bitcoin_txid,
                    block_height: status.block_height,
                    confirmations: status.confirmations,
                }, 'CRL epoch ANCHORED');
                notifications.notify({
                    category: 'info',
                    title: 'CRL epoch ANCHORED ✅',
                    body: (
                        `epoch: ${row.epoch_label}\n` +
                        `merkle_root: ${row.merkle_root.slice(0, 16)}…\n` +
                        `txid: ${row.bitcoin_txid}\n` +
                        `block: ${status.block_height}\n` +
                        `https://mempool.space/tx/${row.bitcoin_txid}`
                    ),
                    dedupe_key: `crl_anchored_${row.id}`,
                }).catch(() => {});
            } catch (e) {
                logger.error({ err: e.message, crl_anchor_id: row.id }, 'CRL confirm one FAIL');
            }
        }
    } finally {
        client.release();
    }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
let running = true;

async function anchorLoop() {
    // On worker start: ALWAYS do one anchor tick immediately, then sleep INTERVAL.
    while (running) {
        try { await anchorEpoch(); }
        catch (e) { logger.error({ err: e.message }, 'anchorTick FAIL'); }
        await sleep(CFG.INTERVAL_MS);
    }
}

async function confirmLoop() {
    while (running) {
        try { await confirmTick(); }
        catch (e) { logger.error({ err: e.message }, 'confirmTick FAIL'); }
        await sleep(CFG.CONFIRM_INTERVAL_MS);
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    logger.info({
        broadcast_enabled: CFG.BROADCAST_ENABLED,
        interval_ms: CFG.INTERVAL_MS,
        confirm_interval_ms: CFG.CONFIRM_INTERVAL_MS,
        public_dir: CFG.PUBLIC_DIR,
        min_leaves: CFG.MIN_LEAVES,
    }, 'CRL worker starting');

    if (!CFG.BROADCAST_ENABLED) {
        logger.warn('DRY_RUN MODE — set CRL_WORKER_BROADCAST_ENABLED=true in .env + pm2 restart kya-crl-worker --update-env to enable LIVE broadcast');
    }

    if (ARGS.once || ARGS.forceAnchor) {
        const broadcast = ARGS.dryRun ? false : null;
        const res = await anchorEpoch({ broadcastOverride: broadcast, forceEvenIfEmpty: ARGS.forceAnchor });
        logger.info({ result: res }, 'one-shot anchor done');
        await pool.end();
        process.exit(0);
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    await Promise.all([anchorLoop(), confirmLoop()]);
}

async function shutdown() {
    logger.info('shutdown signal — finishing iteration then exiting');
    running = false;
    setTimeout(() => process.exit(0), 1500);
}

main().catch(e => {
    logger.fatal({ err: e.message, stack: e.stack }, 'crl worker crashed');
    process.exit(1);
});
