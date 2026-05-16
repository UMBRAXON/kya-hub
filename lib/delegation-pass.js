// ============================================================================
// UMBRAXON KYA-Hub — Short-lived delegation pass (L402-aligned claims profile)
// ============================================================================
// Hub vydáva podpísaný JSON dokument viazaný na kya_id + manifest_hash + caveats.
// Neobsahuje spend authority; sub-wallet musí caveats vynútiť lokálne.
// ============================================================================

const crypto = require('crypto');
const net = require('net');
const hubkeys = require('./hubkeys');
const certs = require('./certs');

const TYP = 'KYADelegationPass';
const L402_PROFILE_ID = 'umbraxon-delegated-payment-v1';

/** Safe for PostgreSQL inet column; invalid / non-string → null. */
function normalizeInet(client_ip) {
    if (client_ip == null) return null;
    const s = String(client_ip).trim();
    if (!s || s.length > 64) return null;
    const v = s.startsWith('::ffff:') ? s.slice(7) : s;
    if (net.isIP(v)) return v;
    return null;
}

function _hubBaseUrl() {
    const u = (process.env.HUB_PUBLIC_URL || process.env.PUBLIC_HUB_URL || 'https://umbraxon.xyz').replace(/\/$/, '');
    return u;
}

function _canonicalCaveats(caveats) {
    if (!Array.isArray(caveats)) return '[]';
    return JSON.stringify(caveats.map((c) => String(c).slice(0, 256)));
}

/**
 * Agent musí podpísať request: sha256(kya_id|delegation_pass_request|ttl|caveatsCanon|l402Canon|nonce|timestamp)
 */
function agentRequestDigest({ kya_id, ttl_seconds, caveats, l402_claims, nonce, timestamp }) {
    const caveatsCanon = _canonicalCaveats(caveats);
    const l402Canon = l402_claims && typeof l402_claims === 'object'
        ? certs.canonicalize(l402_claims)
        : '{}';
    const msg = `${kya_id}|delegation_pass_request|${ttl_seconds}|${caveatsCanon}|${l402Canon}|${nonce}|${timestamp}`;
    return crypto.createHash('sha256').update(msg, 'utf8').digest();
}

function clampTtl(sec) {
    const n = parseInt(sec, 10);
    if (!Number.isFinite(n)) return 300;
    return Math.min(3600, Math.max(60, n));
}

function validateCaveats(caveats) {
    if (!Array.isArray(caveats) || caveats.length === 0) {
        return { ok: false, error: 'CAVEATS_REQUIRED' };
    }
    if (caveats.length > 24) return { ok: false, error: 'CAVEATS_TOO_MANY' };
    for (const c of caveats) {
        if (typeof c !== 'string' || c.length < 3 || c.length > 256) {
            return { ok: false, error: 'CAVIAT_BAD_FORMAT' };
        }
    }
    return { ok: true };
}

/**
 * Vydá podpísaný delegation pass (uloží jti do ledgeru).
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 */
async function issueDelegationPass(opts) {
    const {
        pool, kya_id, agent_id, agent_pubkey, manifest_hash,
        caveats, l402_claims, ttl_seconds, client_ip,
    } = opts;

    const ttl = clampTtl(ttl_seconds);
    const cv = validateCaveats(caveats);
    if (!cv.ok) {
        const e = new Error(cv.error);
        e.code = cv.error;
        throw e;
    }
    const claims = (l402_claims && typeof l402_claims === 'object') ? l402_claims : {};
    const now = Date.now();
    const iat = new Date(now).toISOString();
    const nbf = iat;
    const exp = new Date(now + ttl * 1000).toISOString();
    const jti = crypto.randomBytes(16).toString('hex');
    const caveats_hash = crypto.createHash('sha256').update(_canonicalCaveats(caveats), 'utf8').digest('hex');

    const bodyCore = {
        typ: TYP,
        v: 1,
        iss: _hubBaseUrl(),
        sub: kya_id,
        agent_pubkey: String(agent_pubkey || '').toLowerCase(),
        manifest_hash: manifest_hash || null,
        iat,
        nbf,
        exp,
        jti,
        caveats: caveats.map((c) => String(c).slice(0, 256)),
        l402: {
            profile: L402_PROFILE_ID,
            claims,
        },
    };

    const canonical = certs.canonicalize(bodyCore);
    const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest();
    let signatureHex;
    try {
        signatureHex = hubkeys.sign(digest, {
            role: 'BASIC',
            audit: { purpose: 'delegation_pass', kya_id, serial: null },
        });
    } catch (e) {
        throw e;
    }
    const pubHex = hubkeys.getPubkeyForRole('BASIC') || hubkeys.getPublicInfo().pubkey_hex;

    const out = {
        ...bodyCore,
        proof: {
            type: 'Ed25519Signature2020',
            created: iat,
            verificationMethod: `did:key:ed25519:${pubHex}#key-1`,
            proofPurpose: 'assertionMethod',
            algorithm: 'Ed25519',
            canonicalizationAlgorithm: 'urn:umbraxon:json-sorted-keys-v1',
            digestAlgorithm: 'SHA-256',
            signatureValue: signatureHex,
        },
    };

    try {
        await pool.query(
            `INSERT INTO delegation_pass_ledger (jti, kya_id, agent_id, caveats_hash, expires_at, client_ip)
             VALUES ($1, $2, $3, $4, $5, CAST($6 AS inet))`,
            [jti, kya_id, agent_id || null, caveats_hash, exp, normalizeInet(client_ip)]
        );
    } catch (e) {
        const err = new Error('DELEGATION_PASS_LEDGER_FAIL');
        err.code = 'DELEGATION_PASS_LEDGER_FAIL';
        err.cause = e;
        throw err;
    }

    return out;
}

