// ============================================================================
// UMBRAXON KYA-Hub — Outbound developer webhooks (signed, non-custodial)
// ============================================================================
// Enqueues to developer_webhook_outbox; delivery via developer-webhook-queue worker.
// ============================================================================

const crypto = require('crypto');
const hubkeys = require('./hubkeys');
const certs = require('./certs');

const ALLOWED_EVENTS = new Set([
    'agent.registered',
    'reputation.changed',
    'cert.revoked',
    'cert.reissued',
]);

let _queue;
function _getQueue() {
    if (!_queue) _queue = require('./developer-webhook-queue');
    return _queue;
}

function _extractWebhooks(manifest) {
    const integ = manifest && manifest.integrations;
    if (!integ || !Array.isArray(integ.developer_webhooks)) return [];
    return integ.developer_webhooks.filter((w) => w && typeof w.url === 'string');
}

function _envelopeWithoutSig(env) {
    const { hub_signature, hub_pubkey, ...rest } = env;
    return rest;
}

function signEnvelope(env) {
    const body = _envelopeWithoutSig(env);
    const canonical = certs.canonicalize(body);
    const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest();
    const sig = hubkeys.sign(digest, {
        role: 'BASIC',
        audit: { purpose: 'dev_webhook', kya_id: env.kya_id || null, serial: null },
    });
    const pub = hubkeys.getPubkeyForRole('BASIC') || hubkeys.getPublicInfo().pubkey_hex;
    return { ...env, hub_signature: sig, hub_pubkey: pub };
}

async function postJson(url, jsonBody, timeoutMs = 5000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'KYA-Hub-DeveloperWebhook/1' },
            body: JSON.stringify(jsonBody),
            signal: ac.signal,
        });
        return { ok: r.ok, status: r.status };
    } finally {
        clearTimeout(t);
    }
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ event: string, kya_id: string, payload?: object }} args
 */
function emit(pool, { event, kya_id, payload }) {
    if (!pool || !kya_id || !ALLOWED_EVENTS.has(event)) return;
    pool.query(
        `SELECT id, kya_id, agent_manifest FROM agents WHERE kya_id = $1`,
        [kya_id]
    ).then((r) => {
        if (r.rowCount === 0) return;
        const manifest = r.rows[0].agent_manifest;
        const hooks = _extractWebhooks(manifest);
        if (hooks.length === 0) return;
        const queue = _getQueue();
        for (const h of hooks) {
            if (!Array.isArray(h.events) || !h.events.includes(event)) continue;
            queue.enqueue(pool, {
                event,
                kya_id,
                url: h.url,
                payload: payload || {},
            }).catch(() => {});
        }
    }).catch(() => {});
}

module.exports = {
    emit,
    signEnvelope,
    postJson,
    ALLOWED_EVENTS,
    _extractWebhooks,
};
