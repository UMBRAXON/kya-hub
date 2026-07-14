// UMBRAXON KYA-Hub — Alby Hub NWC wrapper
//
// Tento modul obaľuje @getalby/sdk pre prácu s Alby Hub cez Nostr Wallet Connect.
// Connection URI sa nastavuje cez .env premennú ALBY_NWC_URI (alebo ALBY_NWC_URI_FILE).
//
// Použitie:
//   const alby = require('./lib/alby');
//   await alby.connect();                // pripoji sa pri štarte (idempotent)
//   alby.startReconnectSupervisor(logger); // background retry ak Alby Hub ešte nie je ready
//   const inv = await alby.createInvoice({ amountSats: 10000, description: 'BASIC' });
//   const status = await alby.lookupInvoice({ paymentHash: inv.paymentHash });
//   alby.onSettled((event) => { ... });   // subscribe na notifikácie
//
// @getalby/sdk uses WebSocket internally for Nostr relays.
// Node.js doesn't have a native WebSocket constructor → polyfill required.
// Must be set BEFORE requiring the SDK, otherwise NWCClient grabs `undefined`.
if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = require('ws');
}
const { NWCClient } = require('@getalby/sdk');
const fs = require('fs');

// Load NWC URI from env or fallback to a secrets file (operator-friendly:
// the URI is long & sensitive, easier to manage outside the main .env).
function loadNwcUri() {
    if (process.env.ALBY_NWC_URI) return process.env.ALBY_NWC_URI.trim();
    const secretFile = process.env.ALBY_NWC_URI_FILE || '/root/kya-hub/.secrets/alby-nwc.txt';
    try {
        if (fs.existsSync(secretFile)) {
            return fs.readFileSync(secretFile, 'utf8').trim();
        }
    } catch (_) { /* ignore — handled as not-configured */ }
    return '';
}

let nwc = null;
let connected = false;
let notificationsSub = null;
let connecting = null; // in-flight connect Promise (de-dupe concurrent callers)
let reconnectTimer = null;
let reconnectAttempt = 0;
let supervisorStarted = false;
let supervisorLogger = console;
let lastError = null;
let lastConnectedAt = null;
let lastDisconnectAt = null;
let lastDisconnectReason = null;
const settledListeners = new Set();

// Injectable for unit tests — production default is the real SDK client.
let clientFactory = (uri) => new NWCClient({ nostrWalletConnectUrl: uri });

const CONNECT_TIMEOUT_MS = parseInt(process.env.ALBY_CONNECT_TIMEOUT_MS || '10000', 10);
const RECONNECT_BASE_MS = parseInt(process.env.ALBY_RECONNECT_BASE_MS || '5000', 10);
const RECONNECT_MAX_MS = parseInt(process.env.ALBY_RECONNECT_MAX_MS || '120000', 10);
const ALIVE_TIMEOUT_MS = parseInt(process.env.ALBY_ALIVE_TIMEOUT_MS || '5000', 10);

function isConfigured() {
    const uri = loadNwcUri();
    return !!uri && uri.startsWith('nostr+walletconnect://');
}

function _backoffMs(attempt) {
    const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.max(0, attempt)));
    const jitter = Math.floor(Math.random() * Math.min(1000, Math.floor(exp * 0.1)));
    return Math.min(RECONNECT_MAX_MS, exp + jitter);
}

function _clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect(logger = supervisorLogger, reason = 'disconnected') {
    if (!isConfigured()) return;
    if (connected) return;
    if (reconnectTimer) return; // already scheduled
    const delay = _backoffMs(reconnectAttempt);
    const log = logger || console;
    log.warn?.({
        msg: '[alby] reconnect scheduled',
        reason,
        attempt: reconnectAttempt + 1,
        delay_ms: delay,
        last_error: lastError,
    });
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        ensureReady(log).catch(() => { /* ensureReady schedules next attempt */ });
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
}