/**
 * Overí hub podpis a časové okno (bez DB).
 */
function verifyDelegationPass(pass) {
    if (!pass || typeof pass !== 'object' || pass.typ !== TYP) {
        return { valid: false, reason: 'BAD_TYPE' };
    }
    const proof = pass.proof;
    if (!proof || !proof.signatureValue) return { valid: false, reason: 'NO_PROOF' };

    const { proof: _p, ...core } = pass;
    const canonical = certs.canonicalize(core);
    const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest();
    const vm = proof.verificationMethod || '';
    const m = vm.match(/^did:key:ed25519:([0-9a-fA-F]{64})/);
    if (!m) return { valid: false, reason: 'INVALID_VERIFICATION_METHOD' };
    const issuerPubkey = m[1].toLowerCase();
    const ok = hubkeys.verify(digest, proof.signatureValue, issuerPubkey);
    if (!ok) return { valid: false, reason: 'SIGNATURE_MISMATCH', issuerPubkey };

    const expMs = new Date(pass.exp).getTime();
    const nbfMs = new Date(pass.nbf).getTime();
    const now = Date.now();
    if (!Number.isFinite(expMs) || !Number.isFinite(nbfMs)) return { valid: false, reason: 'BAD_TIME' };
    if (now < nbfMs) return { valid: false, reason: 'NOT_YET_VALID', issuerPubkey };
    if (now > expMs) return { valid: false, reason: 'EXPIRED', issuerPubkey };

    return { valid: true, reason: 'OK', issuerPubkey };
}

function l402DelegationProfileDoc() {
    return {
        profile: L402_PROFILE_ID,
        title: 'UMBRAXON KYA delegated payment (non-custodial)',
        description:
            'Short-lived hub-signed pass binding KYA identity to payment caveats. ' +
            'The hub never holds spend authority; enforcing caveats is the wallet/runtime responsibility.',
        kya_delegation_pass: {
            typ: TYP,
            version: 1,
            signing: {
                algorithm: 'Ed25519',
                digest: 'SHA-256',
                canonicalization: 'urn:umbraxon:json-sorted-keys-v1',
                message: 'sha256(canonical(pass body without proof))',
            },
            agent_request: {
                digest: 'sha256(utf8 concat of kya_id|delegation_pass_request|ttl_seconds|caveats_json|l402_claims_canonical|nonce|timestamp)',
                signature: 'Ed25519 detached hex128 over digest, verified against agents.agent_pubkey',
            },
        },
        l402_claims_schema: {
            type: 'object',
            additionalProperties: true,
            recommended_fields: {
                max_msat: 'integer — hard cap for delegated payer runtime',
                max_satoshi: 'integer — optional satoshi cap (display layer)',
                allowed_destination_prefixes: 'string[] — e.g. lnbc, offer prefixes',
                memo_prefix: 'string — invoices must start with this memo',
            },
        },
        caveat_examples: [
            'payment.max_satoshi:5000',
            'payment.max_msat:5000000',
            'payment.memo_prefix:KYA-UMBRA-',
        ],
        verify_endpoints: {
            delegation_pass_verify: '/api/delegation-pass/verify',
            cert_verify: '/api/cert/verify',
            crl_latest: '/crl/latest.json',
        },
    };
}

module.exports = {
    TYP,
    L402_PROFILE_ID,
    agentRequestDigest,
    issueDelegationPass,
    verifyDelegationPass,
    l402DelegationProfileDoc,
    clampTtl,
    validateCaveats,
    normalizeInet,
};
