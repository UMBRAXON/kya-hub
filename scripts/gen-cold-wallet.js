#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Cold Wallet Generator (Phase 2.5 payment setup)
// ============================================================================
// Generuje BIP-39 mnemonic + extrahuje BIP-84 (segwit) xpub pre cold storage.
//
// !!!  DÔLEŽITÉ BEZPEČNOSTNÉ UPOZORNENIE  !!!
//
// 1. TENTO SKRIPT BEŽÍ NA SERVERI. To znamená seed je generovaný ONLINE.
//    Pre malé sumy (do 100 EUR ekvivalent) je to OK; pre väčšie sumy
//    OBJEDNAJ HARDWARE WALLET (Coldcard / SeedSigner / Foundation Passport).
//
// 2. Po vygenerovaní:
//    a) SEED napíš na PAPIER / kovovú tabuľku, ulož mimo serveru.
//    b) ZAMAŽ ho zo servera: `shred -u /root/kya-hub/.cold-wallet-secret`
//    c) Iba XPUB ostáva v BTCPay — slúži na generovanie receive adries.
//
// 3. Bez seed-u nemôžeš podpísať payout. Strata = strata všetkých prijatých SAT.
//
// Use:
//   node scripts/gen-cold-wallet.js                 # interactive mode
//   node scripts/gen-cold-wallet.js --derive xpub   # iba derive xpub z exitujúceho seed
//   node scripts/gen-cold-wallet.js --info          # show derivation paths
// ============================================================================

const bip39 = require('bip39');
const BIP32Factory = require('bip32').default;
const ecc = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');
const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

const bip32 = BIP32Factory(ecc);
const NETWORK = bitcoin.networks.bitcoin;

// BIP-84 (native segwit, bech32 "bc1q...")
const ACCOUNT_PATH = "m/84'/0'/0'";
const FIRST_RECEIVE_PATH = "m/84'/0'/0'/0/0";

function generate() {
    const mnemonic = bip39.generateMnemonic(256); // 24 words, 256 bit entropy
    return mnemonic;
}

function deriveXpub(mnemonic, passphrase = '') {
    const seed = bip39.mnemonicToSeedSync(mnemonic, passphrase);
    const root = bip32.fromSeed(seed, NETWORK);
    const account = root.derivePath(ACCOUNT_PATH);
    // BIP-84: xpub musí byť ako "zpub" pre BTCPay (native segwit version bytes)
    const VERSION_ZPUB = Buffer.from([0x04, 0xb2, 0x47, 0x46]); // mainnet zpub
    const accountNeutered = account.neutered();
    // Convert xpub bytes to zpub
    let xpubBytes = bs58check_decode(accountNeutered.toBase58());
    const zpubBytes = Buffer.concat([VERSION_ZPUB, xpubBytes.slice(4)]);
    const zpub = bs58check_encode(zpubBytes);

    // First receive address (sanity check)
    const child = root.derivePath(FIRST_RECEIVE_PATH);
    const { address: firstAddr } = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(child.publicKey),
        network: NETWORK,
    });

    const fpRaw = root.fingerprint;
    const fingerprint = Buffer.isBuffer(fpRaw)
        ? fpRaw.toString('hex')
        : Buffer.from(fpRaw).toString('hex');
    return {
        xpub: accountNeutered.toBase58(),
        zpub,
        first_receive_address: firstAddr,
        derivation_path: ACCOUNT_PATH,
        format: 'BIP-84 native segwit (bech32, bc1q...)',
        fingerprint,
    };
}

// Minimal bs58check helpers (avoid extra dep) — bs58check@4 exposes API under `.default`
function _bs58check() {
    const mod = require('bs58check');
    return (mod && typeof mod.decode === 'function') ? mod : mod.default;
}
function bs58check_decode(str) {
    return _bs58check().decode(str);
}
function bs58check_encode(buf) {
    return _bs58check().encode(buf);
}

function printInfo() {
    console.log('\n📖 KYA-Hub Cold Wallet Generator — Info\n');
    console.log('Derivation:        BIP-84 (native segwit, bc1q...)');
    console.log('Account path:      ' + ACCOUNT_PATH);
    console.log('First receive:     ' + FIRST_RECEIVE_PATH);
    console.log('Wordlist:          BIP-39 english (24 words = 256-bit entropy)');
    console.log('Network:           Bitcoin mainnet');
    console.log('Compatible with:   BTCPay Server, Sparrow, Electrum, Specter,');
    console.log('                   Coldcard, Trezor, Ledger, BlueWallet, etc.\n');
}

async function ask(rl, q) {
    return new Promise(resolve => rl.question(q, a => resolve(a)));
}

