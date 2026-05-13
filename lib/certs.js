// ============================================================================
// UMBRAXON KYA-Hub — Certificate Issuance & Verification
// ============================================================================
// Vystavuje podpísané JSON certifikáty pre agentov po úspešnej platbe.
// Formát je W3C VC-compatible (kompatibilný s budúcim prechodom na full VC),
// momentálne ale držaný jednoduchý (vlastný JSON-LD-ish bez context resolution).
//
// Cert sa podpisuje:
//   - canonical JSON serializácia bez 'proof' poľa
//   - Ed25519 podpis cez sha256(canonical)
//   - Pridáme 'proof' s podpisom a issuer pubkey
//
// Tretia strana môže overiť OFFLINE (stačí jej HUB_PUBKEY) alebo ONLINE
// (volá GET /api/cert/verify ktorý okrem kryptografie skontroluje aj revocation).
// ============================================================================
const crypto = require('crypto');
const hubkeys = require('./hubkeys');
const reputation = require('./reputation');

const CONTEXT_URL = 'https://umbraxon.xyz/contexts/kya-agent-cert-v1';
const CERT_TYPE = ['VerifiableCredential', 'KYAAgentCertificate'];

// Liability disclaimer — vkladá sa do každého vystavovaného certifikátu.
// Hot-reload nie je nutný (mení sa zriedka); ak treba zmena, edit .env a reštart.
const CERT_DISCLAIMER = process.env.CERT_DISCLAIMER ||
    'This certificate attests the agent\'s reputation based on historical on-hub behavior. ' +
    'It is NOT a guarantee of future conduct. UMBRAXON KYA-Hub operator disclaims all ' +
    'liability for losses or damages caused by certified agents. Relying parties are ' +
    'expected to perform their own due diligence proportional to transaction value.';

const CERT_TERMS_URL = process.env.CERT_TERMS_URL || 'https://umbraxon.xyz/terms';

/**
 * Vytvorí cert telo (bez proof) pre agenta.
 *
 * @param {object} input
 *   - kya_id        – napr. UMBRA-A1B2C3
 *   - agentName     – meno agenta
 *   - pubkey        – Ed25519 pubkey bota (hex)
 *   - tier          – 'BASIC' | 'ELITE'
 *   - grade         – 'B' | 'S'
 *   - validUntil    – Date alebo null (pre ELITE)
 *   - manifestHash  – sha256 hex
 *   - manufacturerId – string alebo null
 *   - reputationScore – integer 0-1000
 *   - paymentMethod – 'lightning' | 'btcpay' | 'onchain'
 *   - paymentHash   – LN payment hash / BTCPay invoice ID
 *   - amountSats    – integer
 *   - serial        – CERT-XXXXXX-N
 *
 * @returns {object} cert body (W3C VC-shaped)
 */
function buildCertBody({
    kya_id, agentName, pubkey, tier, grade, validUntil,
    manifestHash, manufacturerId, reputationScore,
    paymentMethod, paymentHash, amountSats, serial
}) {
    const issuanceDate = new Date().toISOString();
    const expirationDate = validUntil ? new Date(validUntil).toISOString() : null;
    const hubPubInfo = hubkeys.getPublicInfo();
    
    return {
        '@context': [
            'https://www.w3.org/2018/credentials/v1',
            CONTEXT_URL,
        ],
        type: CERT_TYPE,
        id: `urn:kya:cert:${serial}`,
        issuer: {
            id: `did:key:ed25519:${hubPubInfo.pubkey_hex}`,
            name: hubPubInfo.hub_name,
            url: hubPubInfo.hub_url,
        },
        issuanceDate,
        expirationDate, // null pre ELITE (forever)
        credentialSubject: {
            id: `urn:kya:agent:${kya_id}`,
            kya_id,
            agent_name: agentName,
            agent_pubkey: pubkey || null,
            tier,
            grade,
            reputation: (function () {
                const score = reputationScore ?? 100;
                const z = reputation.describe(score);
                return {
                    score: z.score,
                    zone: z.zone,
                    zone_label: z.zone_label,
                    max_score: z.max_score,
                    operational: z.operational,
                };
            })(),
            manufacturer_id: manufacturerId || null,
            manifest_hash: manifestHash || null,
            payment_proof: {
                method: paymentMethod,
                payment_hash: paymentHash,
                amount_sats: amountSats,
            },
        },
        credentialStatus: {
            id: `${hubPubInfo.hub_url}/api/cert/${kya_id}/status`,
            type: 'KYACertRevocationCheck',
        },
        termsOfUse: [{
            type: 'IssuerPolicy',
            id: CERT_TERMS_URL,
            disclaimer: CERT_DISCLAIMER,
            relyingPartyDuty: 'due_diligence_proportional_to_value',
        }],
    };
    // 'proof' sa pridá až pri signCert()
}

