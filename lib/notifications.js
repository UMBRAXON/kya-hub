// ============================================================================
// UMBRAXON KYA-Hub — Notifications (Phase 2.4 follow-up)
// ============================================================================
// Lightweight Telegram + Discord notification helper pre operator-facing eventy.
// Volaný zo server.js pri:
//   - ELITE registrácii (info, ihneď vedieť)
//   - BTCPay outage (warning)
//   - DB connectivity loss (critical)
//   - Webhook signature failure spike (warning)
//
// Dizajn:
//   - Fire-and-forget (žiadne await blokuje request handler).
//   - In-memory dedupe (rovnaká kategória nevyletí 100×/min).
//   - Env-driven; ak nie sú nastavené credentials, len no-op.
//   - axios s krátkym timeoutom (3s) — pri zlyhaní notifikácie nikdy nezhoríme.
// ============================================================================

const axios = require('axios');

const CFG = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
    NOTIF_DEDUPE_MS: parseInt(process.env.NOTIF_DEDUPE_MS || '300000', 10), // 5 min
    NOTIF_TIMEOUT_MS: parseInt(process.env.NOTIF_TIMEOUT_MS || '3000', 10),
    NOTIF_ENABLED: process.env.NOTIF_ENABLED !== 'false',
};

const HOSTNAME = require('os').hostname();

// dedupe cache: { 'category:key' → lastSentMs }
const lastSent = new Map();

function isDuped(category, key) {
    const id = `${category}:${key || 'default'}`;
    const now = Date.now();
    const prev = lastSent.get(id);
    if (prev && (now - prev) < CFG.NOTIF_DEDUPE_MS) return true;
    lastSent.set(id, now);
    // periodic cleanup
    if (lastSent.size > 200) {
        const cutoff = now - 24 * 3600 * 1000;
        for (const [k, v] of lastSent) if (v < cutoff) lastSent.delete(k);
    }
    return false;
}

async function sendTelegram(text) {
    if (!CFG.TELEGRAM_BOT_TOKEN || !CFG.TELEGRAM_CHAT_ID) return false;
    try {
        await axios.post(
            `https://api.telegram.org/bot${CFG.TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: CFG.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true },
            { timeout: CFG.NOTIF_TIMEOUT_MS }
        );
        return true;
    } catch (_) { return false; }
}

async function sendDiscord(text) {
    if (!CFG.DISCORD_WEBHOOK_URL) return false;
    try {
        await axios.post(
            CFG.DISCORD_WEBHOOK_URL,
            { content: text.replace(/<[^>]+>/g, '') }, // strip HTML tags pre Discord
            { timeout: CFG.NOTIF_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
        );
        return true;
    } catch (_) { return false; }
}

/**
 * Pošli notifikáciu na všetky nakonfigurované kanály.
 *
 * @param {object} opts
 *   - category: 'critical' | 'warning' | 'info'
 *   - title: krátky titulok (napr. 'BTCPay outage')
 *   - body: detail
 *   - dedupe_key: voliteľný kľúč pre dedupe (default = title)
 */
function notify(opts) {
    if (!CFG.NOTIF_ENABLED) return Promise.resolve({ skipped: true });
    const { category = 'info', title = '(no title)', body = '', dedupe_key } = opts || {};

    if (isDuped(category, dedupe_key || title)) {
        return Promise.resolve({ deduped: true });
    }

    const emoji = { critical: '🚨', warning: '⚠️', info: 'ℹ️' }[category] || 'ℹ️';
    const text = `${emoji} <b>${title}</b>\nhost: ${HOSTNAME}\n${body}`;

    // fire-and-forget; never throw
    return Promise.allSettled([sendTelegram(text), sendDiscord(text)])
        .then(([tg, dc]) => ({
            telegram: tg.status === 'fulfilled' && tg.value,
            discord: dc.status === 'fulfilled' && dc.value,
        }));
}

/**
 * Špecializované helpery (sémantické wrappers).
 */
function notifyEliteRegistered({ agentName, axisId, paymentMethod, amountSats }) {
    return notify({
        category: 'info',
        title: 'ELITE agent registered',
        body: `name: ${agentName}\naxis: ${axisId}\nmethod: ${paymentMethod}\namount: ${amountSats} SAT`,
        dedupe_key: axisId,
    });
}

function notifyBtcpayOutage({ error, httpStatus }) {
    return notify({
        category: 'warning',
        title: 'BTCPay unreachable',
        body: `status: ${httpStatus || '?'}\nerror: ${(error || '').slice(0, 200)}\nimpact: nové BASIC/ELITE registrácie cez BTCPay zlyhajú (Alby fallback ak online)`,
        dedupe_key: 'btcpay_outage',
    });
}

function notifyDbDown({ error }) {
    return notify({
        category: 'critical',
        title: 'Database connectivity lost',
        body: `error: ${(error || '').slice(0, 200)}\nimpact: server nedokáže obsluhovať väčšinu requestov`,
        dedupe_key: 'db_down',
    });
}

function notifyHmacFailureSpike({ window_min, count, source }) {
    return notify({
        category: 'warning',
        title: 'Webhook HMAC failure spike',
        body: `source: ${source}\ncount: ${count} in last ${window_min}min\nimpact: možný útok alebo zlý webhook secret`,
        dedupe_key: `hmac_spike_${source}`,
    });
}

module.exports = {
    CFG,
    notify,
    notifyEliteRegistered,
    notifyBtcpayOutage,
    notifyDbDown,
    notifyHmacFailureSpike,
    sendTelegram,
    sendDiscord,
    _lastSent: lastSent, // export pre testy
};