async function interactive() {
    printInfo();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('🔐 Generujem 24-word BIP-39 mnemonic...\n');
    const mnemonic = generate();
    const words = mnemonic.split(' ');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SEED (24 words) — NAPÍŠ NA PAPIER OKAMŽITE !!!');
    console.log('═══════════════════════════════════════════════════════════');
    for (let i = 0; i < 24; i += 4) {
        const line = words.slice(i, i + 4)
            .map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(10)}`)
            .join('  ');
        console.log('  ' + line);
    }
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('⚠️  Tento seed ovláda CELÝ wallet. Strata = strata všetkých SAT.');
    console.log('⚠️  Nezdielaj, nefoto, nepošli e-mailom. Iba papier / kovová doska.\n');

    const ack = await ask(rl, '✅ Napísal si seed na papier? Naozaj? (napíš "ano"): ');
    if (ack.trim().toLowerCase() !== 'ano') {
        console.log('❌ Zrušené. Seed sa NEukladá nikde, je ZABUDNUTÝ. Bezpečné.');
        rl.close();
        return;
    }

    // Sanity check: opýtaj sa user-a na 3 random slová
    console.log('\n🔍 Verifikácia (zadaj slová ktoré si si zapísal):');
    const verifyIdx = [
        Math.floor(Math.random() * 24),
        Math.floor(Math.random() * 24),
        Math.floor(Math.random() * 24),
    ];
    for (const i of verifyIdx) {
        const word = await ask(rl, `   Slovo č. ${i + 1}: `);
        if (word.trim().toLowerCase() !== words[i]) {
            console.log(`❌ Nesprávne. Očakávané "${words[i]}". ZRUŠENÉ — zapíš seed znova!`);
            rl.close();
            return;
        }
    }

    console.log('\n✅ Verifikácia OK. Generujem xpub/zpub...\n');

    const { xpub, zpub, first_receive_address, fingerprint, derivation_path } = deriveXpub(mnemonic, '');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  PUBLIC DATA (môže byť na serveri)');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Fingerprint:           ' + fingerprint);
    console.log('Derivation path:       ' + derivation_path);
    console.log('Account xpub:          ' + xpub);
    console.log('Account zpub:          ' + zpub);
    console.log('First receive addr:    ' + first_receive_address);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Ulož len pub data
    const pubFile = '/root/kya-hub/.cold-wallet-public.json';
    fs.writeFileSync(pubFile, JSON.stringify({
        fingerprint, derivation_path, xpub, zpub, first_receive_address,
        format: 'BIP-84',
        created_at: new Date().toISOString(),
        note: 'PUBLIC ONLY. Seed je IBA NA PAPIERI. Sweep cez BTCPay payout.',
    }, null, 2));
    fs.chmodSync(pubFile, 0o644);
    console.log(`💾 Public data uložené: ${pubFile}\n`);

    console.log('📋 Ďalšie kroky:');
    console.log('   1. Pridaj zpub do BTCPay Server: Wallets → Receive → "Use existing wallet"');
    console.log('      → "Connect hardware wallet" → "Other" → paste zpub');
    console.log('   2. BTCPay vygeneruje receive adresy z tohto xpub.');
    console.log('   3. Sweep payout pôjde na adresy odvodené z xpub.');
    console.log('   4. Pre podpis transakcie (sweep) potrebuješ seed (24 words).');
    console.log('      → V budúcnosti: importuj seed do hardware walletu (Coldcard/Trezor).');
    console.log('      → Dovtedy: použij Sparrow/Specter na PSBT signing.\n');

    console.log('🔒 Bezpečnosť:');
    console.log('   - Seed NIE JE NIKDE na serveri (videl si ho len v konzole).');
    console.log('   - History terminálu vyčisti: `history -c && history -w`');
    console.log('   - Ak používaš tmux/screen, scrollback buffer vyčisti tiež.\n');

    rl.close();
}

async function deriveFromMnemonic(mnemonic) {
    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 24) {
        console.error(`❌ Očakávam 24 slov, dostal som ${words.length}. Zruším.`);
        process.exit(2);
    }
    if (!bip39.validateMnemonic(mnemonic.trim())) {
        console.error('❌ Mnemonic neprešla BIP-39 validáciou (zlé slovo alebo checksum). Skontroluj papier.');
        process.exit(3);
    }
    const result = deriveXpub(mnemonic.trim(), '');
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  PUBLIC DATA (ulož na server)');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Fingerprint:           ' + result.fingerprint);
    console.log('Derivation path:       ' + result.derivation_path);
    console.log('Account xpub:          ' + result.xpub);
    console.log('Account zpub:          ' + result.zpub);
    console.log('First receive addr:    ' + result.first_receive_address);
    console.log('═══════════════════════════════════════════════════════════\n');

    const pubFile = '/root/kya-hub/.cold-wallet-public.json';
    if (fs.existsSync(pubFile)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${pubFile}.backup.${ts}`;
        fs.copyFileSync(pubFile, backup);
        console.log(`ℹ️  Existujúci ${pubFile} zazálohovaný na ${backup}`);
    }
    fs.writeFileSync(pubFile, JSON.stringify({
        ...result,
        created_at: new Date().toISOString(),
        source: 'derive-from-existing-mnemonic',
        note: 'PUBLIC ONLY. Seed je IBA NA PAPIERI. Sweep cez BTCPay payout.',
    }, null, 2));
    fs.chmodSync(pubFile, 0o644);
    console.log(`💾 Public data uložené: ${pubFile}\n`);
    console.log('🔒 Tip: vyčisti terminál history: `history -c && history -w && clear`\n');
}

(async () => {
    const args = process.argv.slice(2);
    if (args.includes('--info')) { printInfo(); return; }
    if (args.includes('--derive')) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const m = await ask(rl, 'Mnemonic (24 words): ');
        rl.close();
        await deriveFromMnemonic(m.trim());
        return;
    }
    await interactive();
})();
