#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 2 smoke test
// ----------------------------------------------------------------------------
// Verifies the encrypted PostgreSQL backup produced by scripts/backup-database.sh:
//   1) artifact exists in /root/backups/postgres/
//   2) HMAC tail valid
//   3) openssl decrypts cleanly
//   4) decrypted output begins with PostgreSQL custom-format magic (b'PGDMP')
//   5) backup_log row present with matching sha256
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
    const pp = process.env.BACKUP_PASSPHRASE || '';
    const localDir = path.join(process.env.BACKUP_LOCAL_DIR || '/root/backups', 'postgres');
    let artifact = null;
    console.log('=== 1) artifact present ===');
    try {
        const files = fs.readdirSync(localDir)
            .filter(f => /^kyahub-\d{8}.dump\.gz\.enc$/.test(f))
            .map(f => ({ f, mtime: fs.statSync(path.join(localDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        if (files[0]) artifact = path.join(localDir, files[0].f);
    } catch (_) { /* */ }
    assert('artifact found', !!artifact, `looked in ${localDir}`);
    if (!artifact) return finalize();

    const buf = fs.readFileSync(artifact);
    assert('artifact size > 1KB', buf.length > 1024);

    console.log('=== 2) HMAC tail integrity ===');
    const tailHmac = buf.subarray(buf.length - 32);
    const cipherPart = buf.subarray(0, buf.length - 32);
    const expectedHmac = crypto.createHmac('sha256', pp).update(cipherPart).digest();
    assert('hmac tail matches HMAC(passphrase, ciphertext)', crypto.timingSafeEqual(tailHmac, expectedHmac));

    console.log('=== 3) openssl decryption roundtrip ===');
    const tmpDir = fs.mkdtempSync('/tmp/kya-item2-test-');
    const cipherFile = path.join(tmpDir, 'cipher.bin');
    const gzFile = path.join(tmpDir, 'decoded.gz');
    fs.writeFileSync(cipherFile, cipherPart);
    const dec = spawnSync('openssl', [
        'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt',
        '-pass', `pass:${pp}`, '-in', cipherFile, '-out', gzFile,
    ], { encoding: 'utf-8' });
    assert(`openssl rc=0 (${dec.status})`, dec.status === 0, (dec.stderr || '').slice(0, 200));

    console.log('=== 4) gunzip and PGDMP magic ===');
    if (dec.status === 0) {
        try {
            const gz = fs.readFileSync(gzFile);
            const plain = zlib.gunzipSync(gz);
            // pg_dump custom format starts with "PGDMP" magic
            const head = plain.subarray(0, 5).toString('ascii');
            assert('decoded magic is PGDMP', head === 'PGDMP', `got "${head}"`);
        } catch (e) { assert('gunzip', false, e.message); }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    console.log('=== 5) backup_log row ===');
    const pool = new Pool({
        host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    try {
        const r = await pool.query(`SELECT id, status, sha256, size_bytes FROM backup_log
            WHERE backup_kind='postgres' ORDER BY id DESC LIMIT 1`);
        assert('latest backup_log row present', r.rowCount > 0);
        if (r.rowCount > 0) {
            assert('row status=OK or PARTIAL', ['OK', 'PARTIAL'].includes(r.rows[0].status));
            const computed = crypto.createHash('sha256').update(buf).digest('hex');
            assert('row sha256 matches artifact', r.rows[0].sha256 === computed);
        }
    } catch (e) { assert('db query', false, e.message); }
    finally { await pool.end(); }

    finalize();

    function finalize() {
        console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
        process.exit(failed === 0 ? 0 : 1);
    }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