function markDisconnected(reason, logger = supervisorLogger) {
    const wasConnected = connected;
    connected = false;
    // Drop subscription handle so startSubscriptions re-binds after reconnect.
    notificationsSub = null;
    lastDisconnectAt = new Date().toISOString();
    lastDisconnectReason = reason || 'unknown';
    if (wasConnected) {
        (logger || console).warn?.({
            msg: '[alby] marked disconnected',
            reason: lastDisconnectReason,
        });
    }
    scheduleReconnect(logger, lastDisconnectReason);
}

async function disconnect() {
    _clearReconnectTimer();
    if (notificationsSub && typeof notificationsSub.unsubscribe === 'function') {
        try { await notificationsSub.unsubscribe(); } catch (_) {}
    }
    notificationsSub = null;
    if (nwc && typeof nwc.close === 'function') {
        try { await nwc.close(); } catch (_) {}
    }
    nwc = null;
    connected = false;
}

async function connect(logger = console, options = {}) {
    const uri = (options.nwcUri || loadNwcUri() || '').trim();
    if (!uri || !uri.startsWith('nostr+walletconnect://')) {
        logger.warn?.('[alby] NWC URI nie je nastavené — Alby integrácia VYPNUTÁ');
        return false;
    }
    if (connected && nwc && !options.forceReconnect) return true;

    // De-dupe concurrent connect() calls (boot + health probe + register).
    if (connecting && !options.forceReconnect) {
        return connecting;
    }

    const run = (async () => {
        try {
            if (nwc && (options.forceReconnect || !connected)) {
                try { await disconnect(); } catch (_) {}
            }
            nwc = clientFactory(uri);
            const info = await Promise.race([
                nwc.getInfo(),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)),
            ]);
            connected = true;
            lastError = null;
            lastConnectedAt = new Date().toISOString();
            reconnectAttempt = 0;
            _clearReconnectTimer();
            logger.info?.({ msg: '[alby] pripojené', alias: info?.alias, methods: info?.methods, network: info?.network });
            return true;
        } catch (err) {
            connected = false;
            nwc = null;
            lastError = err.message || String(err);
            lastDisconnectAt = new Date().toISOString();
            lastDisconnectReason = 'connect_fail';
            reconnectAttempt += 1;
            logger.error?.({ msg: '[alby] connect FAIL', error: lastError, attempt: reconnectAttempt });
            scheduleReconnect(logger, 'connect_fail');
            throw err;
        } finally {
            connecting = null;
        }
    })();

    connecting = run;
    return run;
}

/**
 * Connect if needed. Returns true when ready; false when not configured.
 * On failure schedules backoff reconnect (does not throw unless {throwOnFail:true}).
 */
async function ensureReady(logger = console, options = {}) {
    if (!isConfigured()) return false;
    if (connected && nwc && !options.forceReconnect) return true;
    try {
        await connect(logger, options);
        // Re-subscribe after a fresh connect when listeners are registered.
        if (settledListeners.size > 0) {
            await startSubscriptions(logger);
        }
        return true;
    } catch (err) {
        if (options.throwOnFail) throw err;
        return false;
    }
}

/**
 * Background supervisor: keeps trying to (re)connect while configured but down.
 * Safe to call multiple times; idempotent.
 */
function startReconnectSupervisor(logger = console) {
    supervisorLogger = logger || console;
    if (supervisorStarted) {
        if (!connected) scheduleReconnect(supervisorLogger, 'supervisor_nudge');
        return;
    }
    supervisorStarted = true;
    if (!isConfigured()) {
        supervisorLogger.warn?.('[alby] reconnect supervisor idle — NWC not configured');
        return;
    }
    if (!connected) {
        scheduleReconnect(supervisorLogger, 'supervisor_start');
    }
}

function ensureConnected() {
    if (!nwc || !connected) {
        throw new Error('Alby Hub nepripojené — skontroluj ALBY_NWC_URI a setup Alby Hub UI');
    }
}

async function _withNwc(opName, fn) {
    ensureConnected();
    try {
        return await fn(nwc);
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        // Transport / auth failures → mark dead and retry later. Application
        // validation errors (bad args) keep the connection.
        if (/timeout|ECONN|ENOTFOUND|socket|closed|disconnected|unauthorized|forbidden|relay/i.test(msg)) {
            markDisconnected(`${opName}:${msg}`, supervisorLogger);
        }
        throw err;
    }
}

