#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Anchor Wallet Top-Up Monitor (Phase 4 follow-up)
// ----------------------------------------------------------------------------
// Periodicky monitoruje balance bitcoind `kya-anchor` wallet-u. Cieľom je
// včas detegovať blížiace sa vyčerpanie hot-wallet zdroja pre OP_RETURN
// anchors a (v krajnom prípade) auto-pauznúť anchor worker do DRY_RUN
// pred-tým, ako mu dôjdu fondy a začne hádzať "Insufficient funds" chyby.
//
// Volá:
//   - bitcoindRpc.walletCall('kya-anchor', 'getbalance') — hlavná hodnota
//   - bitcoindRpc.walletCall('kya-anchor', 'getwalletinfo') — pre unconfirmed
//   - bitcoindRpc.walletCall('kya-anchor', 'listunspent', [0, 9999999])
//     pre UTXO inventory (informačne v Telegram alerte).
//
// Thresholds (sat; configurable cez .env):
//   ANCHOR_WALLET_WARN_SATS      (default 3000)  → category="warning"
//   ANCHOR_WALLET_CRITICAL_SATS  (default 1000)  → category="critical"
//   ANCHOR_WALLET_AUTOPAUSE_SATS (default 500)   → AUTO-PAUSE (set BROADCAST_ENABLED=false)
//
// Behavior:
//   - balance ≥ WARN      → log info, NO notification
//   - WARN > balance ≥ CRITICAL  → Telegram warning (dedupe `anchor_wallet_low`)
//   - CRITICAL > balance ≥ AUTOPAUSE → Telegram critical (dedupe `anchor_wallet_critical`)
//   - balance < AUTOPAUSE → AUTO-PAUSE: rewrites .env to set
//     `ANCHOR_WORKER_BROADCAST_ENABLED=false` and triggers a graceful pm2
//     reload of `kya-anchor-worker`. Sends critical alert with dedupe
//     `anchor_wallet_autopaused`.
//
// Auto-pause is one-way (monitor never re-enables LIVE broadcast automatically;
// operator must top-up and manually flip back to true after verification).
//
// Modes:
//   default          → single-shot check + exit (suitable as PM2 cron job)
//   --watch          → infinite loop with INTERVAL_MS sleep between iterations
//   --interval-ms N  → override INTERVAL_MS for --watch mode
//   --dry-run        → never write .env / never restart anything
//
// Exit codes (single-shot mode):
//   0 — OK or merely warning sent
//   2 — critical balance (alert sent)
//   3 — autopause triggered (alert sent, env modified)
//   1 — internal error (RPC unreachable, etc.)
// ============================================================================

require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const bitcoindRpc = require('../lib/bitcoind-rpc');
const notifications = require('../lib/notifications');

const ENV_PATH = path.join(__dirname, '..', '.env');
const WALLET_NAME = process.env.BITCOIND_ANCHOR_WALLET || 'kya-anchor';

const CFG = {
    WARN_SATS: parseInt(process.env.ANCHOR_WALLET_WARN_SATS || '3000', 10),
    CRITICAL_SATS: parseInt(process.env.ANCHOR_WALLET_CRITICAL_SATS || '1000', 10),
    AUTOPAUSE_SATS: parseInt(process.env.ANCHOR_WALLET_AUTOPAUSE_SATS || '500', 10),
    INTERVAL_MS: parseInt(process.env.ANCHOR_WALLET_MONITOR_INTERVAL_MS || '1800000', 10), // 30 min
    PM2_BIN: process.env.PM2_BIN || 'pm2',
    PM2_PROCESS_NAME: process.env.ANCHOR_WORKER_PM2_NAME || 'kya-anchor-worker',
    AUTOPAUSE_ENABLED: process.env.ANCHOR_WALLET_AUTOPAUSE_ENABLED !== 'false',
};

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(arr) {
    const out = { watch: false, dryRun: false };
    for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (a === '--watch') out.watch = true;
        else if (a === '--dry-run' || a === '--dry') out.dryRun = true;
        else if (a === '--interval-ms') { CFG.INTERVAL_MS = parseInt(arr[++i], 10); }
        else if (a === '--help' || a === '-h') {
            console.log('Usage: node scripts/anchor-wallet-monitor.js [--watch] [--dry-run] [--interval-ms N]');
            process.exit(0);
        }
    }
    return out;
}

function nowIso() { return new Date().toISOString(); }

function logLine(level, obj) {
    const base = { ts: nowIso(), level, component: 'anchor-wallet-monitor' };
    console.log(JSON.stringify({ ...base, ...obj }));
}

