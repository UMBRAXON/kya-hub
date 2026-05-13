// ============================================================================
// UMBRAXON KYA-Hub — Bitcoin Fork Detector (Strategic Sprint §30 Item 5)
// ============================================================================
// Cross-checks 3 independent views of the Bitcoin mainnet tip:
//   - local bitcoind: getblockcount + getblockhash <height>
//   - mempool.space:  /api/blocks/tip/hash
//   - blockstream.info: /blocks/tip/hash
//
// Quorum = 2-of-3 agreement on the height-N hash (where N = local tip - DEPTH).
// We use DEPTH=1 by default (compare 1 block back from local tip) to give the
// external explorers a moment to catch up if our node won a race; configurable
// via env `FORK_DETECTOR_DEPTH`.
//
// If quorum fails:
//   - status FORK_DETECTED → Telegram CRITICAL (dedupe `fork_detector`)
//   - optionally rewrite .env `ANCHOR_WORKER_BROADCAST_ENABLED=false` and
//     pm2-restart `kya-anchor-worker` IFF `FORK_DETECTOR_AUTOPAUSE=true`
//
// Run modes:
//   - require()-ed by server.js for the `/api/admin/chain-status` endpoint
//     (which exposes the most-recent in-memory state without forcing a probe).
//   - invoked as a PM2 cron app via `node scripts/fork-detector-worker.js`.
//
// Caching: each probe takes <2 s; results cached in `lastResult` (in-memory)
// so endpoint reads are zero-cost.
// ============================================================================
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const logger = require('./logger');
const notifications = require('./notifications');
const bitcoindRpc = require('./bitcoind-rpc');

const CFG = {
    DEPTH: parseInt(process.env.FORK_DETECTOR_DEPTH || '1', 10),
    HTTP_TIMEOUT_MS: parseInt(process.env.FORK_DETECTOR_HTTP_TIMEOUT_MS || '6000', 10),
    AUTOPAUSE: process.env.FORK_DETECTOR_AUTOPAUSE === 'true',
    PM2_BIN: process.env.PM2_BIN || 'pm2',
    PM2_PROCESS_NAME: process.env.ANCHOR_WORKER_PM2_NAME || 'kya-anchor-worker',
    MEMPOOL_BASE: process.env.MEMPOOL_API_URL || 'https://mempool.space',
    BLOCKSTREAM_BASE: process.env.BLOCKSTREAM_API_URL || 'https://blockstream.info',
    USER_AGENT: process.env.FORK_DETECTOR_UA || 'kya-hub-fork-detector/1.0',
    ENV_PATH: path.resolve(__dirname, '..', '.env'),
};

let lastResult = null; // most recent probe outcome

async function _httpGetText(url) {
    const res = await axios.get(url, {
        timeout: CFG.HTTP_TIMEOUT_MS,
        headers: { 'user-agent': CFG.USER_AGENT, accept: 'text/plain' },
        responseType: 'text',
        validateStatus: () => true,
    });
    if (res.status >= 400) {
        throw new Error(`http ${res.status} ${url}`);
    }
    return (typeof res.data === 'string' ? res.data : String(res.data || '')).trim();
}

async function _httpGetJson(url) {
    const res = await axios.get(url, {
        timeout: CFG.HTTP_TIMEOUT_MS,
        headers: { 'user-agent': CFG.USER_AGENT, accept: 'application/json' },
        validateStatus: () => true,
    });
    if (res.status >= 400) throw new Error(`http ${res.status} ${url}`);
    return res.data;
}

async function probeLocal() {
    try {
        const tipHeight = await bitcoindRpc.call('getblockcount');
        const compareHeight = Math.max(0, tipHeight - CFG.DEPTH);
        const hash = await bitcoindRpc.call('getblockhash', [compareHeight]);
        return { ok: true, source: 'bitcoind', tipHeight, compareHeight, hash };
    } catch (e) {
        return { ok: false, source: 'bitcoind', error: e.message };
    }
}

async function probeMempoolAtHeight(height) {
    // mempool.space: GET /api/block-height/<height> returns block HASH at that height (plain text)
    try {
        const url = `${CFG.MEMPOOL_BASE}/api/block-height/${height}`;
        const hash = await _httpGetText(url);
        if (!/^[0-9a-f]{64}$/i.test(hash)) {
            return { ok: false, source: 'mempool.space', error: 'bad-hash-format', body: hash.slice(0, 64) };
        }
        return { ok: true, source: 'mempool.space', compareHeight: height, hash: hash.toLowerCase() };
    } catch (e) {
        return { ok: false, source: 'mempool.space', error: e.message };
    }
}

