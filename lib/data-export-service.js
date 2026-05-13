// ============================================================================
// UMBRAXON KYA-Hub — Data Export Service (GDPR-aligned)
// Strategic Sprint §30 Item 8
// ----------------------------------------------------------------------------
// Implements `GET /api/agent/:kya_id/data-export` — agent-signed, async export.
//
// Why a service (not just a route)?
// ---------------------------------
//   - The DB joins span ~10 tables. We want one canonical, reviewable place.
//   - GDPR audit demands an append-only `data_exports` row per request.
//   - One-time download tokens are sha256-hashed in DB; only the agent receives
//     the plaintext, so even with a DB leak nobody can fetch the archive.
//   - Archives are written under /root/kya-hub/data-exports/ with chmod 600 so
//     the file system itself enforces "only the hub process can read".
//
// Threat model:
//   - Attacker who learnt only the agent's pubkey: cannot sign → no export.
//   - Attacker who learnt the kya_id + nonce + timestamp but not the privkey:
//     cannot sign → BAD_SIGNATURE.
//   - Attacker who breached the DB but not the disk: rows in data_exports
//     contain only sha256(token), and tokens are 32 bytes → infeasible to
//     guess. archive_path on disk is still chmod 600 (root).
//   - Attacker who got a stale token: tokens have a 1h hard expiry plus a
//     single-use semantic (download_count > 0 ⇒ 410 GONE on subsequent
//     attempts).
//   - Replay of the signed request body: nonce is unique per request and
//     timestamp must be within +/- 5 min (same window as retire / appeal).
//
// File layout on disk:
//   /root/kya-hub/data-exports/EXPORT-<kya_id>-<unix_ts>.json.zip
//   - Zip contains a single entry "data.json" with the dump payload.
//   - chmod 600. Pruner unlinks files whose data_exports.expires_at < now()
//     (handled by an external admin endpoint /api/admin/data-exports/prune).
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const EXPORT_DIR_DEFAULT = '/root/kya-hub/data-exports';
const EXPORT_TTL_SECONDS_DEFAULT = 3600;
const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const MAX_EXPORTS_PER_AGENT_PER_DAY_DEFAULT = 5;

function _cfg() {
    return {
        dir: process.env.DATA_EXPORT_DIR || EXPORT_DIR_DEFAULT,
        ttlSec: parseInt(process.env.DATA_EXPORT_TTL_SECONDS || EXPORT_TTL_SECONDS_DEFAULT, 10),
        publicBaseUrl: process.env.DATA_EXPORT_PUBLIC_BASE_URL || (process.env.HUB_PUBLIC_URL || ''),
        maxPerDay: parseInt(process.env.DATA_EXPORT_MAX_PER_DAY || MAX_EXPORTS_PER_AGENT_PER_DAY_DEFAULT, 10),
    };
}

function _ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
}

/**
 * Canonical signing payload for a data-export request. The agent signs
 * sha256(JSON.stringify(payload)) with its Ed25519 private key.
 */
function canonicalExportPayload({ kya_id, nonce, timestamp }) {
    return JSON.stringify({
        v: 1,
        op: 'data-export',
        kya_id: String(kya_id || ''),
        nonce: String(nonce || ''),
        timestamp: String(timestamp || ''),
    });
}

/**
 * Collect every DB row that references an agent across the schema.
 * Returns a plain JSON-safe object; secrets (e.g. payment_invoice_id) are
 * left in because the agent has the right to its own data.
 */
async function collectAgentDump(pool, kya_id, agentId) {
    const dump = {};
    const exec = async (label, sql, params) => {
        try {
            const r = await pool.query(sql, params);
            dump[label] = r.rows;
        } catch (e) {
            dump[label] = { error: e.message };
        }
    };

    await exec('agent',
        'SELECT * FROM agents WHERE kya_id = $1 OR id = $2',
        [kya_id, agentId]);
    await exec('certificates',
        'SELECT * FROM certificates WHERE kya_id = $1 ORDER BY issued_at DESC NULLS LAST',
        [kya_id]);
    await exec('reputation_events',
        'SELECT * FROM reputation_events WHERE kya_id = $1 OR agent_id = $2 ORDER BY occurred_at DESC',
        [kya_id, agentId]);
    await exec('reputation_events_archive',
        'SELECT * FROM reputation_events_archive WHERE kya_id = $1 OR agent_id = $2 ORDER BY id DESC',
        [kya_id, agentId]);
    await exec('action_log',
        'SELECT * FROM action_log WHERE agent_id = $1 OR kya_id = $2 ORDER BY id DESC',
        [agentId, kya_id]);
    await exec('reports_against_me',
        'SELECT * FROM reports WHERE target_agent_id = $1 OR target_kya_id = $2 ORDER BY id DESC',
        [agentId, kya_id]);
    await exec('reports_by_me',
        'SELECT * FROM reports WHERE reporter_kya_id = $1 ORDER BY id DESC',
        [kya_id]);
    await exec('appeals',
        'SELECT * FROM appeals WHERE kya_id = $1 OR agent_id = $2 ORDER BY id DESC',
        [kya_id, agentId]);
    await exec('heartbeats_log',
        'SELECT * FROM heartbeats_log WHERE agent_id = $1 ORDER BY received_at DESC LIMIT 1000',
        [agentId]);
    await exec('cert_signing_log',
        'SELECT * FROM cert_signing_log WHERE kya_id = $1 ORDER BY signed_at DESC',
        [kya_id]);
    await exec('pending_anchors',
        'SELECT * FROM pending_anchors WHERE agent_id = $1 ORDER BY created_at DESC',
        [agentId]);
    await exec('anchor_audit',
        'SELECT * FROM anchor_audit WHERE kya_id = $1 OR agent_id = $2 ORDER BY created_at DESC',
        [kya_id, agentId]);
    await exec('revocation_events',
        'SELECT * FROM revocation_events WHERE kya_id = $1 OR agent_id = $2 ORDER BY revoked_at DESC',
        [kya_id, agentId]);

    return dump;
}

