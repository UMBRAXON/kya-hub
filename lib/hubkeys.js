// ============================================================================
// UMBRAXON KYA-Hub — Hub Ed25519 Identity (refactored Phase 2.3)
// ============================================================================
// Tenký wrapper nad lib/hub-key-store.js.
// 
//   - sign(msg, opts?)         : podpíše msg BASIC kľúčom (default), volá audit
//   - signWithRole(role, msg)  : podpíše konkrétnym role kľúčom (BASIC/ELITE/ROOT)
//   - verify(msg, sig, pubHex) : overí cudzieho podpisovateľa (Ed25519)
//   - getPublicInfo()          : verejné info pre /api/hub/pubkey endpoint
//   - getHubKeys()             : legacy: vráti BASIC priv/pub/pubHex
//
// Backward compat: existujúce volania sign() bez parametra ostávajú funkčné
// (default BASIC). Cert signing log je opt-in cez opts.audit (volá ho certs.js).
// ============================================================================
const crypto = require('crypto');
const store = require('./hub-key-store');

// Lazy pool reference pre audit log. Server nastaví cez setAuditPool() pri starte.
let _auditPool = null;
let _auditLogger = null;

function setAuditPool(pool, logger) {
    _auditPool = pool;
    _auditLogger = logger || null;
}

/**
 * Podpíše message. Volania bez opts používajú BASIC kľúč (legacy default).
 * @param {Buffer|string} message
 * @param {object} [opts]
 *   - role: 'BASIC' | 'ELITE' | 'ROOT' (default BASIC)
 *   - audit: { purpose, serial, kya_id, admin_user, client_ip } — ak prítomné, zapíše do cert_signing_log
 * @returns {string} hex signature (128 znakov)
 */
function sign(message, opts = {}) {
    const role = opts.role || 'BASIC';
    const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const result = store.signWithRole(role, msg);
    
    // Audit best-effort, never blocks the sign
    if (opts.audit && _auditPool) {
        const messageHash = crypto.createHash('sha256').update(msg).digest('hex');
        _auditPool.query(
            `INSERT INTO cert_signing_log (
                serial, kya_id, key_id, role, signing_purpose, message_hash, signature_prefix,
                requested_by_admin, requested_by_ip
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                opts.audit.serial || null,
                opts.audit.kya_id || null,
                result.keyId,
                result.role,
                opts.audit.purpose || 'misc_sign',
                messageHash,
                result.signature.slice(0, 16),
                opts.audit.admin_user || null,
                opts.audit.client_ip || null,
            ]
        ).catch(err => {
            if (_auditLogger) _auditLogger.error({ err: err.message }, 'cert_signing_log audit FAIL');
        });
    }
    
    return result.signature;
}

/**
 * Podpíše konkrétnou rolou (explicit). Vráti len signature hex.
 */
function signWithRole(role, message, opts = {}) {
    return sign(message, { ...opts, role });
}

/**
 * Podpíše message viacerými rolami (Phase 5b multi-sig). Návrat je pole signatúr
 * v rovnakom poradí ako `roles`. Jednu (alebo viac) ROL možno označiť ako
 * voliteľnú cez `optional: ['ROOT']` — chýbajúci voliteľný kľúč nezhodí volanie,
 * ale výsledná `count` bude < požadovaný počet.
 *
 * @param {object} opts
 *   - message: Buffer | string (raw bytes podpisované Ed25519-om)
 *   - roles: string[]            — napr. ['BASIC', 'ELITE'] alebo ['BASIC','ELITE','ROOT']
 *   - optional: string[]         — voliteľné role; ak chýba kľúč, sa preskočí (default [])
 *   - audit: { ... }             — audit log payload (rovnaký schéma ako sign())
 *
 * @returns {object}
 *   - signatures: Array<{ role, keyId, pubHex, signature }>   v poradí roles
 *   - missing:    string[]                                    voliteľné roly bez kľúča
 *   - count:      number                                      počet úspešných signatúr
 */
function signMultiSig({ message, roles, optional = [], audit } = {}) {
    if (!Array.isArray(roles) || roles.length === 0) {
        throw new Error('signMultiSig: roles must be a non-empty array');
    }
    const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const optionalSet = new Set(optional);
    const signatures = [];
    const missing = [];

    for (const role of roles) {
        try {
            const result = store.signWithRole(role, msg);
            // Audit per-role (best-effort).
            if (audit && _auditPool) {
                const messageHash = crypto.createHash('sha256').update(msg).digest('hex');
                _auditPool.query(
                    `INSERT INTO cert_signing_log (
                        serial, kya_id, key_id, role, signing_purpose, message_hash,
                        signature_prefix, requested_by_admin, requested_by_ip
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [
                        audit.serial || null,
                        audit.kya_id || null,
                        result.keyId,
                        result.role,
                        audit.purpose ? `${audit.purpose}_multisig` : 'misc_sign_multisig',
                        messageHash,
                        result.signature.slice(0, 16),
                        audit.admin_user || null,
                        audit.client_ip || null,
                    ]
                ).catch(err => {
                    if (_auditLogger) _auditLogger.error({ err: err.message, role },
                        'cert_signing_log multisig audit FAIL');
                });
            }
            signatures.push({
                role: result.role,
                keyId: result.keyId,
                pubHex: result.pubHex,
                signature: result.signature,
            });
        } catch (e) {
            if (optionalSet.has(role)) {
                missing.push(role);
                continue;
            }
            // Mandatory role missing → hard fail with descriptive message.
            const augmented = new Error(
                `signMultiSig: required role '${role}' unavailable: ${e.message}`
            );
            augmented.cause = e;
            throw augmented;
        }
    }
    return { signatures, missing, count: signatures.length };
}