/**
 * Canonical JSON serializácia (deterministická pre podpis).
 * Sortuje kľúče rekurzívne, žiadny whitespace, escape ASCII.
 */
function canonicalize(obj) {
    const sorted = sortObjectKeys(obj);
    return JSON.stringify(sorted);
}

function sortObjectKeys(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortObjectKeys);
    return Object.keys(value).sort().reduce((acc, k) => {
        acc[k] = sortObjectKeys(value[k]);
        return acc;
    }, {});
}

// ----------------------------------------------------------------------------
// Multi-sig config (Phase 5b)
// ----------------------------------------------------------------------------
// ELITE certs are signed by 2 online roles (BASIC + ELITE) by default; ROOT is
// held offline for emergency / break-glass cert re-issuance only.
//
// Env knobs (production defaults):
//   - CERT_ELITE_MULTISIG=true        (default true)   → ELITE multi-sig on
//   - CERT_ELITE_MULTISIG_ROLES       (default 'BASIC,ELITE')
//   - CERT_ELITE_MULTISIG_THRESHOLD   (default 2)
//   - CERT_ELITE_MULTISIG_OPTIONAL    (default '')      — roles that may be
//                                                          missing without
//                                                          throwing
//
// Emergency break-glass (operator-invoked, NOT automatic): pass explicit
//   { multiSig: true, roles: ['BASIC','ELITE','ROOT'], threshold: 3 }
// to signCert(). ROOT key must be configured (HUB_KEY_ROOT_*) for this path.
//
// Set CERT_ELITE_MULTISIG=false to fall back to legacy single-sig (BASIC/ELITE).
function _multisigEnabled() {
    return String(process.env.CERT_ELITE_MULTISIG || 'true').toLowerCase() !== 'false';
}
function _multisigConfig() {
    const roles = (process.env.CERT_ELITE_MULTISIG_ROLES || 'BASIC,ELITE')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const optional = (process.env.CERT_ELITE_MULTISIG_OPTIONAL || '')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    let threshold = parseInt(process.env.CERT_ELITE_MULTISIG_THRESHOLD || '2', 10);
    if (!Number.isFinite(threshold) || threshold < 1) threshold = 2;
    if (threshold > roles.length) threshold = roles.length;
    return { roles, optional, threshold };
}

/**
 * Podpíše cert body hub privkey-om a vráti finálny cert s 'proof'.
 *
 * @param {object} certBody
 * @param {object} [audit] - Phase 2.3 audit context:
 *   - purpose: 'cert_issue' | 'cert_reissue' | 'cert_revoke_attest' (default cert_issue)
 *   - serial, kya_id, admin_user, client_ip
 * @param {string|object} [roleOrOpts]
 *   - string: legacy 'BASIC' | 'ELITE' — vynúti single-sig.
 *   - object: { role, multiSig: true|false, roles, threshold, optional } — explicit override.
 *     Ak `multiSig` nie je nastavený, použije sa default per-tier:
 *       - ELITE  → CERT_ELITE_MULTISIG (default true)
 *       - BASIC  → vždy single-sig (kompatibilita)
 */
function signCert(certBody, audit, roleOrOpts) {
    const canonical = canonicalize(certBody);
    const digest = crypto.createHash('sha256').update(canonical).digest();

    const tier = (certBody.credentialSubject && certBody.credentialSubject.tier) || null;

    // Resolve options
    let opts = {};
    if (typeof roleOrOpts === 'string') opts.role = roleOrOpts;
    else if (roleOrOpts && typeof roleOrOpts === 'object') opts = { ...roleOrOpts };

    const wantMulti = (opts.multiSig === true)
        || (opts.multiSig === undefined && tier === 'ELITE' && _multisigEnabled());

    if (wantMulti) {
        return _signCertMultiSig(certBody, digest, audit, opts);
    }
    return _signCertSingle(certBody, digest, audit, opts);
}

