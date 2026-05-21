// ============================================================================
// UMBRAXON KYA-Hub — Notifications (Phase 2.4 follow-up)
// ============================================================================
// Lightweight Telegram + Discord notification helper pre operator-facing eventy.
// Volaný zo server.js pri:
//   - úspešnej platenej registrácii BASIC aj ELITE (Telegram PING)
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

async function sendTelegram(text, opts = {}) {
    if (!CFG.TELEGRAM_BOT_TOKEN || !CFG.TELEGRAM_CHAT_ID) return false;
    const payload = {
        chat_id: CFG.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
    };
    if (opts.plain) {
        // no parse_mode
    } else {
        payload.parse_mode = 'HTML';
    }
    try {
        await axios.post(
            `https://api.telegram.org/bot${CFG.TELEGRAM_BOT_TOKEN}/sendMessage`,
            payload,
            { timeout: opts.timeoutMs || CFG.NOTIF_TIMEOUT_MS }
        );
        return true;
    } catch (_) { return false; }
}

/** Daily digest — no dedupe, longer timeout. */
async function sendTelegramDigest(text) {
    return sendTelegram(text, { timeoutMs: 15000 });
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
/**
 * Telegram/Discord PING po každej zaplatenej registrácii (BASIC aj ELITE).
 */
function notifyRegistrationPaid({ tier, agentName, axisId, paymentMethod, amountSats }) {
    const t = String(tier || '?').toUpperCase();
    return notify({
        category: 'info',
        title: `PING: Registration paid (${t})`,
        body: `tier: ${t}\nname: ${agentName}\naxis: ${axisId}\nmethod: ${paymentMethod}\namount: ${amountSats} SAT`,
        dedupe_key: `reg_paid:${axisId}`,
    });
}

/** @deprecated Prefer notifyRegistrationPaid */
function notifyEliteRegistered({ agentName, axisId, paymentMethod, amountSats }) {
    return notifyRegistrationPaid({
        tier: 'ELITE', agentName, axisId, paymentMethod, amountSats,
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

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Nová žiadosť o integrátor API kľúč (web formulár → DB, operátor schvaľuje ručne).
 */
function notifyIntegratorKeyRequest({
    request_id,
    organization,
    contact_email,
    use_case,
    website,
    client_ip,
}) {
    if (process.env.INTEGRATOR_KEY_REQUEST_NOTIFY === 'false') {
        return Promise.resolve({ skipped: true });
    }
    const site = website ? `\nweb: ${escapeHtml(website)}` : '';
    const ip = client_ip ? `\nip: ${escapeHtml(client_ip)}` : '';
    const draftReply = [
        `Hi ${organization},`,
        '',
        'Thanks for the integrator key request on UMBRAXON KYA Hub.',
        '',
        'Quick test (no payment):',
        'curl -sS "https://www.umbraxon.xyz/api/v1/agents/UMBRA-TEST-0001/status"',
        '',
        'Docs: https://www.umbraxon.xyz/integrators',
        'npm: @umbraxon_kya/kya-verify',
        '',
        'We will send your umb_live_… key after approval.',
        '',
        '— UMBRAXON',
    ].join('\n');

    return notify({
        category: 'info',
        title: 'Integrator API key request',
        body: [
            `id: <code>${escapeHtml(request_id)}</code>`,
            `org: ${escapeHtml(organization)}`,
            `email: ${escapeHtml(contact_email)}`,
            site,
            ip,
            '',
            escapeHtml(String(use_case).slice(0, 1200)),
            '',
            '<b>Draft reply</b> (copy to email):',
            `<pre>${escapeHtml(draftReply)}</pre>`,
            '',
            'Approve:',
            '<code>POST /api/admin/integrator-key-requests/{id}/approve</code>',
            '(X-Admin-Key; api_key in response once)',
        ].filter(Boolean).join('\n'),
        dedupe_key: `integrator_req:${request_id}`,
    });
}

module.exports = {
    CFG,
    notify,
    notifyRegistrationPaid,
    notifyEliteRegistered,
    notifyBtcpayOutage,
    notifyDbDown,
    notifyHmacFailureSpike,
    notifyIntegratorKeyRequest,
    sendTelegram,
    sendTelegramDigest,
    sendDiscord,
    _lastSent: lastSent, // export pre testy
};