async function _exportsThisDay(pool, kya_id) {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM data_exports
         WHERE kya_id = $1 AND requested_at > NOW() - INTERVAL '24 hours'`,
        [kya_id]);
    return r.rows[0]?.c || 0;
}

/**
 * Authenticate + build archive. Returns:
 *   { ok: true, export_id, download_token, download_url, expires_at,
 *     archive_size_bytes, archive_sha256 }
 *   { error: 'CODE', ... }
 */
async function createExport(pool, hubkeys, {
    kya_id, signature, nonce, timestamp, client_ip, user_agent
}) {
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id || '')) return { error: 'INVALID_KYA_ID' };
    if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) return { error: 'BAD_SIGNATURE_FORMAT' };
    if (!nonce || !/^[0-9a-fA-F]{16,64}$/.test(nonce)) return { error: 'INVALID_NONCE_FORMAT' };
    if (!timestamp) return { error: 'MISSING_TIMESTAMP' };
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        return { error: 'TIMESTAMP_SKEW' };
    }

    const ag = await pool.query(
        `SELECT id, kya_id, agent_pubkey, status, retired_at
           FROM agents WHERE kya_id = $1`,
        [kya_id]);
    if (ag.rowCount === 0) return { error: 'AGENT_NOT_FOUND' };
    const agent = ag.rows[0];
    if (!agent.agent_pubkey) return { error: 'AGENT_HAS_NO_PUBKEY' };

    const canonical = canonicalExportPayload({ kya_id, nonce, timestamp });
    const digest = crypto.createHash('sha256').update(canonical).digest();
    if (!hubkeys.verify(digest, signature, agent.agent_pubkey)) {
        return { error: 'BAD_SIGNATURE' };
    }

    const cfg = _cfg();
    const usedToday = await _exportsThisDay(pool, kya_id);
    if (usedToday >= cfg.maxPerDay) {
        return {
            error: 'RATE_LIMIT',
            limit: cfg.maxPerDay,
            used: usedToday,
            retry_after_seconds: 3600,
        };
    }

    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + cfg.ttlSec * 1000);
    const downloadToken = crypto.randomBytes(32).toString('hex');
    const tokenSha = crypto.createHash('sha256').update(downloadToken).digest('hex');

    _ensureDir(cfg.dir);
    const unixTs = Math.floor(requestedAt.getTime() / 1000);
    const filename = `EXPORT-${kya_id}-${unixTs}.json.zip`;
    const archivePath = path.join(cfg.dir, filename);

    const ins = await pool.query(
        `INSERT INTO data_exports
            (kya_id, agent_id, requested_at, status, download_token_sha256,
             expires_at, archive_path, request_signature, request_nonce,
             request_timestamp, client_ip, user_agent)
         VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
            kya_id, agent.id, requestedAt, tokenSha, expiresAt, archivePath,
            signature, nonce, new Date(timestamp),
            client_ip || null, user_agent || null,
        ]);
    const exportId = ins.rows[0].id;

    let archiveSize = 0;
    let archiveSha = null;
    try {
        const dump = await collectAgentDump(pool, kya_id, agent.id);
        const payload = {
            _meta: {
                kya_id,
                agent_id: agent.id,
                exported_at: requestedAt.toISOString(),
                export_id: exportId,
                kyahub_version: process.env.HUB_VERSION || 'unknown',
                schema_version: '2026-05-12-13',
                included_tables: Object.keys(dump),
            },
            data: dump,
        };
        const jsonBuf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');

        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(archivePath, { mode: 0o600 });
            const zip = archiver('zip', { zlib: { level: 9 } });
            output.on('close', () => resolve());
            output.on('error', reject);
            zip.on('error', reject);
            zip.pipe(output);
            zip.append(jsonBuf, { name: 'data.json' });
            zip.finalize();
        });
        try { fs.chmodSync(archivePath, 0o600); } catch (_) {}

        const stat = fs.statSync(archivePath);
        archiveSize = stat.size;
        const buf = fs.readFileSync(archivePath);
        archiveSha = crypto.createHash('sha256').update(buf).digest('hex');

        await pool.query(
            `UPDATE data_exports SET
                status = 'READY',
                completed_at = NOW(),
                archive_size_bytes = $1,
                archive_sha256 = $2,
                metadata = $3::jsonb
             WHERE id = $4`,
            [archiveSize, archiveSha,
             JSON.stringify({ tables: payload._meta.included_tables, json_bytes: jsonBuf.length }),
             exportId]);
    } catch (e) {
        await pool.query(
            `UPDATE data_exports SET status = 'FAILED', error_message = $1, completed_at = NOW()
             WHERE id = $2`,
            [String(e.message || e), exportId]);
        return { error: 'BUILD_FAILED', message: e.message };
    }

    const baseUrl = cfg.publicBaseUrl.replace(/\/$/, '');
    const downloadUrl = `${baseUrl}/api/agent/${encodeURIComponent(kya_id)}/data-export/${exportId}?token=${downloadToken}`;

    return {
        ok: true,
        export_id: exportId,
        download_token: downloadToken,
        download_url: baseUrl ? downloadUrl : null,
        download_path: baseUrl ? null : `/api/agent/${kya_id}/data-export/${exportId}?token=${downloadToken}`,
        expires_at: expiresAt.toISOString(),
        archive_size_bytes: archiveSize,
        archive_sha256: archiveSha,
        rate_limit: { used: usedToday + 1, max_per_day: cfg.maxPerDay },
    };
}