// Vytvorí Lightning invoice cez Alby Hub
// @param {number} amountSats - suma v SATS (nie msats!)
// @param {string} description - voliteľný popis
// @param {object} metadata - JSON metadata (uložené v invoice)
// @returns {{invoice, paymentHash, expiresAt, createdAt, amountSats}}
async function createInvoice({ amountSats, description, metadata }) {
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
        throw new Error('amountSats musí byť kladné celé číslo');
    }
    return _withNwc('createInvoice', async (client) => {
        const result = await client.makeInvoice({
            amount: amountSats * 1000, // NWC requires millisats
            description: description || '',
            metadata: metadata || undefined,
        });
        return {
            invoice: result.invoice,           // BOLT11 string
            paymentHash: result.payment_hash,
            amountSats,
            description: result.description,
            expiresAt: result.expires_at,      // unix timestamp
            createdAt: result.created_at,
            metadata: result.metadata,
        };
    });
}

// Skontroluje stav faktúry cez Alby Hub
// @returns { settled, paid, settledAt, amountReceivedSats, paymentHash }
async function lookupInvoice({ paymentHash, invoice }) {
    if (!paymentHash && !invoice) throw new Error('paymentHash alebo invoice povinné');
    return _withNwc('lookupInvoice', async (client) => {
        const result = await client.lookupInvoice(paymentHash ? { payment_hash: paymentHash } : { invoice });
        return {
            settled: !!result.settled_at,
            paid: !!result.settled_at,
            settledAt: result.settled_at,
            amountReceivedSats: Math.floor((result.amount || 0) / 1000),
            amountSats: Math.floor((result.amount || 0) / 1000),
            paymentHash: result.payment_hash,
            invoice: result.invoice,
            description: result.description,
            expiresAt: result.expires_at,
            state: result.state, // 'pending' | 'settled' | 'expired'
            type: result.type,   // 'incoming' | 'outgoing'
        };
    });
}

// Získa info o Alby Hub uzle
async function getInfo() {
    return _withNwc('getInfo', (client) => client.getInfo());
}

// Získa balance Alby Hub (msats → vrátime ako msats aj sats)
async function getBalance() {
    return _withNwc('getBalance', async (client) => {
        const result = await client.getBalance();
        const msats = result?.balance || 0;
        return {
            balanceMsats: msats,
            balanceSats: Math.floor(msats / 1000),
        };
    });
}

/**
 * Zaplatí BOLT11 faktúru (outbound). Vyžaduje NWC s oprávnením pay_invoice.
 * @param {string} invoice — BOLT11
 * @param {number} [amountSats] — voliteľná kontrola sumy (msats hint pre NWC)
 * @param {object} [metadata] — napr. { comment, registration_id }
 */
async function payInvoice({ invoice, amountSats, metadata }) {
    if (!invoice || typeof invoice !== 'string' || !invoice.toLowerCase().startsWith('ln')) {
        throw new Error('invoice musí byť platný BOLT11 reťazec');
    }
    return _withNwc('payInvoice', async (client) => {
        const req = { invoice: invoice.trim() };
        if (metadata && typeof metadata === 'object') {
            req.metadata = metadata;
        }
        if (Number.isInteger(amountSats) && amountSats > 0) {
            req.amount = amountSats * 1000;
        }
        const result = await client.payInvoice(req);
        return {
            preimage: result.preimage,
            feesPaidMsats: result.fees_paid ?? 0,
            feesPaidSats: Math.floor((result.fees_paid ?? 0) / 1000),
        };
    });
}

function loadPayNwcUri() {
    if (process.env.NWC_PAY_URI) return process.env.NWC_PAY_URI.trim();
    const payFile = process.env.NWC_PAY_URI_FILE;
    if (payFile) {
        try {
            if (fs.existsSync(payFile)) {
                return fs.readFileSync(payFile, 'utf8').trim();
            }
        } catch (_) { /* fall through */ }
    }
    return loadNwcUri();
}

// Subscribe na NWC notifikácie — callback dostane settled invoice events
function onSettled(callback) {
    if (typeof callback !== 'function') throw new Error('callback musí byť funkcia');
    settledListeners.add(callback);
    return () => settledListeners.delete(callback);
}

