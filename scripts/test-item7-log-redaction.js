#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 7 smoke test
// ----------------------------------------------------------------------------
// Asserts that lib/logger.js redacts BOTH:
//   - named secret env paths via pino's built-in redact list
//   - long hex / base64 strings via the regex auto-redactor (formatter)
//
// Method: write log lines containing realistic secrets via a child node
// process, capture stdout/stderr, and grep the buffer for any leftover
// secret material.
//
// Policy (per audit Item 7): any >= 32-char hex or base64 string is masked
// unless it begins with one of the public-by-design prefixes (UMBRA-,
// KYAR, KYA1, did:, bc1, tb1, lnbc, http(s)://, mempool.space, blockstream.info).
// That means even public-but-long values like block hashes, txids, and
// pubkeys WILL be masked — that's intentional defence-in-depth.
// ============================================================================
const { spawnSync } = require('child_process');
const path = require('path');

const loggerPath = path.join(__dirname, '..', 'lib', 'logger');

const helperScript = `
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'debug';
const logger = require(${JSON.stringify(loggerPath)});

const secrets = {
    HUB_KEY_BASIC_PRIVKEY_CIPHERTEXT: 'GCM:f7e44ab5e21d0b3c8a1f6e3d2b78aaf0c0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7',
    HUB_KEY_PASSPHRASE: 'd9f8e7d6c5b4a3928271605143526374859607182939404a5b6c7d8e9f0a1b2c',
    BACKUP_PASSPHRASE:  '1c6d8e89c3bc549e9b78b52fb7b7eba4bf3106aa8ad960a4fe02bf64e9698594',
    B2_APP_KEY:         'K0001234567890abcdef0123456789ABCDEFXYZ123456789abcdef',
    mnemonic:           'abandon ability able about above absent absorb abstract absurd abuse access accident',
    seed:               '0a1b2c3d4e5f6789abcdef0a1b2c3d4e5f6789abcdef0a1b2c3d4e5f6789abcd',
    xprv:               'xprv9zV6Q3v0R3CCpmGE5GhpfXkEhT6t2yPxFShTb6Rk8m4HUEGqHJUbExoq8tFqyXuf2VkjLZX1FewLgmYJTLRwzqfQGyZqCkXvKZScW6Vd7BC',
    private_key:        'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
    privateKey:         'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
    unlockPassword:     'super-secret-alby-password-1234567890',
    ALBY_NWC_URI:       'nostr+walletconnect://abcdef0123456789ABCDEF0123456789?relay=wss://relay.getalby.com&secret=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
};
logger.info({ event: 'env_dump', ...secrets }, 'simulated env dump');
logger.error({ event: 'crash_dump', cfg: { HUB_KEY_PASSPHRASE: secrets.HUB_KEY_PASSPHRASE, BACKUP_PASSPHRASE: secrets.BACKUP_PASSPHRASE } }, 'fake crash');
logger.warn({ event: 'http_req', req: { headers: { authorization: 'Bearer ' + secrets.HUB_KEY_PASSPHRASE, 'x-admin-key': 'super-admin-key-1234567890abcdef' } } }, 'incoming request');
logger.info({ payload: { layer1: { layer2: { sneaky: secrets.HUB_KEY_BASIC_PRIVKEY_CIPHERTEXT } } } }, 'nested');

const publics = {
    kya_id: 'UMBRA-AB12CD',
    url: 'https://mempool.space/tx/abcdef',
    invoice: 'lnbc100u1pjsd5dpp5sgxhmu23ah9td9c9gn4vvzx8xyz0qxv4ftgvkmsfp9p9pqfp4q7sgzx7t8',
    op_return: 'KYAR' + 'a'.repeat(60),
    did:    'did:key:ed25519:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
};
logger.info({ event: 'public_dump', ...publics }, 'public values');
`;

