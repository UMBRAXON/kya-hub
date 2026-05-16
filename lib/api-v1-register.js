// ============================================================================
// UMBRAXON KYA-Hub — POST /api/v1/register (M2M canonical entry)
// ============================================================================
// Normalizes a compact JSON body into the legacy initiate shape
// (manifest + manifest_signature + challenge_* + pow).
// ============================================================================

const crypto = require('crypto');

const LN_NODE_RE = /^(?:[0-9a-f]{66}|[0-9a-f]{66}@[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?)$/i;
const PUBKEY_RE = /^[0-9a-fA-F]{64}$/;
const AGENT_NAME_RE = /^[A-Za-z0-9._-]{3,64}$/;

function normalizePubkey(raw) {
    if (raw == null || raw === '') return null;
    const p = String(raw).trim().toLowerCase();
    return PUBKEY_RE.test(p) ? p : null;
}

function validateLightningNodeId(raw) {
    if (raw == null || raw === '') return { ok: false, error: 'LIGHTNING_NODE_ID_REQUIRED' };
    const v = String(raw).trim();
    if (v.length > 128 || !LN_NODE_RE.test(v)) {
        return { ok: false, error: 'INVALID_LIGHTNING_NODE_ID' };
    }
    return { ok: true, value: v };
}

function validateCapabilities(caps) {
    if (!Array.isArray(caps) || caps.length < 1 || caps.length > 32) {
        return { ok: false, error: 'INVALID_CAPABILITIES' };
    }
    for (const c of caps) {
        if (typeof c !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(c)) {
            return { ok: false, error: 'INVALID_CAPABILITIES' };
        }
    }
    return { ok: true, value: caps };
}

/**
 * Build manifest object from v1 flat fields (client must sign this exact structure).
 */
function buildManifestFromV1(fields) {
    const paymentHints = [{
        type: 'lightning_node_id',
        value: fields.lightning_node_id,
        label: 'm2m_registration',
    }];
    if (Array.isArray(fields.payment_hints) && fields.payment_hints.length) {
        for (const h of fields.payment_hints) {
            if (h && h.type !== 'lightning_node_id') paymentHints.push(h);
        }
    }
    const manifest = {
        protocol_version: '1.0',
        agent: {
            name: fields.agent_name,
            version: fields.agent_version || '1.0.0',
            pubkey: fields.public_key,
            capabilities: fields.capabilities,
        },
        tier_requested: fields.tier_requested,
        timestamp: fields.timestamp,
        nonce: fields.nonce,
        payment_hints: paymentHints,
    };
    if (fields.integrations && typeof fields.integrations === 'object') {
        manifest.integrations = fields.integrations;
    }
    if (fields.agent_description) {
        manifest.agent.description = String(fields.agent_description).slice(0, 512);
    }
    return manifest;
}

/**
 * @param {object} body — raw POST body
 * @returns {{ ok: true, body: object } | { ok: false, status: number, json: object }}
 */
function normalizeToInitiateBody(body) {
    if (!body || typeof body !== 'object') {
        return { ok: false, status: 400, json: { error: 'INVALID_BODY' } };
    }

    // Full initiate payload — pass through unchanged
    if (body.manifest && typeof body.manifest === 'object') {
        return {
            ok: true,
            body: {
                manifest: body.manifest,
                manifest_signature: body.manifest_signature,
                challenge_id: body.challenge_id,
                challenge_response: body.challenge_response,
                pow: body.pow,
                sponsor_invite_id: body.sponsor_invite_id,
            },
        };
    }

    const publicKey = normalizePubkey(
        body.public_key ?? body.pubkey ?? body.agent_pubkey
    );
    if (!publicKey) {
        return { ok: false, status: 400, json: { error: 'INVALID_PUBLIC_KEY' } };
    }

    const ln = validateLightningNodeId(
        body.lightning_node_id ?? body.lightningNodeId ?? body.ln_node_id
    );
    if (!ln.ok) {
        return { ok: false, status: 400, json: { error: ln.error } };
    }

    const caps = validateCapabilities(body.capabilities);
    if (!caps.ok) {
        return { ok: false, status: 400, json: { error: caps.error } };
    }

    const agentName = String(body.agent_name ?? body.agentName ?? '').trim();
    if (!AGENT_NAME_RE.test(agentName)) {
        return { ok: false, status: 400, json: { error: 'INVALID_AGENT_NAME' } };
    }

    const tierRaw = String(body.tier ?? body.tier_requested ?? 'BASIC').toUpperCase();
    if (tierRaw !== 'BASIC' && tierRaw !== 'ELITE') {
        return { ok: false, status: 400, json: { error: 'INVALID_TIER' } };
    }

    const timestamp = body.timestamp;
    const nonce = body.nonce;
    if (!timestamp || typeof timestamp !== 'string') {
        return { ok: false, status: 400, json: { error: 'TIMESTAMP_REQUIRED' } };
    }
    if (!nonce || typeof nonce !== 'string' || !/^[0-9a-fA-F]{16,64}$/.test(nonce)) {
        return { ok: false, status: 400, json: { error: 'INVALID_NONCE' } };
    }

    if (!body.manifest_signature || !/^[0-9a-fA-F]{128}$/.test(body.manifest_signature)) {
        return { ok: false, status: 400, json: { error: 'MANIFEST_SIGNATURE_REQUIRED' } };
    }
    if (!body.challenge_id || !body.challenge_response) {
        return { ok: false, status: 400, json: { error: 'CHALLENGE_REQUIRED' } };
    }

    const manifest = buildManifestFromV1({
        agent_name: agentName,
        agent_version: body.agent_version ?? body.version,
        public_key: publicKey,
        capabilities: caps.value,
        tier_requested: tierRaw,
        timestamp,
        nonce,
        lightning_node_id: ln.value,
        payment_hints: body.payment_hints,
        integrations: body.integrations,
        agent_description: body.description ?? body.agent_description,
    });

    return {
        ok: true,
        body: {
            manifest,
            manifest_signature: body.manifest_signature,
            challenge_id: body.challenge_id,
            challenge_response: body.challenge_response,
            pow: body.pow,
            sponsor_invite_id: body.sponsor_invite_id,
        },
    };
}

/** Express middleware: rewrite req.body to initiate shape. */
function normalizeMiddleware(req, res, next) {
    const out = normalizeToInitiateBody(req.body);
    if (!out.ok) {
        return res.status(out.status).json(out.json);
    }
    req.body = out.body;
    req.v1RegisterNormalized = true;
    next();
}

/** Extract lightning_node_id from manifest payment_hints for DB index. */
function lightningNodeIdFromManifest(manifest) {
    if (!manifest || !Array.isArray(manifest.payment_hints)) return null;
    for (const h of manifest.payment_hints) {
        if (h && h.type === 'lightning_node_id' && h.value) {
            const v = String(h.value).trim();
            if (LN_NODE_RE.test(v)) return v;
        }
    }
    return null;
}

module.exports = {
    normalizeToInitiateBody,
    normalizeMiddleware,
    buildManifestFromV1,
    validateLightningNodeId,
    lightningNodeIdFromManifest,
    LN_NODE_RE,
};
