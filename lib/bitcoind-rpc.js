// ============================================================================
// UMBRAXON KYA-Hub — Bitcoin Core RPC client (Phase 4)
// ----------------------------------------------------------------------------
// Tenký HTTP klient na bitcoind. Operácie:
//   - read-only: getblockchaininfo, getrawtransaction, decoderawtransaction,
//     getblock, getblockhash, estimatesmartfee
//   - wallet-scoped (cez walletCall(name, method, params)): createrawtransaction,
//     fundrawtransaction, signrawtransactionwithwallet, sendrawtransaction,
//     getnewaddress, getbalance, listunspent — využíva URL `/wallet/<name>`.
//     POUŽÍVA SA pre OP_RETURN anchor broadcast (Option B v Phase 4 / BTCPay 2.3.9 fix).
//
// Auth modes:
//   1) BITCOIND_RPC_USER + BITCOIND_RPC_PASSWORD  → HTTP basic
//   2) BITCOIND_RPC_COOKIE_PATH (file path)        → reads __cookie__:hex
//   3) BITCOIND_RPC_DOCKER_CONTAINER + cookie path → docker exec cat ... (default for BTCPay deploys)
// ============================================================================
const axios = require('axios');
const { spawnSync } = require('child_process');

let cachedCookie = null;
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 60 * 1000;

let cachedDockerRpcUrl = null;
let cachedDockerRpcUrlAt = 0;
const DOCKER_RPC_URL_TTL_MS = 60 * 1000;

function getCookie() {
    const now = Date.now();
    if (cachedCookie && (now - cookieFetchedAt) < COOKIE_TTL_MS) return cachedCookie;

    if (process.env.BITCOIND_RPC_USER && process.env.BITCOIND_RPC_PASSWORD) {
        cachedCookie = `${process.env.BITCOIND_RPC_USER}:${process.env.BITCOIND_RPC_PASSWORD}`;
        cookieFetchedAt = now;
        return cachedCookie;
    }

    if (process.env.BITCOIND_RPC_COOKIE_PATH) {
        try {
            const fs = require('fs');
            cachedCookie = fs.readFileSync(process.env.BITCOIND_RPC_COOKIE_PATH, 'utf-8').trim();
            cookieFetchedAt = now;
            return cachedCookie;
        } catch (_) { /* fall through */ }
    }

    if (process.env.BITCOIND_RPC_DOCKER_CONTAINER) {
        const container = process.env.BITCOIND_RPC_DOCKER_CONTAINER;
        const cookiePath = process.env.BITCOIND_RPC_DOCKER_COOKIE || '/data/.cookie';
        const r = spawnSync('docker', ['exec', container, 'cat', cookiePath], { encoding: 'utf-8' });
        if (r.status === 0 && r.stdout && r.stdout.includes(':')) {
            cachedCookie = r.stdout.trim();
            cookieFetchedAt = now;
            return cachedCookie;
        }
        throw new Error(`bitcoind cookie unreachable in container ${container}: ${r.stderr || 'unknown'}`);
    }

    throw new Error('bitcoind RPC auth not configured (set BITCOIND_RPC_USER/PASSWORD or BITCOIND_RPC_COOKIE_PATH or BITCOIND_RPC_DOCKER_CONTAINER)');
}

/**
 * BTCPay bitcoind lives in Docker; bridge IP changes after reboot.
 * When BITCOIND_RPC_DOCKER_CONTAINER is set, resolve IP via `docker inspect`.
 */
function resolveDockerRpcUrl() {
    const container = process.env.BITCOIND_RPC_DOCKER_CONTAINER;
    if (!container) return null;
    const now = Date.now();
    if (cachedDockerRpcUrl && now - cachedDockerRpcUrlAt < DOCKER_RPC_URL_TTL_MS) {
        return cachedDockerRpcUrl;
    }
    const port = process.env.BITCOIND_RPC_PORT || '43782';
    const r = spawnSync(
        'docker',
        ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container],
        { encoding: 'utf-8' },
    );
    const ip = (r.stdout || '').trim().split('\n').find((line) => line && /^\d/.test(line));
    if (r.status !== 0 || !ip) return null;
    cachedDockerRpcUrl = `http://${ip}:${port}/`;
    cachedDockerRpcUrlAt = now;
    return cachedDockerRpcUrl;
}

function rpcUrl() {
    if (process.env.BITCOIND_RPC_RESOLVE_DOCKER_IP !== 'false') {
        const dockerUrl = resolveDockerRpcUrl();
        if (dockerUrl) return dockerUrl;
    }
    return process.env.BITCOIND_RPC_URL || 'http://127.0.0.1:8332/';
}

function walletRpcUrl(walletName) {
    const base = rpcUrl().replace(/\/+$/, '');
    return `${base}/wallet/${encodeURIComponent(walletName)}`;
}

async function _doPost(url, method, params) {
    const auth = getCookie();
    const [user, password] = auth.split(':', 2);
    const res = await axios.post(url,
        { jsonrpc: '1.0', id: `kya-${Date.now()}`, method, params },
        {
            auth: { username: user, password },
            timeout: parseInt(process.env.BITCOIND_RPC_TIMEOUT_MS || '15000', 10),
            headers: { 'Content-Type': 'text/plain' },
            validateStatus: () => true,
        }
    );
    if (res.status >= 400 || (res.data && res.data.error)) {
        const err = (res.data && res.data.error) || { message: `HTTP ${res.status}` };
        const e = new Error(`bitcoind RPC ${method} fail: ${err.message || JSON.stringify(err)}`);
        e.rpcError = err;
        e.httpStatus = res.status;
        throw e;
    }
    return res.data.result;
}

async function call(method, params = []) {
    return _doPost(rpcUrl(), method, params);
}

/**
 * Wallet-scoped RPC call. Routes to `/wallet/<name>` so wallet-aware methods
 * (createrawtransaction works globally, but fundrawtransaction/signrawtransactionwithwallet
 * REQUIRE wallet context).
 */
async function walletCall(walletName, method, params = []) {
    if (!walletName) throw new Error('walletCall requires walletName');
    return _doPost(walletRpcUrl(walletName), method, params);
}

async function getBlockchainInfo() {
    return call('getblockchaininfo');
}

async function getRawTransaction(txid, verbose = true) {
    return call('getrawtransaction', [txid, verbose]);
}

async function getBlock(blockHash, verbosity = 1) {
    return call('getblock', [blockHash, verbosity]);
}

async function getBlockHash(height) {
    return call('getblockhash', [height]);
}

async function estimateFee(targetBlocks = 6) {
    // Returns sat/vB; bitcoind estimatesmartfee returns BTC/kvB
    try {
        const r = await call('estimatesmartfee', [targetBlocks]);
        if (r && typeof r.feerate === 'number') {
            // BTC/kvB → sat/vB
            return Math.max(1, Math.ceil((r.feerate * 1e8) / 1000));
        }
    } catch (_) { /* fall through */ }
    return parseInt(process.env.ANCHOR_FALLBACK_FEERATE_SAT_VB || '2', 10);
}

async function sendRawTransaction(rawHex) {
    return call('sendrawtransaction', [rawHex]);
}

async function isAvailable() {
    try {
        await getBlockchainInfo();
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    call,
    walletCall,
    getBlockchainInfo,
    getRawTransaction,
    getBlock,
    getBlockHash,
    estimateFee,
    sendRawTransaction,
    isAvailable,
    _resetCookieCache: () => { cachedCookie = null; cookieFetchedAt = 0; },
};
