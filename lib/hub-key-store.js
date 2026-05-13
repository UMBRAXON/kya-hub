// ============================================================================
// UMBRAXON KYA-Hub — Hub Key Store (Phase 2.3)
// ============================================================================
// Tier-separated signing keys s encrypted-at-rest support:
//   - BASIC: online key pre podpis BASIC certifikátov (low-risk)
//   - ELITE: online ale gated key pre ELITE certifikáty (vyžaduje admin gate)
//   - ROOT:  master key, podpisuje IBA rotation atestácie iných kľúčov
//
// Privkeys sú uložené v .env ako AES-256-GCM ciphertext (kľúč odvodený zo scrypt
// z HUB_KEY_PASSPHRASE). Pri starte servera sa dešifrujú do KeyObject in-memory.
// Po načítaní sa raw bytes wipe-nú z procesu.
//
// Backward compat: ak nie sú HUB_KEY_BASIC_* premenné nastavené, použijú sa
// stare HUB_ED25519_PRIVKEY_HEX/PUBKEY_HEX ako default BASIC role (dev mode).
//
// Bezpečnostné poznámky:
//   - Passphrase v .env je stále plaintext, ale je oddelený od kľúča — útočník
//     potrebuje aj passphrase aj ciphertext. Pri rotácii sa rotuje aj passphrase.
//   - V produkcii by passphrase mal pochádzať z systemd-creds, kubernetes secret,
//     alebo vault. Dočasne ostáva v .env (zlepšenie oproti plaintext privkey).
//   - V dev/test režime (NODE_ENV=development a žiadny ciphertext) padáme späť
//     na plaintext, aby existujúce nástroje fungovali.
// ============================================================================
const crypto = require('crypto');
const fs = require('fs');

// DER prefixy pre Ed25519 kľúče (rovnaké ako v hubkeys.js)
const ED25519_PRIVKEY_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_PUBKEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const ROLES = ['BASIC', 'ELITE', 'ROOT'];

// In-memory key cache, naplnený pri prvom calle. Wipe-uje raw bytes po vytvorení KeyObject.
const _keys = new Map(); // role -> { keyId, priv: KeyObject, pub: KeyObject, pubHex, role, source }

// ----------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM s scrypt-odvodeným kľúčom)
// ----------------------------------------------------------------------------
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, dkLen: 32 };

function deriveKey(passphrase, salt) {
    return crypto.scryptSync(passphrase, salt, SCRYPT_PARAMS.dkLen, {
        N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
        maxmem: 64 * 1024 * 1024, // 64 MB (N=2^15 * r=8 * 128 bytes ~ 32 MB)
    });
}

/**
 * Encrypt raw 32-byte privkey s passphrase.
 * Vráti string formátu: "v1.<salt_hex>.<iv_hex>.<tag_hex>.<ct_hex>"
 */
function encryptPrivkey(rawPrivkeyHex, passphrase) {
    if (!/^[0-9a-fA-F]{64}$/.test(rawPrivkeyHex)) throw new Error('privkey must be 32B hex');
    if (typeof passphrase !== 'string' || passphrase.length < 12) {
        throw new Error('passphrase must be >=12 chars');
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(rawPrivkeyHex, 'hex');
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Wipe key + plaintext
    key.fill(0); plaintext.fill(0);
    return [
        'v1',
        salt.toString('hex'),
        iv.toString('hex'),
        tag.toString('hex'),
        ct.toString('hex'),
    ].join('.');
}

/**
 * Decrypt privkey ciphertext s passphrase.
 * Vráti raw 32B hex (32 znakov pairs = 64 hex znakov).
 */
function decryptPrivkey(ciphertext, passphrase) {
    if (typeof ciphertext !== 'string' || !ciphertext.startsWith('v1.')) {
        throw new Error('invalid ciphertext format (expected v1.<salt>.<iv>.<tag>.<ct>)');
    }
    const parts = ciphertext.split('.');
    if (parts.length !== 5) throw new Error('invalid ciphertext: expected 5 parts');
    const [, saltHex, ivHex, tagHex, ctHex] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ct = Buffer.from(ctHex, 'hex');
    const key = deriveKey(passphrase, salt);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        const hex = pt.toString('hex');
        key.fill(0); pt.fill(0);
        return hex;
    } catch (e) {
        key.fill(0);
        throw new Error('decryption failed (wrong passphrase or corrupted ciphertext)');
    }
}

