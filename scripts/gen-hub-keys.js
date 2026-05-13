#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Hub Key Generator (Phase 2.3)
// ============================================================================
// Usage:
//   node scripts/gen-hub-keys.js                       # interactive: vygeneruje BASIC + ELITE + ROOT
//   node scripts/gen-hub-keys.js --role BASIC          # iba jednu rolu
//   node scripts/gen-hub-keys.js --role BASIC --passphrase mypass # neinteraktívne
//   node scripts/gen-hub-keys.js --plaintext           # bez encryption (dev mode)
//   node scripts/gen-hub-keys.js --dry-run             # iba zobraz, nezapisuj do .env
//
// Vygeneruje Ed25519 key páry pre tier-separated roles a uloží encrypted privkey
// + plaintext pubkey do .env. Passphrase si neuloží — musíš ju vložiť do .env
// alebo systemd-creds manuálne ako HUB_KEY_PASSPHRASE.
//
// Ak existujúce HUB_KEY_<ROLE>_* premenné existujú v .env, varuje pred prepisom.
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const store = require('../lib/hub-key-store');

const ENV_PATH = path.join(__dirname, '..', '.env');

const args = parseArgs(process.argv.slice(2));

function parseArgs(arr) {
    const out = { roles: [], plaintext: false, dry: false, passphrase: null, yes: false };
    for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (a === '--role') out.roles.push(arr[++i].toUpperCase());
        else if (a === '--plaintext') out.plaintext = true;
        else if (a === '--dry-run' || a === '--dry') out.dry = true;
        else if (a === '--yes' || a === '-y') out.yes = true;
        else if (a === '--passphrase') out.passphrase = arr[++i];
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    }
    if (out.roles.length === 0) out.roles = ['BASIC', 'ELITE', 'ROOT'];
    for (const r of out.roles) if (!['BASIC', 'ELITE', 'ROOT'].includes(r)) throw new Error(`Invalid role: ${r}`);
    return out;
}

function printHelp() {
    console.log(`
Usage: node scripts/gen-hub-keys.js [options]

Options:
  --role BASIC|ELITE|ROOT   Iba pre uvedenú rolu (default: všetky tri)
  --passphrase <str>        Nepýtať sa interaktívne (CI/scripted use)
  --plaintext               Bez encryption (dev only — nepoužívaj v prod!)
  --dry-run                 Iba zobraz výstup, nezapisuj
  --yes / -y                Auto-confirm overwriting existing keys
  --help                    Toto

Príklad:
  node scripts/gen-hub-keys.js --role BASIC --passphrase 'long-secret-here'
  node scripts/gen-hub-keys.js --plaintext --role ELITE --yes
`);
}

function ask(prompt, hidden = false) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        if (hidden) {
            const stdin = process.openStdin();
            process.stdin.on('data', () => {});
            // Best-effort hidden input (terminál podpora variabilná)
        }
        rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); });
    });
}

async function getPassphrase() {
    if (args.passphrase) return args.passphrase;
    if (process.env.HUB_KEY_PASSPHRASE && process.env.HUB_KEY_PASSPHRASE.length >= 12) {
        console.log(`  ℹ️  Používam existujúci HUB_KEY_PASSPHRASE z .env (${process.env.HUB_KEY_PASSPHRASE.length} chars)`);
        return process.env.HUB_KEY_PASSPHRASE;
    }
    const pw = await ask('  ❯ Vlož passphrase (min 12 znakov, alebo "auto" pre vygenerovaný 32 znakov): ');
    if (pw === 'auto' || !pw) {
        const generated = crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, 32);
        console.log(`  ✓ Vygenerovaná passphrase (POZNAČ SI JU, nikde inde sa neuloží!):`);
        console.log(`     ${generated}`);
        return generated;
    }
    if (pw.length < 12) throw new Error('passphrase musí mať aspoň 12 znakov');
    return pw;
}

function generateEd25519Pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const rawPriv = privateKey.export({ format: 'der', type: 'pkcs8' });
    const rawPub = publicKey.export({ format: 'der', type: 'spki' });
    // Posledných 32 bajtov je raw key
    const privHex = rawPriv.slice(-32).toString('hex');
    const pubHex = rawPub.slice(-32).toString('hex');
    return { privHex, pubHex };
}

function upsertEnvVar(envContent, key, value) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(envContent)) {
        return envContent.replace(re, `${key}=${value}`);
    }
    return envContent.trimEnd() + `\n${key}=${value}\n`;
}

