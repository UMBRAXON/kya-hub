#!/usr/bin/env node
// UMBRAXON KYA-Hub DB Migration Runner (Node-based)
// Použitie:
//   node migrations/run.js                    # aplikuje všetky migrácie
//   node migrations/run.js --dry-run          # iba ukáže čo by spravil
//   node migrations/run.js --reset-password   # vygeneruje nové heslo pre kyahub_app
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const DRY = process.argv.includes('--dry-run');
const RESET_PW = process.argv.includes('--reset-password');

const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
for (const k of required) {
    if (!process.env[k]) {
        console.error(`❌ chýba .env: ${k}`);
        process.exit(1);
    }
}

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT, 10),
});

function genPassword() {
    return crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, 32);
}

async function ensureMigrationsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(64) PRIMARY KEY,
            applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            checksum VARCHAR(64)
        )
    `);
}

async function isApplied(version) {
    const r = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    return r.rowCount > 0;
}

async function applyFile(filepath) {
    const filename = path.basename(filepath);
    const version = filename.replace(/\.sql$/, '');
    const sql = fs.readFileSync(filepath, 'utf-8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

    if (await isApplied(version)) {
        console.log(`  ⏭  ${version} (už aplikovaná)`);
        return false;
    }

    console.log(`  → ${version} (checksum=${checksum}, ${sql.length} bajtov)`);
    
    if (DRY) {
        console.log(`     [dry-run] preskočené`);
        return false;
    }

    // Odfilter psql-specific direktívy (\set, \i)
    const cleanSql = sql.split('\n').filter(line => !line.trim().startsWith('\\')).join('\n');
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(cleanSql);
        await client.query(
            'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [version, checksum]
        );
        await client.query('COMMIT');
        console.log(`     ✓ úspešne aplikovaná`);
        return true;
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`     ✗ CHYBA: ${e.message}`);
        throw e;
    } finally {
        client.release();
    }
}

async function setAppPassword(password) {
    console.log(`  → ALTER USER kyahub_app SET PASSWORD ...`);
    if (DRY) {
        console.log(`     [dry-run] preskočené`);
        return;
    }
    await pool.query(`ALTER USER kyahub_app WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    console.log(`     ✓ heslo nastavené`);
}

async function testAppConnection(password) {
    const testPool = new Pool({
        user: 'kyahub_app',
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password,
        port: parseInt(process.env.DB_PORT, 10),
    });
    try {
        const r = await testPool.query('SELECT COUNT(*) FROM agents');
        console.log(`  ✓ kyahub_app login OK, agents count: ${r.rows[0].count}`);
        return true;
    } catch (e) {
        console.error(`  ✗ kyahub_app login FAIL: ${e.message}`);
        return false;
    } finally {
        await testPool.end();
    }
}

async function updateEnvFile(password) {
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf-8');
    
    if (envContent.includes('KYAHUB_APP_PASSWORD=')) {
        envContent = envContent.replace(/KYAHUB_APP_PASSWORD=.*/g, `KYAHUB_APP_PASSWORD=${password}`);
    } else {
        envContent += `\n# Vygenerované migráciou\nKYAHUB_APP_PASSWORD=${password}\n`;
    }
    
    if (!DRY) {
        fs.writeFileSync(envPath, envContent);
        console.log(`  ✓ .env aktualizovaný s KYAHUB_APP_PASSWORD`);
    } else {
        console.log(`  [dry-run] by aktualizoval .env`);
    }
}

(async () => {
    console.log('\n=== UMBRAXON KYA-Hub Migration Runner ===');
    console.log(`  DB: ${process.env.DB_NAME}@${process.env.DB_HOST}:${process.env.DB_PORT} (admin: ${process.env.DB_USER})`);
    console.log(`  Mode: ${DRY ? 'DRY-RUN' : 'APPLY'}${RESET_PW ? ' + RESET-PASSWORD' : ''}`);
    console.log('');

    try {
        await ensureMigrationsTable();

        // Aplikuj všetky .sql súbory podľa abecedy
        const files = fs.readdirSync(__dirname)
            .filter(f => /^\d+.*\.sql$/.test(f))
            .sort();
        
        console.log(`📂 Migrácie nájdené: ${files.length}`);
        for (const f of files) {
            await applyFile(path.join(__dirname, f));
        }

        // Heslo pre kyahub_app
        console.log('\n🔐 Heslo pre kyahub_app:');
        let appPassword = process.env.KYAHUB_APP_PASSWORD;
        if (!appPassword || RESET_PW) {
            appPassword = genPassword();
            console.log(`  ℹ️  Generujem nové heslo: ${appPassword}`);
            await setAppPassword(appPassword);
            await updateEnvFile(appPassword);
        } else {
            console.log(`  ℹ️  Používam existujúce z .env (${appPassword.slice(0,4)}...${appPassword.slice(-4)})`);
            await setAppPassword(appPassword);
        }

        // Test
        if (!DRY) {
            console.log('\n🧪 Test pripojenia ako kyahub_app:');
            const ok = await testAppConnection(appPassword);
            if (!ok) process.exit(2);
        }

        console.log('\n✓ Hotovo.');
        process.exit(0);
    } catch (e) {
        console.error('\n❌ FATAL:', e.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
})();