async function probeBlockstreamAtHeight(height) {
    // blockstream.info Esplora API: GET /api/block-height/<height> returns hex hash.
    try {
        const url = `${CFG.BLOCKSTREAM_BASE}/api/block-height/${height}`;
        const hash = await _httpGetText(url);
        if (!/^[0-9a-f]{64}$/i.test(hash)) {
            return { ok: false, source: 'blockstream.info', error: 'bad-hash-format', body: hash.slice(0, 64) };
        }
        return { ok: true, source: 'blockstream.info', compareHeight: height, hash: hash.toLowerCase() };
    } catch (e) {
        return { ok: false, source: 'blockstream.info', error: e.message };
    }
}

async function probeMempoolTip() {
    try {
        const hash = (await _httpGetText(`${CFG.MEMPOOL_BASE}/api/blocks/tip/hash`)).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hash)) {
            return { ok: false, source: 'mempool.space/tip', error: 'bad-hash-format' };
        }
        const height = await _httpGetJson(`${CFG.MEMPOOL_BASE}/api/blocks/tip/height`);
        return { ok: true, source: 'mempool.space/tip', tipHeight: Number(height), hash };
    } catch (e) {
        return { ok: false, source: 'mempool.space/tip', error: e.message };
    }
}

async function probeBlockstreamTip() {
    try {
        const hash = (await _httpGetText(`${CFG.BLOCKSTREAM_BASE}/api/blocks/tip/hash`)).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hash)) {
            return { ok: false, source: 'blockstream.info/tip', error: 'bad-hash-format' };
        }
        const heightTxt = await _httpGetText(`${CFG.BLOCKSTREAM_BASE}/api/blocks/tip/height`);
        return { ok: true, source: 'blockstream.info/tip', tipHeight: parseInt(heightTxt, 10), hash };
    } catch (e) {
        return { ok: false, source: 'blockstream.info/tip', error: e.message };
    }
}

