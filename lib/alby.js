// UMBRAXON KYA-Hub — Alby Hub NWC wrapper
//
// Tento modul obaľuje @getalby/sdk pre prácu s Alby Hub cez Nostr Wallet Connect.
// Connection URI sa nastavuje cez .env premennú ALBY_NWC_URI.
//
// Použitie:
//   const alby = require('./lib/alby');
//   await alby.connect();                // pripoji sa pri štarte (idempotent)
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

const NWC_URI = loadNwcUri();

let nwc = null;
let connected = false;
let notificationsSub = null;
const settledListeners = new Set();

function isConfigured() {
    return !!NWC_URI && NWC_URI.startsWith('nostr+walletconnect://');
}

async function connect(logger = console) {
    if (!isConfigured()) {
        logger.warn?.('[alby] ALBY_NWC_URI nie je nastavené — Alby Hub integrácia VYPNUTÁ');
        return false;
    }
    if (connected && nwc) return true;

    try {
        nwc = new NWCClient({ nostrWalletConnectUrl: NWC_URI });
        // Sanity check — getInfo zlyhá ak permissions chýbajú
        const info = await Promise.race([
            nwc.getInfo(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 10s')), 10000))
        ]);
        connected = true;
        logger.info?.({ msg: '[alby] pripojené', alias: info?.alias, methods: info?.methods, network: info?.network });
        return true;
    } catch (err) {
        connected = false;
        nwc = null;
        logger.error?.({ msg: '[alby] connect FAIL', error: err.message });
        throw err;
    }
}

function ensureConnected() {
    if (!nwc || !connected) {
        throw new Error('Alby Hub nepripojené — skontroluj ALBY_NWC_URI a setup Alby Hub UI');
    }
}

// Vytvorí Lightning invoice cez Alby Hub
// @param {number} amountSats - suma v SATS (nie msats!)
// @param {string} description - voliteľný popis
// @param {object} metadata - JSON metadata (uložené v invoice)
// @returns {{invoice, paymentHash, expiresAt, createdAt, amountSats}}
async function createInvoice({ amountSats, description, metadata }) {
    ensureConnected();
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
        throw new Error('amountSats musí byť kladné celé číslo');
    }
    const result = await nwc.makeInvoice({
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
}

// Skontroluje stav faktúry cez Alby Hub
// @returns { settled, paid, settledAt, amountReceivedSats, paymentHash }
async function lookupInvoice({ paymentHash, invoice }) {
    ensureConnected();
    if (!paymentHash && !invoice) throw new Error('paymentHash alebo invoice povinné');
    const result = await nwc.lookupInvoice(paymentHash ? { payment_hash: paymentHash } : { invoice });
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
}

// Získa info o Alby Hub uzle
async function getInfo() {
    ensureConnected();
    return await nwc.getInfo();
}

// Získa balance Alby Hub (msats → vrátime ako msats aj sats)
async function getBalance() {
    ensureConnected();
    const result = await nwc.getBalance();
    const msats = result?.balance || 0;
    return {
        balanceMsats: msats,
        balanceSats: Math.floor(msats / 1000),
    };
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
        return false;
    }
}

async function disconnect() {
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

module.exports = {
    isConfigured,
    isConnected: () => connected,
    connect,
    disconnect,
    createInvoice,
    lookupInvoice,
    getInfo,
    getBalance,
    onSettled,
    startSubscriptions,
};