async function fetchBalance() {
    // getbalance returns BTC (number, e.g. 0.00007372)
    const btc = await bitcoindRpc.walletCall(WALLET_NAME, 'getbalance', []);
    const info = await bitcoindRpc.walletCall(WALLET_NAME, 'getwalletinfo', []);
    const unspents = await bitcoindRpc.walletCall(WALLET_NAME, 'listunspent', [0, 9999999]);
    const balanceSats = Math.round((btc || 0) * 1e8);
    const unconfirmedSats = Math.round((info.unconfirmed_balance || 0) * 1e8);
    const immatureSats = Math.round((info.immature_balance || 0) * 1e8);
    return {
        wallet: WALLET_NAME,
        balance_sats: balanceSats,
        unconfirmed_sats: unconfirmedSats,
        immature_sats: immatureSats,
        utxo_count: unspents.length,
        smallest_utxo_sats: unspents.length
            ? Math.min(...unspents.map(u => Math.round((u.amount || 0) * 1e8)))
            : null,
    };
}

function classify(balanceSats) {
    if (balanceSats < CFG.AUTOPAUSE_SATS) return 'AUTOPAUSE';
    if (balanceSats < CFG.CRITICAL_SATS) return 'CRITICAL';
    if (balanceSats < CFG.WARN_SATS) return 'WARN';
    return 'OK';
}

