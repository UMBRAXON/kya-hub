// ============================================================================
// UMBRAXON KYA-Hub — Centralised pino logger
// ----------------------------------------------------------------------------
// Two redaction layers, both required:
//
//   (1) Path-based redact list (pino built-in)
//       Removes named fields / nested fields from log objects regardless of
//       value. Catches the obvious cases when a developer logs the env or a
//       request header by name.
//
//   (2) Regex-based auto-redactor (Strategic Sprint §30 Item 7)
//       Walks the log object before serialisation and replaces ANY string
//       value (>= MIN_LEN chars) that matches the "looks like a secret"
//       pattern (hex / base64). This is a belt-and-braces last line of
//       defence against accidental secret leaks.
//
// Two policy goals:
//   - We MUST NOT leak: HUB key passphrase, HUB key ciphertext bodies,
//     BACKUP passphrase, B2 app keys, NWC connection URIs, BTCPay API keys,
//     webhook secrets, mnemonics / seeds / extended private keys.
//   - We MAY leak: pubkeys (intentionally public), payment hashes, txids,
//     hex hashes of known-length 64 chars, kya_id strings.
//
// To avoid false positives on the "may leak" set we shape the regex around
// strings that are >= 32 chars (so a 64-char sha256 hex still matches, but
// we never strip kya_id like "UMBRA-AB12CD").
// ============================================================================
const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');

const transport = isDev
    ? pino.transport({
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' }
      })
    : undefined;

// ---------------------------------------------------------------------------
// Path-based redact list
// ---------------------------------------------------------------------------
const REDACT_PATHS = [
    'req.headers.authorization',
    'req.headers["x-admin-key"]',
    'req.headers["btcpay-sig"]',
    'req.headers["nostr-signature"]',
    'password', 'secret', '*.password', '*.secret',
    // Phase 1–5 keys
    'ALBY_NWC_URI',
    'BTCPAY_API_KEY',
    'BTCPAY_WEBHOOK_SECRET',
    'HUB_SECRET',
    'DB_PASSWORD',
    'ADMIN_API_KEY',
    'KYAHUB_APP_PASSWORD',
    // Strategic Sprint §30 Item 7 — additional secret env names
    'HUB_KEY_PASSPHRASE',
    'HUB_KEY_BASIC_CIPHERTEXT',
    'HUB_KEY_ELITE_CIPHERTEXT',
    'HUB_KEY_ROOT_CIPHERTEXT',
    'HUB_KEY_BASIC_PRIVKEY_CIPHERTEXT',
    'HUB_KEY_ELITE_PRIVKEY_CIPHERTEXT',
    'HUB_KEY_ROOT_PRIVKEY_CIPHERTEXT',
    'HUB_KEY_BASIC_PRIVKEY',
    'HUB_KEY_ELITE_PRIVKEY',
    'HUB_KEY_ROOT_PRIVKEY',
    'BACKUP_PASSPHRASE',
    'B2_APP_KEY',
    'B2_KEY_ID',
    // S3-compatible off-site backup (Cloudflare R2 / AWS S3 / MinIO / DO Spaces / ...)
    'BACKUP_S3_ACCESS_KEY_ID',
    'BACKUP_S3_SECRET_ACCESS_KEY',
    // Alby Hub HTTP-API unlock password (liquidity monitor + admin tooling)
    'ALBY_UNLOCK_PASSWORD',
    'LNBITS_INVOICE_READ_KEY',
    'ALBY_WEBHOOK_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'DISCORD_WEBHOOK_URL',
    'mnemonic',
    'seed',
    'xprv',
    'tprv',
    // common nested shapes
    '*.mnemonic',
    '*.seed',
    '*.xprv',
    '*.tprv',
    '*.private_key',
    '*.privkey',
    '*.privateKey',
    '*.unlock_password',
    '*.unlockPassword',
];

// ---------------------------------------------------------------------------
// Regex auto-redactor — Strategic Sprint §30 Item 7
// ---------------------------------------------------------------------------
const MIN_AUTO_REDACT_LEN = parseInt(process.env.LOG_REDACT_MIN_LEN || '32', 10);