// Spustí background subscription pre real-time notifikácie (volaj raz pri štarte)
async function startSubscriptions(logger = console) {
    if (!isConfigured()) return false;
    ensureConnected();
    if (notificationsSub) return true; // už beží

    try {
        notificationsSub = await nwc.subscribeNotifications(
            (notification) => {
                // notification = { notification_type, notification: { invoice, payment_hash, amount, ... } }
                const type = notification?.notification_type;
                if (type === 'payment_received') {
                    const payload = notification.notification || {};
                    const event = {
                        type: 'payment_received',
                        paymentHash: payload.payment_hash,
                        invoice: payload.invoice,
                        amountSats: Math.floor((payload.amount || 0) / 1000),
                        settledAt: payload.settled_at,
                        description: payload.description,
                        metadata: payload.metadata,
                    };
                    logger.info?.({ msg: '[alby] payment received', paymentHash: event.paymentHash, amountSats: event.amountSats });
                    for (const cb of settledListeners) {
                        try { cb(event); } catch (e) { logger.error?.({ msg: '[alby] callback error', error: e.message }); }
                    }
                }
            },
            ['payment_received'] // iba notifikácie ktoré nás zaujímajú
        );
        logger.info?.('[alby] notifications subscription started');
        return true;
    } catch (err) {
        logger.error?.({ msg: '[alby] subscribeNotifications FAIL', error: err.message });
        markDisconnected(`subscribe:${err.message}`, logger);
        return false;
    }
}

/**
 * Lightweight liveness: getInfo with short timeout. On failure marks disconnected.
 * @returns {'OK'|'NOT_CONNECTED'|'NOT_CONFIGURED'|'ERROR'}
 */
async function probe(logger = console) {
    if (!isConfigured()) return 'NOT_CONFIGURED';
    if (!connected || !nwc) {
        scheduleReconnect(logger, 'probe_not_connected');
        return 'NOT_CONNECTED';
    }
    try {
        await Promise.race([
            nwc.getInfo(),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`alive timeout ${ALIVE_TIMEOUT_MS}ms`)), ALIVE_TIMEOUT_MS)),
        ]);
        return 'OK';
    } catch (err) {
        markDisconnected(`probe:${err.message}`, logger);
        return 'ERROR';
    }
}

function getStatus() {
    return {
        configured: isConfigured(),
        connected,
        connecting: !!connecting,
        reconnect_pending: !!reconnectTimer,
        reconnect_attempt: reconnectAttempt,
        supervisor_started: supervisorStarted,
        last_error: lastError,
        last_connected_at: lastConnectedAt,
        last_disconnect_at: lastDisconnectAt,
        last_disconnect_reason: lastDisconnectReason,
        uri_source: process.env.ALBY_NWC_URI
            ? 'env'
            : (process.env.ALBY_NWC_URI_FILE ? 'file_env' : 'file_default'),
    };
}

/** @internal test-only hooks */
function _setClientFactory(fn) {
    clientFactory = typeof fn === 'function' ? fn : ((uri) => new NWCClient({ nostrWalletConnectUrl: uri }));
}

function _resetForTests() {
    _clearReconnectTimer();
    nwc = null;
    connected = false;
    connecting = null;
    notificationsSub = null;
    reconnectAttempt = 0;
    supervisorStarted = false;
    lastError = null;
    lastConnectedAt = null;
    lastDisconnectAt = null;
    lastDisconnectReason = null;
    settledListeners.clear();
    clientFactory = (uri) => new NWCClient({ nostrWalletConnectUrl: uri });
}

module.exports = {
    isConfigured,
    isConnected: () => connected,
    connect,
    disconnect,
    ensureReady,
    startReconnectSupervisor,
    markDisconnected,
    createInvoice,
    lookupInvoice,
    getInfo,
    getBalance,
    payInvoice,
    loadNwcUri,
    loadPayNwcUri,
    onSettled,
    startSubscriptions,
    probe,
    getStatus,
    _setClientFactory,
    _resetForTests,
};
