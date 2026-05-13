#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 1 smoke test
// ----------------------------------------------------------------------------
// Asserts:
//   1) BACKUP_PASSPHRASE present, length=64 (hex 32 bytes)
//   2) scripts/backup-channel-state.sh exists and is executable
//   3) Most recent /root/backups/lightning_channel/*.tar.gz.enc exists
//   4) Encryption integrity: HMAC-SHA256 tail matches HMAC(passphrase, cipher)
//   5) Decryption roundtrip: artifact decrypts cleanly with the passphrase
//   6) Decrypted tarball contains expected ldk/ subdir
//   7) backup_log table has a recent matching row
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
    console.log('=== 1) env preconditions ===');
    const pp = process.env.BACKUP_PASSPHRASE || '';
    assert('BACKUP_PASSPHRASE present', pp.length > 0);
    assert('BACKUP_PASSPHRASE is 64 hex chars', /^[0-9a-fA-F]{64}$/.test(pp));

    console.log('=== 2) script binary present ===');
    const scriptPath = path.join(__dirname, 'backup-channel-state.sh');
    assert('script exists', fs.existsSync(scriptPath));
    try {
        const st = fs.statSync(scriptPath);
        assert('script is executable', !!(st.mode & 0o100));
    } catch (e) { assert('script stat', false, e.message); }

    console.log('=== 3) most recent encrypted artifact ===');
    const localDir = process.env.BACKUP_LOCAL_DIR || '/root/backups';
    const lcDir = path.join(localDir, 'lightning_channel');
    let artifact = null;
    try {
        const files = fs.readdirSync(lcDir)
            .filter(f => f.endsWith('.tar.gz.enc'))
            .map(f => ({ f, mtime: fs.statSync(path.join(lcDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        if (files[0]) artifact = path.join(lcDir, files[0].f);
    } catch (_) { /* ignore */ }
    assert('artifact present', !!artifact, `looked in ${lcDir}`);
    if (!artifact) return finalize();

    const buf = fs.readFileSync(artifact);
    assert('artifact size > 1KB', buf.length > 1024);

    console.log('=== 4) HMAC tail integrity ===');
    if (buf.length < 32) { assert('hmac present', false, 'artifact too short'); return finalize(); }
    const tailHmac = buf.subarray(buf.length - 32);
    const cipherPart = buf.subarray(0, buf.length - 32);
    const expectedHmac = crypto.createHmac('sha256', pp).update(cipherPart).digest();
    assert('hmac tail matches HMAC(pp, ciphertext)', crypto.timingSafeEqual(tailHmac, expectedHmac));

    console.log('=== 5) decryption roundtrip ===');
    const tmpDir = fs.mkdtempSync('/tmp/kya-item1-test-');
    const cipherFile = path.join(tmpDir, 'cipher.bin');
    const decFile = path.join(tmpDir, 'decoded.tar.gz');
    fs.writeFileSync(cipherFile, cipherPart);
    const dec = spawnSync('openssl', [
        'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt',
        '-pass', `pass:${pp}`, '-in', cipherFile, '-out', decFile,
    ], { encoding: 'utf-8' });
    assert(`openssl decrypt rc=0 (${dec.status})`, dec.status === 0, (dec.stderr || '').slice(0, 200));

    console.log('=== 6) tarball contains ldk/ ===');
    if (dec.status === 0) {
        const tarList = spawnSync('tar', ['-tzf', decFile], { encoding: 'utf-8' });
        assert('tar -t rc=0', tarList.status === 0, (tarList.stderr || '').slice(0, 200));
        const has_ldk = /(^|\n)\.\/ldk\//.test(tarList.stdout || '') || /(^|\n)ldk\//.test(tarList.stdout || '');
        assert('decoded tarball contains ldk/', has_ldk);
        const has_nwc = /nwc\.db/.test(tarList.stdout || '');
        assert('decoded tarball contains nwc.db', has_nwc);
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    console.log('=== 7) backup_log DB row ===');
    const pool = new Pool({
        host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT, 10) || 5432,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });
    try {
        const r = await pool.query(`SELECT id, backup_kind, status, sha256, size_bytes FROM backup_log
            WHERE backup_kind='lightning_channel' ORDER BY id DESC LIMIT 1`);
        assert('latest backup_log row present', r.rowCount > 0);
        if (r.rowCount > 0) {
            assert('row status=OK or PARTIAL', ['OK', 'PARTIAL'].includes(r.rows[0].status));
            assert('row sha256 matches artifact', r.rows[0].sha256 === crypto.createHash('sha256').update(buf).digest('hex'));
        }
    } catch (e) { assert('db query', false, e.message); }
    finally { await pool.end(); }

    finalize();

    function finalize() {
        console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
        process.exit(failed === 0 ? 0 : 1);
    }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