function _signCertSingle(certBody, digest, audit, opts) {
    const tier = (certBody.credentialSubject && certBody.credentialSubject.tier) || null;
    const inferredRole = opts.role || (tier === 'ELITE' ? 'ELITE' : 'BASIC');

    let signatureHex;
    let usedRole = inferredRole;
    try {
        signatureHex = hubkeys.sign(digest, {
            role: inferredRole,
            audit: audit ? {
                purpose: audit.purpose || 'cert_issue', serial: audit.serial,
                kya_id: audit.kya_id, admin_user: audit.admin_user, client_ip: audit.client_ip,
            } : undefined,
        });
    } catch (e) {
        // Ak ELITE key nie je nakonfigurovaný, padáme na BASIC (backward compat).
        if (inferredRole === 'ELITE') {
            signatureHex = hubkeys.sign(digest, {
                role: 'BASIC',
                audit: audit ? {
                    purpose: audit.purpose || 'cert_issue', serial: audit.serial,
                    kya_id: audit.kya_id, admin_user: audit.admin_user, client_ip: audit.client_ip,
                } : undefined,
            });
            usedRole = 'BASIC';
        } else { throw e; }
    }

    const pubHex = hubkeys.getPubkeyForRole(usedRole) || hubkeys.getPublicInfo().pubkey_hex;

    return {
        ...certBody,
        proof: {
            type: 'Ed25519Signature2020',
            created: new Date().toISOString(),
            verificationMethod: `did:key:ed25519:${pubHex}#key-1`,
            proofPurpose: 'assertionMethod',
            algorithm: 'Ed25519',
            canonicalizationAlgorithm: 'urn:umbraxon:json-sorted-keys-v1',
            digestAlgorithm: 'SHA-256',
            signatureValue: signatureHex,
            signingRole: usedRole,
        },
    };
}

function _signCertMultiSig(certBody, digest, audit, opts) {
    const cfg = _multisigConfig();
    const roles    = Array.isArray(opts.roles)    && opts.roles.length    ? opts.roles    : cfg.roles;
    const optional = Array.isArray(opts.optional) && opts.optional.length ? opts.optional : cfg.optional;
    const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0
        ? opts.threshold : cfg.threshold;

    const r = hubkeys.signMultiSig({
        message: digest,
        roles, optional,
        audit: audit ? {
            purpose: audit.purpose || 'cert_issue', serial: audit.serial,
            kya_id: audit.kya_id, admin_user: audit.admin_user, client_ip: audit.client_ip,
        } : undefined,
    });

    if (r.count < threshold) {
        // Strong guarantee: never emit a cert with fewer signatures than threshold.
        const augmented = new Error(
            `multi-sig requires >= ${threshold} signatures, got ${r.count}; missing=[${r.missing.join(',')}]`
        );
        throw augmented;
    }

    const sigs = r.signatures.map((s) => ({
        role: s.role,
        verificationMethod: `did:key:ed25519:${s.pubHex}#key-${s.role.toLowerCase()}`,
        signatureValue: s.signature,
        signingKeyId: s.keyId,
    }));

    return {
        ...certBody,
        proof: {
            type: 'Ed25519MultiSignature2020',
            created: new Date().toISOString(),
            threshold,
            signatures: sigs,
            // For convenience: a flat list of vm URIs the relying party should pin.
            verificationMethods: sigs.map((s) => s.verificationMethod),
            proofPurpose: 'assertionMethod',
            algorithm: 'Ed25519',
            canonicalizationAlgorithm: 'urn:umbraxon:json-sorted-keys-v1',
            digestAlgorithm: 'SHA-256',
            missingRoles: r.missing, // for transparency; verifier ignores
        },
    };
}

/**
 * Overí podpis certifikátu (offline kryptografická kontrola).
 * Podporuje dva proof typy:
 *   - 'Ed25519Signature2020'       — legacy single-sig (BASIC alebo ELITE)
 *   - 'Ed25519MultiSignature2020'  — Phase 5b 2-of-3 multi-sig (BASIC+ELITE+ROOT)
 *
 * @returns {object} { valid, reason, issuerPubkey | issuerPubkeys, expired, multisig? }
 */