const result = spawnSync('node', ['-e', helperScript], { encoding: 'utf-8', timeout: 5000 });
const combined = (result.stdout || '') + '\n' + (result.stderr || '');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else       { failed++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== child stdout sample (first 800 chars) ===');
console.log(combined.slice(0, 800));
console.log('...');

const mustNotAppear = {
    'HUB_KEY ciphertext':  'f7e44ab5e21d0b3c8a1f6e3d2b78aaf0c0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7',
    'HUB_KEY_PASSPHRASE':  'd9f8e7d6c5b4a3928271605143526374859607182939404a5b6c7d8e9f0a1b2c',
    'BACKUP_PASSPHRASE':   '1c6d8e89c3bc549e9b78b52fb7b7eba4bf3106aa8ad960a4fe02bf64e9698594',
    'B2_APP_KEY':          'K0001234567890abcdef0123456789ABCDEFXYZ123456789abcdef',
    'mnemonic phrase':     'abandon ability able about above absent absorb abstract',
    'xprv':                'xprv9zV6Q3v0R3CCpmGE5GhpfXkEhT6t2yPxFShTb6Rk8m4HUEGqHJUbExoq8tFqyXuf2VkjLZX1FewLgmYJTLRwzqfQGyZqCkXvKZScW6Vd7BC',
    'unlockPassword':      'super-secret-alby-password-1234567890',
    'nwc URI scheme body': 'abcdef0123456789ABCDEF0123456789?relay=wss',
    'admin key':           'super-admin-key-1234567890abcdef',
};
const mustAppear = {
    'kya_id':           'UMBRA-AB12CD',
    'url':              'https://mempool.space',
    'invoice prefix':   'lnbc100u1pjsd5dpp5',
    'KYAR magic':       'KYAR',
    'did:key prefix':   'did:key:ed25519:abcdef0123456789',
    'bc1 address':      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
};

console.log('=== 1) secrets must NOT appear in output ===');
for (const [name, secret] of Object.entries(mustNotAppear)) {
    assert(`${name} not leaked`, !combined.includes(secret));
}

console.log('=== 2) public-by-design values must STILL appear in output ===');
for (const [name, val] of Object.entries(mustAppear)) {
    assert(`${name} preserved`, combined.includes(val));
}

console.log('=== 3) Sensitive-named fields replaced wholesale ===');
assert('mnemonic field replaced with [REDACTED]',
    combined.includes('"mnemonic":"[REDACTED]"') || combined.includes('"mnemonic":"***REDACTED***"'));
assert('BACKUP_PASSPHRASE field replaced',
    combined.includes('"BACKUP_PASSPHRASE":"[REDACTED]"') || combined.includes('"BACKUP_PASSPHRASE":"***REDACTED***"'));
assert('HUB_KEY_PASSPHRASE field replaced',
    combined.includes('"HUB_KEY_PASSPHRASE":"[REDACTED]"') || combined.includes('"HUB_KEY_PASSPHRASE":"***REDACTED***"'));

console.log('=== 4) Auto-redactor masks hex/base64 strings >= 32 chars ===');
const logger = require('../lib/logger');
assert('64-hex random -> redact', logger._shouldRedact('a'.repeat(64)));
assert('64-hex block-hash-like -> redact (we cannot distinguish from secret)',
    logger._shouldRedact('000000000000000000010b573a159575e767c3ba6203edfddcb84512e4889a3b'));
assert('66-hex compressed pubkey -> redact (defence in depth)',
    logger._shouldRedact('03e566c98e7371d7a63a5b8d7d129c6afbfd09db0de63fcd483b7b0adf2b4e7b91'));
assert('GCM:hex envelope -> redact',
    logger._shouldRedact('GCM:f7e44ab5e21d0b3c8a1f6e3d2b78aaf0c0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7'));
assert('UMBRA- prefix exempt',
    !logger._shouldRedact('UMBRA-' + 'A'.repeat(64)));
assert('lnbc invoice exempt',
    !logger._shouldRedact('lnbc' + '0'.repeat(64)));
assert('did:key exempt',
    !logger._shouldRedact('did:key:ed25519:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'));
assert('https URL exempt',
    !logger._shouldRedact('https://example.com/' + 'a'.repeat(64)));
assert('KYAR magic exempt',
    !logger._shouldRedact('KYAR' + 'a'.repeat(60)));
assert('short string passes through',
    !logger._shouldRedact('abc'));
assert('17-char hex < min threshold passes through',
    !logger._shouldRedact('a'.repeat(17)));

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
if (result.error) {
    console.log('child error:', result.error.message);
}
process.exit(failed === 0 ? 0 : 1);