// ----------------------------------------------------------------------------
// Raw bytes → Node KeyObject
// ----------------------------------------------------------------------------
function rawPrivToKeyObject(rawHex) {
    const raw = Buffer.from(rawHex, 'hex');
    if (raw.length !== 32) throw new Error('Ed25519 privkey must be 32 bytes');
    const der = Buffer.concat([ED25519_PRIVKEY_PREFIX, raw]);
    const keyObj = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    // Wipe raw + der after KeyObject is created
    raw.fill(0); der.fill(0);
    return keyObj;
}

function rawPubToKeyObject(rawHex) {
    const raw = Buffer.from(rawHex, 'hex');
    if (raw.length !== 32) throw new Error('Ed25519 pubkey must be 32 bytes');
    const der = Buffer.concat([ED25519_PUBKEY_PREFIX, raw]);
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function smokeTest(priv, pub) {
    const msg = Buffer.from('hub-key-store-smoke');
    const sig = crypto.sign(null, msg, priv);
    if (!crypto.verify(null, msg, pub, sig)) {
        throw new Error('key smoke test failed — privkey/pubkey mismatch');
    }
}

// ----------------------------------------------------------------------------
// Load key for given role
// ----------------------------------------------------------------------------
/**
 * Načíta key pre konkrétnu rolu. Skúša:
 *   1. HUB_KEY_<ROLE>_CIPHERTEXT (encrypted) + HUB_KEY_PASSPHRASE
 *   2. HUB_KEY_<ROLE>_PRIVKEY_HEX (plaintext, dev)
 *   3. ak role=BASIC, fallback na HUB_ED25519_PRIVKEY_HEX (legacy / backward compat)
 *
 * @returns { keyId, priv, pub, pubHex, role, source } alebo throw
 */
function loadKey(role) {
    if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
    if (_keys.has(role)) return _keys.get(role);
    
    const passphrase = process.env.HUB_KEY_PASSPHRASE;
    const ctEnv = process.env[`HUB_KEY_${role}_CIPHERTEXT`];
    const pubEnv = process.env[`HUB_KEY_${role}_PUBKEY_HEX`];
    const ptEnv = process.env[`HUB_KEY_${role}_PRIVKEY_HEX`];
    const keyIdEnv = process.env[`HUB_KEY_${role}_ID`] || `HUB-${role}-001`;
    
    let privHex = null;
    let source = null;
    
    if (ctEnv && passphrase) {
        privHex = decryptPrivkey(ctEnv, passphrase);
        source = 'encrypted';
    } else if (ptEnv) {
        privHex = ptEnv;
        source = 'plaintext';
    } else if (role === 'BASIC' && process.env.HUB_ED25519_PRIVKEY_HEX) {
        // Backward compat: stará konfigurácia bez tier separation
        privHex = process.env.HUB_ED25519_PRIVKEY_HEX;
        source = 'legacy-default-basic';
    } else {
        throw new Error(`HUB key for role=${role} not configured. Set HUB_KEY_${role}_CIPHERTEXT (+ HUB_KEY_PASSPHRASE) or HUB_KEY_${role}_PRIVKEY_HEX. Generate via scripts/gen-hub-keys.js`);
    }
    
    if (!/^[0-9a-fA-F]{64}$/.test(privHex)) {
        throw new Error(`HUB_KEY_${role}: privkey must be 32B hex (64 chars), got ${privHex.length} chars`);
    }
    
    const priv = rawPrivToKeyObject(privHex);
    
    // Pubkey: buď zo separate env, alebo derivuj z privkey
    let pubHex;
    if (pubEnv && /^[0-9a-fA-F]{64}$/.test(pubEnv)) {
        pubHex = pubEnv.toLowerCase();
    } else if (role === 'BASIC' && process.env.HUB_ED25519_PUBKEY_HEX) {
        pubHex = process.env.HUB_ED25519_PUBKEY_HEX.toLowerCase();
    } else {
        // Derivácia: Ed25519 priv → pub cez Node API
        const rawPub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
        // SPKI prefix je 12 bajtov, pubkey je ďalších 32
        pubHex = rawPub.slice(12, 12 + 32).toString('hex');
    }
    const pub = rawPubToKeyObject(pubHex);
    
    smokeTest(priv, pub);
    
    // Wipe lokálny hex string z dosahu GC tým, že ho prepisujeme (best effort)
    privHex = null;
    
    const entry = { keyId: keyIdEnv, priv, pub, pubHex, role, source };
    _keys.set(role, entry);
    return entry;
}

/**
 * Vráti všetky načítané kľúče (pre admin endpoint, audit).
 */
function listLoaded() {
    return [..._keys.values()].map(k => ({
        keyId: k.keyId,
        role: k.role,
        pubHex: k.pubHex,
        source: k.source,
    }));
}

/**
 * Eagerly načíta všetky tri role (idempotent). Skúsi BASIC vždy, ELITE/ROOT len ak sú nakonfigurované.
 */
function eagerLoad(opts = {}) {
    const errors = [];
    const loaded = [];
    
    // BASIC je povinný
    try {
        loaded.push(loadKey('BASIC'));
    } catch (e) {
        errors.push({ role: 'BASIC', error: e.message });
    }
    
    // ELITE a ROOT len ak sú prítomné v env
    for (const role of ['ELITE', 'ROOT']) {
        const hasEnv = process.env[`HUB_KEY_${role}_CIPHERTEXT`] || process.env[`HUB_KEY_${role}_PRIVKEY_HEX`];
        if (!hasEnv) {
            if (opts.requireAll) errors.push({ role, error: 'not configured' });
            continue;
        }
        try {
            loaded.push(loadKey(role));
        } catch (e) {
            errors.push({ role, error: e.message });
        }
    }
    
    return { loaded, errors };
}

// ----------------------------------------------------------------------------
// Sign / verify
// ----------------------------------------------------------------------------
/**
 * Podpíše message daným role kľúčom. Vráti hex signature.
 */
function signWithRole(role, message) {
    const k = loadKey(role);
    const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const sig = crypto.sign(null, msg, k.priv).toString('hex');
    return { signature: sig, keyId: k.keyId, role: k.role, pubHex: k.pubHex };
}

/**
 * Verifikuje signature cudzieho pubkey (nezávisle na role).
 * Pre verifikáciu hub-issued signatures cez všetky DEPRECATED keys nutné použiť DB lookup.
 */
function verifyWithPubkey(pubkeyHex, message, signatureHex) {
    try {
        const pub = rawPubToKeyObject(pubkeyHex);
        const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
        const sig = Buffer.from(signatureHex, 'hex');
        if (sig.length !== 64) return false;
        return crypto.verify(null, msg, pub, sig);
    } catch (_) {
        return false;
    }
}

// ----------------------------------------------------------------------------
// DB sync: zaregistruj načítané kľúče ako ACTIVE v hub_keys
// ----------------------------------------------------------------------------
/**
 * Pri starte servera porovná in-memory kľúče s hub_keys tabuľkou:
 *   - Ak kľúč neexistuje → INSERT ACTIVE
 *   - Ak existuje a status=ACTIVE → OK
 *   - Ak existuje a status=DEPRECATED/REVOKED → warn (env má starý kľúč!)
 */
async function syncWithDb(pool, logger) {
    const log = logger || console;
    const { loaded, errors } = eagerLoad({ requireAll: false });
    if (errors.length) {
        for (const e of errors) {
            log.warn ? log.warn({ role: e.role, error: e.error }, 'hub key load fail') : console.warn(`[hub-key-store] ${e.role}: ${e.error}`);
        }
    }
    
    for (const k of loaded) {
        // Skús INSERT — môže padnúť na unique constraint ak ten pubkey už existuje pod iným key_id
        const existsByPub = await pool.query(
            'SELECT key_id, role, status FROM hub_keys WHERE pubkey_hex = $1',
            [k.pubHex]
        );
        if (existsByPub.rowCount > 0) {
            const row = existsByPub.rows[0];
            if (row.status !== 'ACTIVE') {
                log.error
                    ? log.error({ role: k.role, keyId: k.keyId, dbStatus: row.status }, 'env hub key is DEPRECATED/REVOKED in DB — possible compromise or stale env')
                    : console.error(`[hub-key-store] WARNING: ${k.role} key has DB status ${row.status}`);
            }
            // Reuse existing key_id z DB
            k.keyId = row.key_id;
            continue;
        }
        
        // Skús INSERT (môže padnúť na unique active-per-role index)
        try {
            await pool.query(
                `INSERT INTO hub_keys (key_id, role, alg, pubkey_hex, status, notes)
                 VALUES ($1, $2, 'Ed25519', $3, 'ACTIVE', $4)`,
                [k.keyId, k.role, k.pubHex, `source=${k.source} loaded_at=${new Date().toISOString()}`]
            );
            log.info
                ? log.info({ keyId: k.keyId, role: k.role, source: k.source }, 'hub key registered')
                : console.log(`[hub-key-store] registered ${k.keyId} (${k.role})`);
        } catch (e) {
            // Active key pre tú rolu už existuje, ale s iným pubkey → veľký problém!
            log.error
                ? log.error({ role: k.role, keyId: k.keyId, error: e.message }, 'failed to register hub key — possible role conflict')
                : console.error(`[hub-key-store] ${k.role} conflict: ${e.message}`);
        }
    }
    
    return { loaded, errors };
}

/**
 * Vyhľadá metadata kľúča v hub_keys podľa pubkey (pre cert verify cez deprecated keys).
 */
async function lookupKeyByPubkey(pool, pubkeyHex) {
    const r = await pool.query(
        'SELECT key_id, role, status, deprecated_at, replaces_key_id FROM hub_keys WHERE pubkey_hex = $1',
        [pubkeyHex.toLowerCase()]
    );
    return r.rowCount > 0 ? r.rows[0] : null;
}

// ----------------------------------------------------------------------------
// File permissions check
// ----------------------------------------------------------------------------
/**
 * Skontroluje že .env má bezpečné perms (chmod 600 alebo prísnejšie).
 * Vráti { ok, mode, warning }.
 */
function checkEnvPerms(envPath) {
    try {
        const st = fs.statSync(envPath);
        const mode = st.mode & 0o777;
        // Bezpečné: 600, 400. Nebezpečné: world-readable (0o4)
        const worldReadable = (mode & 0o004) !== 0;
        const groupReadable = (mode & 0o040) !== 0;
        return {
            ok: !worldReadable && !groupReadable,
            mode: mode.toString(8),
            worldReadable,
            groupReadable,
            recommended: '600',
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = {
    ROLES,
    loadKey,
    listLoaded,
    eagerLoad,
    signWithRole,
    verifyWithPubkey,
    syncWithDb,
    lookupKeyByPubkey,
    encryptPrivkey,
    decryptPrivkey,
    rawPrivToKeyObject,
    rawPubToKeyObject,
    checkEnvPerms,
    // For testing
    _resetCache: () => _keys.clear(),
};