(async () => {
    console.log('\n=== UMBRAXON Hub Key Generator (Phase 2.3) ===');
    console.log(`  Roles: ${args.roles.join(', ')}  | Encryption: ${args.plaintext ? 'DISABLED (dev)' : 'AES-256-GCM'}`);
    console.log(`  Env file: ${ENV_PATH}`);
    
    let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
    
    // Check existing
    const existing = args.roles.filter(r => {
        return process.env[`HUB_KEY_${r}_CIPHERTEXT`] || process.env[`HUB_KEY_${r}_PRIVKEY_HEX`];
    });
    if (existing.length && !args.yes && !args.dry) {
        console.log(`\n  ⚠️  Existujúce kľúče: ${existing.join(', ')}`);
        const confirm = await ask('  ❯ Naozaj prepísať? Toto invaliduje všetky doteraz vystavené certifikáty týchto rol! (yes/NO): ');
        if (confirm.toLowerCase() !== 'yes') {
            console.log('  ❌ Zrušené.');
            process.exit(0);
        }
    }
    
    let passphrase = null;
    if (!args.plaintext) {
        console.log('\n🔐 Passphrase pre encryption:');
        passphrase = await getPassphrase();
        envContent = upsertEnvVar(envContent, 'HUB_KEY_PASSPHRASE', passphrase);
    }
    
    const summary = [];
    for (const role of args.roles) {
        console.log(`\n🔑 Generujem ${role}...`);
        const { privHex, pubHex } = generateEd25519Pair();
        const keyId = `HUB-${role}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}`;
        console.log(`     key_id  = ${keyId}`);
        console.log(`     pubkey  = ${pubHex}`);
        
        envContent = upsertEnvVar(envContent, `HUB_KEY_${role}_ID`, keyId);
        envContent = upsertEnvVar(envContent, `HUB_KEY_${role}_PUBKEY_HEX`, pubHex);
        
        if (args.plaintext) {
            envContent = upsertEnvVar(envContent, `HUB_KEY_${role}_PRIVKEY_HEX`, privHex);
            // Vyčisti prípadný starý ciphertext
            envContent = envContent.replace(new RegExp(`^HUB_KEY_${role}_CIPHERTEXT=.*$`, 'm'), '');
        } else {
            const ct = store.encryptPrivkey(privHex, passphrase);
            envContent = upsertEnvVar(envContent, `HUB_KEY_${role}_CIPHERTEXT`, ct);
            // Vyčisti prípadný starý plaintext
            envContent = envContent.replace(new RegExp(`^HUB_KEY_${role}_PRIVKEY_HEX=.*$`, 'm'), '');
        }
        
        summary.push({ role, keyId, pubHex });
    }
    
    // Pre BASIC: backward-compat zachovaj aj HUB_ED25519_PUBKEY_HEX/PRIVKEY_HEX legacy mená (ale ako pointers).
    // Ak nikto z týchto neexistuje, môžeme ich nastaviť na BASIC values (aby starý kód fungoval).
    if (args.roles.includes('BASIC') && args.plaintext) {
        const basicSummary = summary.find(s => s.role === 'BASIC');
        // Žiadne dodatočné aliasy — hubkeys.js robí fallback z HUB_KEY_BASIC_* sám.
        // Ak chce user starý legacy mode, môže manually nastaviť HUB_ED25519_PRIVKEY_HEX.
        console.log(`\n  ℹ️  Pre úplnú backward compat môžeš ručne nastaviť HUB_ED25519_PUBKEY_HEX=${basicSummary.pubHex}`);
    }
    
    if (args.dry) {
        console.log('\n[dry-run] .env by sa zmenil takto (ukážka len BASIC-related riadkov):');
        const lines = envContent.split('\n').filter(l => l.includes('HUB_KEY_BASIC') || l.includes('HUB_KEY_PASSPHRASE'));
        console.log(lines.map(l => '   ' + l).join('\n'));
    } else {
        // Ensure file perms 600 pred zápisom (a po)
        try { fs.chmodSync(ENV_PATH, 0o600); } catch (_) {}
        fs.writeFileSync(ENV_PATH, envContent);
        try { fs.chmodSync(ENV_PATH, 0o600); } catch (_) {}
        console.log(`\n✓ .env aktualizovaný. chmod nastavený na 600.`);
    }
    
    console.log('\n=== Súhrn ===');
    for (const s of summary) {
        console.log(`  ${s.role.padEnd(6)} ${s.keyId}  pub=${s.pubHex.slice(0,16)}...${s.pubHex.slice(-8)}`);
    }
    console.log('\n⚠️  Bezpečnostné poznámky:');
    console.log('  1. Pubkey je verejný — server ho exposuje cez GET /api/hub/pubkey');
    console.log('  2. Privkey je zašifrovaný (AES-256-GCM, scrypt-derived key)');
    console.log('  3. Passphrase v .env je stále plaintext — v produkcii presuň do systemd-creds');
    console.log('  4. Backup .env do offline storage IHNEĎ (loss = nezvratná strata všetkých certs)');
    console.log('  5. Pred prvým štartom servera zavolaj: node migrations/run.js  (registruje kľúče v DB)');
})().catch(err => {
    console.error('\n❌ FATAL:', err.message);
    process.exit(1);
});