// Rewrites `ANCHOR_WORKER_BROADCAST_ENABLED=true` → `=false` in-place.
// Returns { changed: bool, prevValue, newValue }. Backs up to `.env.autopause-<ts>`.
function autoPauseEnv() {
    if (ARGS.dryRun) {
        return { changed: false, dryRun: true, reason: 'dry-run' };
    }
    if (!CFG.AUTOPAUSE_ENABLED) {
        return { changed: false, reason: 'autopause disabled via ANCHOR_WALLET_AUTOPAUSE_ENABLED=false' };
    }
    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    const re = /^ANCHOR_WORKER_BROADCAST_ENABLED=.*$/m;
    const m = content.match(re);
    if (!m) {
        // missing → append explicit false (defensive)
        content = content.trimEnd() + '\nANCHOR_WORKER_BROADCAST_ENABLED=false\n';
        fs.writeFileSync(ENV_PATH, content);
        try { fs.chmodSync(ENV_PATH, 0o600); } catch (_) {}
        return { changed: true, prevValue: '(missing)', newValue: 'false' };
    }
    const prev = m[0].split('=', 2)[1];
    if (prev.trim().toLowerCase() === 'false') {
        return { changed: false, prevValue: 'false', newValue: 'false', reason: 'already disabled' };
    }
    const backupPath = `${ENV_PATH}.autopause-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backupPath, content);
    try { fs.chmodSync(backupPath, 0o600); } catch (_) {}
    const updated = content.replace(re, 'ANCHOR_WORKER_BROADCAST_ENABLED=false');
    fs.writeFileSync(ENV_PATH, updated);
    try { fs.chmodSync(ENV_PATH, 0o600); } catch (_) {}
    return { changed: true, prevValue: prev, newValue: 'false', backup: backupPath };
}

function reloadAnchorWorker() {
    if (ARGS.dryRun) return { skipped: 'dry-run' };
    if (!CFG.AUTOPAUSE_ENABLED) return { skipped: 'autopause disabled' };
    // graceful reload picks up the new env (PM2 reads env on restart, not reload —
    // we must --update-env). `pm2 restart name --update-env` is the only way
    // to push .env changes into a running worker.
    const r = spawnSync(CFG.PM2_BIN, ['restart', CFG.PM2_PROCESS_NAME, '--update-env'], { encoding: 'utf-8' });
    return {
        cmd: `${CFG.PM2_BIN} restart ${CFG.PM2_PROCESS_NAME} --update-env`,
        exitCode: r.status,
        stdout: (r.stdout || '').slice(0, 300),
        stderr: (r.stderr || '').slice(0, 300),
    };
}

async function runOnce() {
    let status;
    try {
        status = await fetchBalance();
    } catch (e) {
        logLine('error', { event: 'rpc_fail', error: e.message });
        // Best-effort alert that we can't even read the wallet — operator must check.
        await notifications.notify({
            category: 'critical',
            title: 'Anchor wallet monitor: RPC FAIL',
            body: `bitcoind walletCall(${WALLET_NAME}, getbalance) failed:\n${(e.message || '').slice(0, 240)}`,
            dedupe_key: 'anchor_wallet_monitor_rpc_fail',
        }).catch(() => {});
        return { exit: 1, level: 'RPC_FAIL' };
    }

    const balanceSats = status.balance_sats;
    const level = classify(balanceSats);
    const broadcastEnabledNow = process.env.ANCHOR_WORKER_BROADCAST_ENABLED === 'true';

    logLine('info', {
        event: 'balance_check', level,
        balance_sats: balanceSats,
        unconfirmed_sats: status.unconfirmed_sats,
        utxo_count: status.utxo_count,
        smallest_utxo_sats: status.smallest_utxo_sats,
        thresholds: {
            warn: CFG.WARN_SATS, critical: CFG.CRITICAL_SATS, autopause: CFG.AUTOPAUSE_SATS,
        },
        broadcast_enabled: broadcastEnabledNow,
    });

    if (level === 'OK') {
        // Recovery notice — fires only after a previous alert was deduped.
        return { exit: 0, level };
    }

    const baseBody = (
        `wallet: ${WALLET_NAME}\n` +
        `balance: ${balanceSats} sat (~${(balanceSats / 100).toFixed(2)} k-sat)\n` +
        `unconfirmed: ${status.unconfirmed_sats} sat\n` +
        `utxos: ${status.utxo_count}` +
        (status.smallest_utxo_sats != null ? ` (smallest: ${status.smallest_utxo_sats} sat)` : '') + `\n` +
        `thresholds: warn=${CFG.WARN_SATS} critical=${CFG.CRITICAL_SATS} autopause=${CFG.AUTOPAUSE_SATS}`
    );

    if (level === 'WARN') {
        await notifications.notify({
            category: 'warning',
            title: 'Anchor wallet LOW',
            body: baseBody + '\naction: top-up before balance drops further',
            dedupe_key: 'anchor_wallet_low',
        }).catch(() => {});
        return { exit: 0, level };
    }

    if (level === 'CRITICAL') {
        await notifications.notify({
            category: 'critical',
            title: 'Anchor wallet CRITICAL',
            body: baseBody + `\naction: top-up IMMEDIATELY — next OP_RETURN broadcast may fail with "Insufficient funds"`,
            dedupe_key: 'anchor_wallet_critical',
        }).catch(() => {});
        return { exit: 2, level };
    }

    // AUTOPAUSE
    const envResult = autoPauseEnv();
    let reloadResult = null;
    if (envResult.changed) {
        reloadResult = reloadAnchorWorker();
    }

    logLine('warn', {
        event: 'autopause',
        balance_sats: balanceSats,
        env_change: envResult,
        pm2_reload: reloadResult,
    });

    await notifications.notify({
        category: 'critical',
        title: 'Anchor wallet AUTO-PAUSED ⛔',
        body: (
            baseBody + '\n' +
            `action: anchor worker auto-flipped to DRY_RUN (ANCHOR_WORKER_BROADCAST_ENABLED=false)\n` +
            `env_change: ${envResult.changed ? 'YES (backup ' + (envResult.backup || 'none') + ')' : 'NO (' + (envResult.reason || '') + ')'}\n` +
            `pm2_restart: ${reloadResult ? ('exit=' + reloadResult.exitCode) : 'skipped'}\n` +
            `recover: 1) top-up wallet ≥${CFG.WARN_SATS * 5} sat  2) edit .env ANCHOR_WORKER_BROADCAST_ENABLED=true  3) pm2 restart ${CFG.PM2_PROCESS_NAME} --update-env`
        ),
        dedupe_key: 'anchor_wallet_autopaused',
    }).catch(() => {});

    return { exit: 3, level, envResult, reloadResult };
}

async function main() {
    if (!ARGS.watch) {
        const r = await runOnce();
        process.exit(r.exit);
    }

    logLine('info', { event: 'watch_start', interval_ms: CFG.INTERVAL_MS });
    let stop = false;
    process.on('SIGTERM', () => { stop = true; });
    process.on('SIGINT', () => { stop = true; });
    while (!stop) {
        try { await runOnce(); }
        catch (e) { logLine('error', { event: 'iter_fail', error: e.message }); }
        await new Promise(r => setTimeout(r, CFG.INTERVAL_MS));
    }
    logLine('info', { event: 'watch_stop' });
    process.exit(0);
}

main().catch(e => {
    logLine('fatal', { error: e.message, stack: (e.stack || '').slice(0, 500) });
    process.exit(1);
});
