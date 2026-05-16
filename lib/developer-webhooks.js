// ============================================================================
// UMBRAXON KYA-Hub — Outbound developer webhooks (signed, non-custodial)
// ============================================================================
// Číta developer_webhooks z agent_manifest (JSONB). Odosiela HTTPS POST
// s hub Ed25519 podpisom nad canonical JSON (bez poľa hub_signature).
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

function _extractWebhooks(manifest) {
    const integ = manifest && manifest.integrations;
    if (!integ || !Array.isArray(integ.developer_webhooks)) return [];
    return integ.developer_webhooks.filter((w) => w && typeof w.url === 'string');
}

function _envelopeWithoutSig(env) {
    const { hub_signature, hub_pubkey, ...rest } = env;
    return rest;
}

function _signEnvelope(env) {
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

async function _postJson(url, jsonBody, timeoutMs = 5000) {
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
async function emit(pool, { event, kya_id, payload }) {
    if (!pool || !kya_id || !ALLOWED_EVENTS.has(event)) return;
    let r;
    try {
        r = await pool.query(
            `SELECT id, kya_id, agent_manifest FROM agents WHERE kya_id = $1`,
            [kya_id]
        );
    } catch {
        return;
    }
    if (r.rowCount === 0) return;
    const row = r.rows[0];
    const manifest = row.agent_manifest;
    const hooks = _extractWebhooks(manifest);
    if (hooks.length === 0) return;

    const issued_at = new Date().toISOString();
    for (const h of hooks) {
        if (!Array.isArray(h.events) || !h.events.includes(event)) continue;
        const env = {
            typ: 'KYADeveloperWebhook',
            v: 1,
            event,
            kya_id,
            issued_at,
            payload: payload || {},
        };
        const signed = _signEnvelope(env);
        try {
            await _postJson(h.url, signed);
        } catch {
            /* fire-and-forget */
        }
    }
}

module.exports = {
    emit,
    ALLOWED_EVENTS,
};