// Strings that LOOK like secrets:
//   - >= MIN_AUTO_REDACT_LEN chars
//   - composed of "[0-9a-fA-F]+" (hex)              OR
//   - composed of "[A-Za-z0-9+/=_-]+" (base64 / base64url) OR
//   - GCM:hex  /  AES:hex  / pbkdf2$… style envelope ciphertexts
// We DO allow shorter strings (kya_id, txids in human-readable contexts)
// to pass through.
const HEX_RE     = new RegExp('^[0-9a-fA-F]{' + MIN_AUTO_REDACT_LEN + ',}$');
const B64_RE     = new RegExp('^[A-Za-z0-9+/=_-]{' + MIN_AUTO_REDACT_LEN + ',}$');
const ENVELOPE_RE = /^(GCM|AES|CBC|ENC|pbkdf2|argon2|scrypt):/i;

// Allow-list — these we explicitly DO want to keep (they're public-by-design):
// All begin with a small structured prefix.
const ALLOW_PREFIXES = [
    'UMBRA-',                 // kya_id
    'KYAR',                   // KYAR magic for OP_RETURN
    'KYA1',                   // KYA1 magic for OP_RETURN
    'did:',                   // DIDs are public verifier identifiers
    'bc1', 'tb1',             // bech32 addresses (public)
    'lnbc',                   // BOLT11 invoices (public)
    'http://', 'https://',    // URLs (we still want to see them in logs)
    'mempool.space', 'blockstream.info',
];

function _shouldRedact(s) {
    if (typeof s !== 'string') return false;
    if (s.length < MIN_AUTO_REDACT_LEN) return false;
    // Always mask envelope ciphertexts regardless of allow prefixes.
    if (ENVELOPE_RE.test(s)) return true;
    for (const p of ALLOW_PREFIXES) if (s.startsWith(p)) return false;
    if (HEX_RE.test(s)) return true;
    if (B64_RE.test(s)) return true;
    return false;
}

// Field-name patterns that should always be redacted regardless of value
// (because the value can be arbitrarily formatted, e.g. URLs containing
// passwords). Tested case-insensitively.
const SECRET_NAME_RE = /(passphrase|privkey|private_key|privateKey|^seed$|mnemonic|xprv|tprv|unlock_password|unlockPassword|alby_unlock_password|api_key|apikey|secret|webhook_secret|admin_key|nwc_uri|telegram_bot_token|b2_app_key|backup_passphrase|backup_s3_secret_access_key|backup_s3_access_key_id|hub_key_.*_ciphertext|hub_key_.*_privkey)/i;

const REDACTED = '***REDACTED***';
const MAX_DEPTH = parseInt(process.env.LOG_REDACT_MAX_DEPTH || '8', 10);

function _autoRedactDeep(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') {
        return _shouldRedact(value) ? REDACTED : value;
    }
    if (depth >= MAX_DEPTH) return value;
    if (Array.isArray(value)) {
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = _autoRedactDeep(value[i], depth + 1);
        return out;
    }
    if (typeof value === 'object') {
        // Preserve Buffers / Errors / pino-special shapes
        if (Buffer.isBuffer(value) || value instanceof Error) return value;
        const out = {};
        for (const k of Object.keys(value)) {
            // For the request headers cookie / authorization payload, redact
            // wholesale regardless of length (already covered by REDACT_PATHS
            // but defensive).
            if (/cookie|authorization|x-admin-key|nostr-signature|btcpay-sig|alby-signature|x-alby-signature/i.test(k)) {
                out[k] = REDACTED;
            } else if (typeof value[k] === 'string' && SECRET_NAME_RE.test(k)) {
                // Field name itself looks like a secret holder — always mask.
                out[k] = REDACTED;
            } else {
                out[k] = _autoRedactDeep(value[k], depth + 1);
            }
        }
        return out;
    }
    return value;
}

// formatters.log runs on every log object before serialisation
const logger = pino(
    {
        level: logLevel,
        base: { service: 'kya-hub' },
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: {
            paths: REDACT_PATHS,
            censor: '[REDACTED]'
        },
        formatters: {
            log(obj) {
                try { return _autoRedactDeep(obj); }
                catch (_) { return obj; }
            },
        },
    },
    transport
);

// Exported helpers (used by the smoke test).
logger._autoRedactDeep = _autoRedactDeep;
logger._shouldRedact   = _shouldRedact;
logger._REDACT_PATHS   = REDACT_PATHS;
logger._REDACTED       = REDACTED;
logger._ALLOW_PREFIXES = ALLOW_PREFIXES;
logger._MIN_AUTO_REDACT_LEN = MIN_AUTO_REDACT_LEN;

module.exports = logger;