function verifyCertSignature(cert) {
    if (!cert || typeof cert !== 'object') {
        return { valid: false, reason: 'CERT_MALFORMED' };
    }
    if (!cert.proof) return { valid: false, reason: 'NO_PROOF' };

    // Rekonštruuj canonical body (bez proof) raz; obe vetvy ju potrebujú.
    const { proof, ...bodyOnly } = cert;
    const canonical = canonicalize(bodyOnly);
    const digest = crypto.createHash('sha256').update(canonical).digest();

    if (proof.algorithm && proof.algorithm !== 'Ed25519') {
        return { valid: false, reason: `UNSUPPORTED_ALG: ${proof.algorithm}` };
    }

    let expired = false;
    if (cert.expirationDate) {
        const exp = new Date(cert.expirationDate).getTime();
        if (Number.isFinite(exp) && exp < Date.now()) expired = true;
    }

    // ----- Multi-sig path ----------------------------------------------------
    if (proof.type === 'Ed25519MultiSignature2020') {
        if (!Array.isArray(proof.signatures) || proof.signatures.length === 0) {
            return { valid: false, reason: 'NO_SIGNATURES' };
        }
        const threshold = Number.isFinite(proof.threshold) && proof.threshold > 0
            ? proof.threshold : proof.signatures.length;

        // Extract pubHex from each sig's verificationMethod
        const sigsForVerify = [];
        for (const s of proof.signatures) {
            if (!s || typeof s !== 'object') {
                return { valid: false, reason: 'BAD_SIGNATURE_ENTRY' };
            }
            const m = (s.verificationMethod || '').match(/^did:key:ed25519:([0-9a-fA-F]{64})/);
            if (!m) return { valid: false, reason: 'INVALID_VERIFICATION_METHOD' };
            sigsForVerify.push({
                role: s.role || null,
                pubHex: m[1].toLowerCase(),
                signature: s.signatureValue || s.signature,
            });
        }
        const result = hubkeys.verifyMultiSig(digest, sigsForVerify, threshold);
        if (!result.valid) {
            return {
                valid: false,
                reason: result.validCount === 0
                    ? 'SIGNATURE_MISMATCH'
                    : 'THRESHOLD_NOT_MET',
                multisig: true,
                threshold: result.threshold,
                validCount: result.validCount,
                total: result.total,
                perSignature: result.perSignature,
                expired,
            };
        }
        const allPubs = sigsForVerify.map(s => s.pubHex);
        return {
            valid: true,
            reason: 'OK',
            multisig: true,
            // Backward-compat alias: callers that only read `issuerPubkey` get the
            // first one (typically BASIC); the canonical truth is `issuerPubkeys`.
            issuerPubkey: allPubs[0] || null,
            issuerPubkeys: allPubs,
            threshold: result.threshold,
            validCount: result.validCount,
            total: result.total,
            perSignature: result.perSignature,
            expired,
        };
    }

    // ----- Legacy single-sig path -------------------------------------------
    if (!proof.signatureValue) {
        return { valid: false, reason: 'NO_PROOF' };
    }

    const vm = proof.verificationMethod || '';
    const m = vm.match(/^did:key:ed25519:([0-9a-fA-F]{64})/);
    if (!m) return { valid: false, reason: 'INVALID_VERIFICATION_METHOD' };
    const issuerPubkey = m[1].toLowerCase();

    const sigOk = hubkeys.verify(digest, proof.signatureValue, issuerPubkey);
    if (!sigOk) {
        return { valid: false, reason: 'SIGNATURE_MISMATCH', issuerPubkey, expired };
    }

    return { valid: true, reason: 'OK', issuerPubkey, expired, multisig: false };
}

/**
 * Vytvorí serial number pre cert (CERT-<kya_id_short>-<inkrement>).
 */
function makeSerial(kya_id, version = 1) {
    const short = (kya_id || '').replace('UMBRA-', '').slice(0, 6);
    return `CERT-${short}-${String(version).padStart(3, '0')}`;
}

function proofTypeOf(cert) {
    return (cert && cert.proof && cert.proof.type) || null;
}

module.exports = {
    buildCertBody,
    signCert,
    verifyCertSignature,
    canonicalize,
    makeSerial,
    proofTypeOf,
    CONTEXT_URL,
    CERT_TYPE,
};