function _autopauseAnchorWorker(reason) {
    if (!CFG.AUTOPAUSE) {
        return { autopause_enabled: false };
    }
    let envContent;
    try { envContent = fs.readFileSync(CFG.ENV_PATH, 'utf-8'); }
    catch (e) { return { error: 'env read fail: ' + e.message }; }

    const re = /^ANCHOR_WORKER_BROADCAST_ENABLED=.*$/m;
    const m = envContent.match(re);
    if (m && m[0].toLowerCase().includes('=false')) {
        return { changed: false, reason: 'already-paused' };
    }
    const backupPath = `${CFG.ENV_PATH}.fork-pause-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.writeFileSync(backupPath, envContent); fs.chmodSync(backupPath, 0o600); } catch (_) {}

    const updated = m
        ? envContent.replace(re, 'ANCHOR_WORKER_BROADCAST_ENABLED=false')
        : envContent.trimEnd() + '\nANCHOR_WORKER_BROADCAST_ENABLED=false\n';
    try { fs.writeFileSync(CFG.ENV_PATH, updated); fs.chmodSync(CFG.ENV_PATH, 0o600); }
    catch (e) { return { error: 'env write fail: ' + e.message }; }

    const r = spawnSync(CFG.PM2_BIN, ['restart', CFG.PM2_PROCESS_NAME, '--update-env'], { encoding: 'utf-8' });
    return {
        changed: true,
        backup: backupPath,
        pm2_exit: r.status,
        pm2_stderr: (r.stderr || '').slice(0, 200),
        reason,
    };
}

/**
 * Run a full 3-source probe and update lastResult.
 * @param {object} opts
 *   - alert (default true): if quorum fails AND status !== last status,
 *     send Telegram + (optionally) autopause anchor worker.
 */
async function probe({ alert = true } = {}) {
    const local = await probeLocal();
    if (!local.ok || typeof local.tipHeight !== 'number') {
        const out = {
            ts: new Date().toISOString(),
            status: 'LOCAL_RPC_UNREACHABLE',
            details: { local, mempool: null, blockstream: null },
            depth: CFG.DEPTH,
        };
        lastResult = out;
        if (alert) {
            notifications.notify({
                category: 'critical',
                title: 'Bitcoin fork detector: LOCAL RPC unreachable',
                body: `cannot reach bitcoind: ${local.error || 'n/a'}\nimpact: cannot validate chain consensus`,
                dedupe_key: 'fork_detector_local_down',
            }).catch(() => {});
        }
        return out;
    }
    const compareHeight = Math.max(0, local.tipHeight - CFG.DEPTH);

    // Query the two external sources at the SAME height as local compareHeight
    // so a temporary lag at one source doesn't look like a fork.
    const [mempool, blockstream, mempoolTip, blockstreamTip] = await Promise.all([
        probeMempoolAtHeight(compareHeight),
        probeBlockstreamAtHeight(compareHeight),
        probeMempoolTip(),
        probeBlockstreamTip(),
    ]);

    const hashes = [local, mempool, blockstream]
        .filter(p => p.ok && /^[0-9a-f]{64}$/i.test(p.hash || ''))
        .map(p => ({ source: p.source, hash: p.hash.toLowerCase() }));

    // Status decision
    let status, reason;
    if (hashes.length < 2) {
        status = 'INSUFFICIENT_SOURCES';
        reason = `Only ${hashes.length}/3 sources answered; cannot establish quorum.`;
    } else {
        const tally = new Map();
        for (const h of hashes) tally.set(h.hash, (tally.get(h.hash) || 0) + 1);
        const top = [...tally.entries()].sort((a, b) => b[1] - a[1]);
        const consensusHash = top[0][0];
        const consensusCount = top[0][1];
        if (consensusCount >= 2 && local.hash === consensusHash) {
            status = 'OK';
            reason = `${consensusCount}/${hashes.length} sources agree on hash ${consensusHash.slice(0, 16)}…`;
        } else if (consensusCount >= 2 && local.hash !== consensusHash) {
            status = 'FORK_DETECTED';
            reason = `external quorum=${consensusHash.slice(0, 16)}… but local=${(local.hash || '').slice(0, 16)}…`;
        } else {
            // 3-way disagreement
            status = 'FORK_DETECTED';
            reason = `3-way hash disagreement at height ${compareHeight}`;
        }
    }

    // Lag check (tip height vs external tips) — info only, not a fork
    const tipLags = [];
    for (const t of [mempoolTip, blockstreamTip]) {
        if (t.ok && Number.isFinite(t.tipHeight)) {
            tipLags.push({ source: t.source, tipHeight: t.tipHeight, lag: t.tipHeight - local.tipHeight });
        }
    }

    const result = {
        ts: new Date().toISOString(),
        status,
        reason,
        compare_height: compareHeight,
        local_tip_height: local.tipHeight,
        depth: CFG.DEPTH,
        sources: { local, mempool, blockstream },
        tip_lags: tipLags,
        autopause: null,
    };

    if (status === 'FORK_DETECTED' && alert) {
        const ap = _autopauseAnchorWorker(reason);
        result.autopause = ap;
        notifications.notify({
            category: 'critical',
            title: 'Bitcoin FORK DETECTED 🚨',
            body: (
                `height: ${compareHeight} (depth=${CFG.DEPTH})\n` +
                `local:        ${local.hash}\n` +
                `mempool:      ${mempool.ok ? mempool.hash : 'ERR ' + (mempool.error || '?')}\n` +
                `blockstream:  ${blockstream.ok ? blockstream.hash : 'ERR ' + (blockstream.error || '?')}\n` +
                `local_tip:    ${local.tipHeight}\n` +
                `mempool_tip:  ${mempoolTip.ok ? mempoolTip.tipHeight : 'ERR'}\n` +
                `blockstream_tip: ${blockstreamTip.ok ? blockstreamTip.tipHeight : 'ERR'}\n` +
                `reason: ${reason}\n` +
                `autopause: ${ap ? JSON.stringify(ap) : 'disabled'}`
            ),
            dedupe_key: 'fork_detector',
        }).catch(() => {});
        logger.error({ event: 'fork_detected', result }, 'Bitcoin chain consensus broken');
    } else if (status === 'INSUFFICIENT_SOURCES' && alert) {
        notifications.notify({
            category: 'warning',
            title: 'Bitcoin fork detector: insufficient sources',
            body: `Only ${hashes.length}/3 sources answered. Cannot validate consensus.`,
            dedupe_key: 'fork_detector_insufficient',
        }).catch(() => {});
        logger.warn({ event: 'fork_detector_insufficient', result }, 'Bitcoin fork detector insufficient sources');
    } else if (status === 'OK') {
        // Optional: notify-on-recovery if previous run was FORK_DETECTED
        if (lastResult && lastResult.status === 'FORK_DETECTED') {
            notifications.notify({
                category: 'info',
                title: 'Bitcoin chain consensus RESTORED ✅',
                body: `Quorum achieved at height ${compareHeight}. Local hash matches external sources.`,
                dedupe_key: 'fork_detector_recovered',
            }).catch(() => {});
        }
    }

    lastResult = result;
    return result;
}

function getLastResult() {
    return lastResult;
}

module.exports = {
    CFG,
    probe,
    getLastResult,
    // exposed for testing
    _probeLocal: probeLocal,
    _probeMempoolAtHeight: probeMempoolAtHeight,
    _probeBlockstreamAtHeight: probeBlockstreamAtHeight,
};