/**
 * Overí multi-sig podpis voči poľu `signatures` (viz formát z signMultiSig).
 * Akceptuje threshold — koľko z poskytnutých signatúr musí prejsť, aby cert
 * bol platný. Defaultný threshold = signatures.length (všetky musia prejsť).
 *
 * @param {Buffer|string} message
 * @param {Array<{ role, pubHex, signature }>} signatures
 * @param {number} [threshold=signatures.length]
 * @returns {object} { valid, validCount, total, threshold, perSignature: [...] }
 */
function verifyMultiSig(message, signatures, threshold) {
    const sigs = Array.isArray(signatures) ? signatures : [];
    const need = (typeof threshold === 'number') ? threshold : sigs.length;
    const perSignature = sigs.map((s) => {
        const ok = (s && s.pubHex && s.signature)
            ? store.verifyWithPubkey(s.pubHex, message, s.signature)
            : false;
        return {
            role: s ? s.role : null,
            pubHex: s ? s.pubHex : null,
            valid: !!ok,
        };
    });
    const validCount = perSignature.reduce((n, p) => n + (p.valid ? 1 : 0), 0);
    return {
        valid: validCount >= need,
        validCount,
        total: sigs.length,
        threshold: need,
        perSignature,
    };
}

/**
 * Overí Ed25519 podpis cudzieho pubkey-u.
 * @param {Buffer|string} message - originálne bajty
 * @param {string} signatureHex
 * @param {string} pubkeyHex - 32B raw hex
 * @returns {boolean}
 */
function verify(message, signatureHex, pubkeyHex) {
    if (!signatureHex || !pubkeyHex) return false;
    return store.verifyWithPubkey(pubkeyHex, message, signatureHex);
}

/**
 * Vráti BASIC keys (legacy default pre starší kód).
 */
function getHubKeys() {
    const k = store.loadKey('BASIC');
    return { priv: k.priv, pub: k.pub, pubHex: k.pubHex };
}

/**
 * Vráti public info pre /api/hub/pubkey endpoint.
 * Zobrazuje BASIC pubkey + zoznam všetkých rol ak sú nakonfigurované.
 */
function getPublicInfo() {
    const basic = store.loadKey('BASIC');
    const all = store.listLoaded();
    return {
        algorithm: 'Ed25519',
        pubkey_hex: basic.pubHex,         // BASIC = primary key (backward compat field name)
        primary_key_id: basic.keyId,
        format: 'raw-32B-hex',
        signature_length_bytes: 64,
        hub_name: process.env.HUB_NAME || 'Umbraxon KYA-Hub',
        hub_url: process.env.HUB_URL || null,
        rfc: '8032 (EdDSA / Ed25519)',
        keys: all.map(k => ({ key_id: k.keyId, role: k.role, pubkey_hex: k.pubHex, source: k.source })),
    };
}

/**
 * Vráti pubkey pre konkrétnu rolu (alebo null ak nie je nakonfigurovaná).
 */
function getPubkeyForRole(role) {
    try {
        return store.loadKey(role).pubHex;
    } catch (_) {
        return null;
    }
}

// Re-export pre testy
const { rawPrivToKeyObject, rawPubToKeyObject } = store;

module.exports = {
    sign,
    signWithRole,
    signMultiSig,
    verify,
    verifyMultiSig,
    getPublicInfo,
    getHubKeys,
    getPubkeyForRole,
    setAuditPool,
    rawPrivToKeyObject,
    rawPubToKeyObject,
    // Expose store pre admin endpointy
    store,
};
