#!/usr/bin/env node
// ============================================================================
// UMBRAXON Hub Key Rotation (Phase 2.3)
// ============================================================================
// Usage:
//   node scripts/rotate-hub-key.js --role BASIC                  # rotuje BASIC
//   node scripts/rotate-hub-key.js --role BASIC --reason "yearly rotation"
//
// Workflow:
//   1) Vygeneruje nový Ed25519 pár pre danú rolu
//   2) Načíta passphrase z .env (alebo opýta interactive)
//   3) Zašifruje nový privkey, uloží do .env (overwrite HUB_KEY_<ROLE>_CIPHERTEXT)
//   4) V DB: starý key_id → DEPRECATED + nový → ACTIVE (atomicky)
//   5) Vypíše rotation_id pre audit
//
// PO ROTÁCII:
//   - Stary cert verify ostáva funkčný (deprecated keys sú v DB)
//   - Nové certy sa podpisujú novým kľúčom
//   - Po dual-verify window (default 30 dní) možno deprecated kľúč zmazať
//
// Optional: --reissue → po rotácii automaticky reissue všetky ACTIVE certs (BASIC tier)
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Pool } = require('pg');

const store = require('../lib/hub-key-store');

const ENV_PATH = path.join(__dirname, '..', '.env');
const args = parseArgs(process.argv.slice(2));

function parseArgs(arr) {
    const out = { role: null, reason: null, reissue: false, yes: false, dry: false };
    for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (a === '--role') out.role = arr[++i].toUpperCase();
        else if (a === '--reason') out.reason = arr[++i];
        else if (a === '--reissue') out.reissue = true;
        else if (a === '--yes' || a === '-y') out.yes = true;
        else if (a === '--dry-run' || a === '--dry') out.dry = true;
        else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    }
    if (!out.role) { console.error('--role required (BASIC/ELITE/ROOT)'); process.exit(1); }
    if (!['BASIC', 'ELITE', 'ROOT'].includes(out.role)) { console.error('invalid role'); process.exit(1); }
    return out;
}

function printHelp() {
    console.log(`
Hub Key Rotation:
  node scripts/rotate-hub-key.js --role BASIC --reason "scheduled rotation"
  node scripts/rotate-hub-key.js --role ELITE --reason "compromise suspected" --yes
`);
}

function ask(prompt) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); });
    });
}

function generatePair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    return {
        privHex: privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('hex'),
        pubHex: publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex'),
    };
}

function upsertEnvVar(content, key, value) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) return content.replace(re, `${key}=${value}`);
    return content.trimEnd() + `\n${key}=${value}\n`;
}

(async () => {
    console.log(`\n=== Hub Key Rotation: ${args.role} ===`);
    
    const pool = new Pool({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || '127.0.0.1',
        database: process.env.DB_NAME || 'kyahub',
        password: process.env.DB_PASSWORD,
        port: parseInt(process.env.DB_PORT || '5432', 10),
    });
    
    try {
        // Načítaj aktuálny ACTIVE key z DB
        const cur = await pool.query(
            `SELECT key_id, pubkey_hex, status FROM hub_keys WHERE role = $1 AND status = 'ACTIVE'`,
            [args.role]
        );
        const old = cur.rowCount > 0 ? cur.rows[0] : null;
        if (old) {
            console.log(`  Current ACTIVE: ${old.key_id}  pub=${old.pubkey_hex.slice(0,16)}...`);
        } else {
            console.log(`  ℹ️  Žiadny ACTIVE key pre rolu ${args.role} v DB — bude vytvorený prvý.`);
        }
        
        if (!args.yes && !args.dry) {
            const confirm = await ask(`  ❯ Naozaj rotovať ${args.role} kľúč? (yes/NO): `);
            if (confirm.toLowerCase() !== 'yes') {
                console.log('  ❌ Zrušené.');
                process.exit(0);
            }
        }
        
        // Načítaj passphrase
        const passphrase = process.env.HUB_KEY_PASSPHRASE;
        if (!passphrase || passphrase.length < 12) {
            console.error('  ❌ HUB_KEY_PASSPHRASE chýba alebo je krátka — nemôžeme šifrovať nový kľúč.');
            process.exit(1);
        }
        
        // Generuj nový pár
        const { privHex, pubHex } = generatePair();
        const newKeyId = `HUB-${args.role}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomBytes(2).toString('hex')}`;
        console.log(`\n🔑 New key:`);
        console.log(`     key_id = ${newKeyId}`);
        console.log(`     pubkey = ${pubHex}`);
        
        if (args.dry) {
            console.log('\n[dry-run] Nezapisujem do .env ani DB.');
            return;
        }
        
        // 1) Zapis do .env (encrypted)
        const ciphertext = store.encryptPrivkey(privHex, passphrase);
        let envContent = fs.readFileSync(ENV_PATH, 'utf-8');
        envContent = upsertEnvVar(envContent, `HUB_KEY_${args.role}_ID`, newKeyId);
        envContent = upsertEnvVar(envContent, `HUB_KEY_${args.role}_PUBKEY_HEX`, pubHex);
        envContent = upsertEnvVar(envContent, `HUB_KEY_${args.role}_CIPHERTEXT`, ciphertext);
        envContent = envContent.replace(new RegExp(`^HUB_KEY_${args.role}_PRIVKEY_HEX=.*$`, 'm'), '');
        try { fs.chmodSync(ENV_PATH, 0o600); } catch (_) {}
        fs.writeFileSync(ENV_PATH, envContent);
        try { fs.chmodSync(ENV_PATH, 0o600); } catch (_) {}
        console.log(`  ✓ .env updated (chmod 600)`);
        
        // 2) Atomicky v DB: starý → DEPRECATED, nový → ACTIVE
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (old) {
                await client.query(
                    `UPDATE hub_keys SET status = 'DEPRECATED', deprecated_at = NOW(), deprecation_reason = $1 WHERE key_id = $2`,
                    [args.reason || `Rotated to ${newKeyId}`, old.key_id]
                );
            }
            await client.query(
                `INSERT INTO hub_keys (key_id, role, alg, pubkey_hex, status, replaces_key_id, notes)
                 VALUES ($1, $2, 'Ed25519', $3, 'ACTIVE', $4, $5)`,
                [newKeyId, args.role, pubHex, old ? old.key_id : null, `Rotation: ${args.reason || 'scheduled'}`]
            );
            await client.query('COMMIT');
            console.log(`  ✓ DB updated: ${old ? old.key_id + ' → DEPRECATED' : 'new ACTIVE'}, ${newKeyId} → ACTIVE`);
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        
        console.log('\n⚠️  POST-ROTATION CHECKLIST:');
        console.log('   1. Restartuj server (pm2 restart kya-hub) — načíta nový kľúč');
        console.log('   2. Otestuj GET /api/hub/pubkey — overí že primary key sedí');
        console.log('   3. Backup .env do offline storage');
        if (args.role === 'BASIC') {
            console.log('   4. (Voliteľné) Reissue active certs cez admin endpoint /api/admin/agent/:kya/reissue-cert');
        }
        console.log('   5. Po dual-verify window (default 30 dní) môžeš deprecated key zmazať z .env');
        
    } catch (err) {
        console.error('\n❌ FATAL:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
})();
