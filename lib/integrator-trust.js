// ============================================================================
// Integrator trust envelope — cert proof + verification metadata for gates
// ============================================================================

const certs = require('./certs');
const hubkeys = require('./hubkeys');
const sandbox = require('./platform-integrator-sandbox');

const CACHE_TTL_MS = parseInt(process.env.INTEGRATOR_READ_CACHE_MS || '60000', 10);
const HUB_PUBLIC = (process.env.HUB_URL || process.env.HUB_PUBLIC_URL || 'https://www.umbraxon.xyz').replace(/\/$/, '');

function verificationEnvelope(kya_id, opts = {}) {
    const cacheSec = Math.max(1, Math.floor((opts.cacheTtlMs || CACHE_TTL_MS) / 1000));
    return {
        mode: 'hub_snapshot',
        cache_max_age_sec: cacheSec,
        hub_url: HUB_PUBLIC,
        cert_fetch: `${HUB_PUBLIC}/api/cert/${kya_id}`,
        cert_verify_post: `${HUB_PUBLIC}/api/cert/verify`,
        cert_status: `${HUB_PUBLIC}/api/cert/${kya_id}/status`,
        hub_pubkey_hex: (() => {
            try {
                return hubkeys.getPublicInfo().pubkey_hex;
            } catch {
                return null;
            }
        })(),
        recommend:
            'Low-value gates: hub snapshot is enough. High-value gates: fetch certificate, ' +
            'verify Ed25519 proof locally (same as POST /api/cert/verify crypto step), then check CRL status.',
        docs: `${HUB_PUBLIC}/docs/INTEGRATOR-TRUST-GATE.md`,
    };
}

/**
 * Server-side cert signature check for optional ?include=cert_proof on status API.
 * @param {object|null} certBody — full cert JSON with proof
 */
function certProofFromBody(certBody) {
    if (!certBody || typeof certBody !== 'object') {
        return { cert_signature_valid: false, cert_reason: 'NO_CERT' };
    }
    const v = certs.verifyCertSignature(certBody);
    return {
        cert_signature_valid: !!v.valid,
        cert_reason: v.reason,
        cert_expired: !!v.expired,
        hub_pubkey_hex: v.issuerPubkey || hubkeys.getPublicInfo().pubkey_hex,
    };
}

function sandboxBlockedInProduction(kya_id) {
    if (process.env.INTEGRATOR_SANDBOX_ON_PRODUCTION === 'true') return false;
    if (process.env.NODE_ENV !== 'production') return false;
    return sandbox.isSandboxKyaId(kya_id);
}

module.exports = {
    verificationEnvelope,
    certProofFromBody,
    sandboxBlockedInProduction,
    CACHE_TTL_MS,
};