/**
 * Verify a download token against the data_exports row.
 *   - status must be READY
 *   - expires_at must be in the future
 *   - download_count must be 0 (single-use)
 *   - token must hash to the stored sha
 * Returns { ok, archive_path, archive_sha256 } | { error, status }.
 */
async function resolveDownload(pool, { export_id, kya_id, token }) {
    if (!export_id || !token) return { error: 'BAD_REQUEST', status: 400 };

    const r = await pool.query(
        `SELECT id, kya_id, status, expires_at, archive_path, archive_sha256,
                download_token_sha256, download_count, pruned_at
           FROM data_exports WHERE id = $1`,
        [export_id]);
    if (r.rowCount === 0) return { error: 'EXPORT_NOT_FOUND', status: 404 };
    const row = r.rows[0];
    if (kya_id && row.kya_id !== kya_id) return { error: 'KYA_ID_MISMATCH', status: 403 };
    if (row.status !== 'READY') return { error: 'EXPORT_NOT_READY', status: 409, current_status: row.status };
    if (row.pruned_at) return { error: 'EXPORT_PRUNED', status: 410 };
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        return { error: 'EXPORT_EXPIRED', status: 410 };
    }
    if (row.download_count > 0) {
        return { error: 'EXPORT_ALREADY_DOWNLOADED', status: 410 };
    }

    const tokenSha = crypto.createHash('sha256').update(token).digest('hex');
    if (!row.download_token_sha256 || !crypto.timingSafeEqual(
            Buffer.from(tokenSha, 'hex'),
            Buffer.from(row.download_token_sha256, 'hex'))) {
        return { error: 'BAD_TOKEN', status: 403 };
    }
    if (!row.archive_path || !fs.existsSync(row.archive_path)) {
        return { error: 'ARCHIVE_MISSING', status: 410 };
    }
    return {
        ok: true,
        archive_path: row.archive_path,
        archive_sha256: row.archive_sha256,
        export_id: row.id,
    };
}

/** Record a successful download (single-use semantics). */
async function markDownloaded(pool, exportId, { client_ip } = {}) {
    await pool.query(
        `UPDATE data_exports SET downloaded_at = NOW(),
                                 download_count = download_count + 1,
                                 metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('downloaded_from', $2::text)
         WHERE id = $1`,
        [exportId, client_ip || 'unknown']);
}

/**
 * Admin: prune expired archives. Deletes the on-disk file if past expiry,
 * marks the row PRUNED. Idempotent.
 */
async function prune(pool, { dryRun = false } = {}) {
    const r = await pool.query(
        `SELECT id, archive_path FROM data_exports
           WHERE status IN ('READY','FAILED')
             AND pruned_at IS NULL
             AND ((expires_at IS NOT NULL AND expires_at < NOW())
                  OR status = 'FAILED')`);
    const candidates = r.rows;
    const removed = [];
    for (const row of candidates) {
        if (!dryRun) {
            try { if (row.archive_path && fs.existsSync(row.archive_path)) fs.unlinkSync(row.archive_path); }
            catch (_) {}
            await pool.query(
                `UPDATE data_exports SET pruned_at = NOW(),
                                          status = CASE WHEN status = 'FAILED' THEN 'FAILED' ELSE 'EXPIRED' END
                 WHERE id = $1`,
                [row.id]);
        }
        removed.push({ id: row.id, archive_path: row.archive_path });
    }
    return { removed_count: removed.length, removed, dryRun };
}

module.exports = {
    canonicalExportPayload,
    collectAgentDump,
    createExport,
    resolveDownload,
    markDownloaded,
    prune,
    _cfg,
};
