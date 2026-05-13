#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Phase 5b Multi-Sig ELITE Cert Test
// ----------------------------------------------------------------------------
// Verifies the new multi-sig signing + verification path WITHOUT broadcasting
// any transactions and WITHOUT touching the live `certificates` table.
//
//   1. hubkeys.signMultiSig({ roles: ['BASIC','ELITE'] }) returns 2 sigs.
//   2. hubkeys.verifyMultiSig accepts a correctly-formed bundle.
//   3. hubkeys.verifyMultiSig rejects a tampered signature.
//   4. hubkeys.signMultiSig throws for missing required role.
//   5. hubkeys.signMultiSig with optional skipped role returns count<roles.
//   6. certs.signCert on an ELITE body produces 'Ed25519MultiSignature2020'
//      proof block by default (CERT_ELITE_MULTISIG defaults on).
//   7. certs.signCert on a BASIC body produces legacy single-sig 'Ed25519Signature2020'.
//   8. certs.verifyCertSignature accepts both proof types end-to-end.
//   9. certs.verifyCertSignature rejects a tampered multi-sig cert.
//  10. signing the SAME cert body twice yields the SAME canonical hash
//      (verifies determinism of canonical JSON serializer used for both paths).
//  11. setting CERT_ELITE_MULTISIG=false makes ELITE certs single-sig again
//      (legacy backward-compat path).
//  12. Threshold semantics: threshold=2 with only 1 valid signature is rejected.
//  13. Break-glass (3-role / 3-of-3) path works when ROOT is configured.
//
// Run:
//   node scripts/test-multisig-elite.js
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const crypto = require('crypto');
const hubkeys = require('../lib/hubkeys');
const certs = require('../lib/certs');

let passed = 0, failed = 0;
const fails = [];
function ok(n)  { console.log(`  \u2713 ${n}`); passed++; }
function fail(n, d) { console.log(`  \u2717 ${n}\n    ${d || ''}`); failed++; fails.push({ n, d }); }
function eq(a, b, n)  { return (JSON.stringify(a) === JSON.stringify(b)) ? ok(n)
                          : fail(n, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

async function section(t, fn) {
    console.log(`\n=== ${t} ===`);
    try { await fn(); }
    catch (e) {
        console.log(`  ! section threw: ${e.message}\n${e.stack || ''}`);
        fails.push({ n: t, d: e.message });
        failed++;
    }
}

function sampleCertBody(tier) {
    return {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'KYAAgentCertificate'],
        id: 'urn:kya:cert:CERT-TEST-001',
        issuer: { id: 'did:key:ed25519:HUB', name: 'TEST' },
        issuanceDate: '2026-05-12T16:00:00Z',
        expirationDate: tier === 'ELITE' ? null : '2027-05-12T00:00:00Z',
        credentialSubject: {
            id: 'urn:kya:agent:UMBRA-TEST',
            kya_id: 'UMBRA-TEST',
            agent_name: 'multisig-test-bot',
            agent_pubkey: '00'.repeat(32),
            tier,
            grade: tier === 'ELITE' ? 'S' : 'B',
            reputation: { score: 500, zone: 'NEUTRAL', zone_label: 'Neutral', max_score: 1000, operational: true },
        },
    };
}

(async () => {
    await section('1-3. hubkeys.signMultiSig + verifyMultiSig happy path', async () => {
        const msg = crypto.randomBytes(64);
        const r = hubkeys.signMultiSig({
            message: msg,
            roles: ['BASIC', 'ELITE'],
        });
        eq(r.count, 2, '1.1 returns 2 signatures');
        eq(r.signatures.length, 2, '1.2 signatures array length 2');
        truthy(/^[0-9a-f]{128}$/.test(r.signatures[0].signature), '1.3 first sig is 128 hex');
        truthy(r.signatures[0].role === 'BASIC', '1.4 first role = BASIC');
        truthy(r.signatures[1].role === 'ELITE', '1.5 second role = ELITE');

        const v = hubkeys.verifyMultiSig(msg, r.signatures, 2);
        truthy(v.valid, '2.1 verify happy path returns valid=true');
        eq(v.validCount, 2, '2.2 validCount=2');

        // Tamper second signature
        const tampered = [
            r.signatures[0],
            { ...r.signatures[1], signature: r.signatures[1].signature.replace(/.$/,
                r.signatures[1].signature.endsWith('0') ? '1' : '0') },
        ];
        const vbad = hubkeys.verifyMultiSig(msg, tampered, 2);
        truthy(!vbad.valid, '3.1 tampered sig => invalid');
        eq(vbad.validCount, 1, '3.2 validCount=1');
    });

    await section('4. Missing required role throws', async () => {
        let threw = false; let errMsg = '';
        try {
            hubkeys.signMultiSig({
                message: Buffer.from('x'),
                roles: ['BASIC', 'NONEXISTENT_ROLE'],
            });
        } catch (e) { threw = true; errMsg = e.message; }
        truthy(threw, '4.1 throws', errMsg);
    });

    await section('5. Optional skipped role does not throw', async () => {
        const r = hubkeys.signMultiSig({
            message: Buffer.from('x'),
            roles: ['BASIC', 'NONEXISTENT_ROLE'],
            optional: ['NONEXISTENT_ROLE'],
        });
        eq(r.count, 1, '5.1 count=1');
        eq(r.missing, ['NONEXISTENT_ROLE'], '5.2 missing array contains skipped role');
    });

    await section('6. ELITE body -> multi-sig proof by default', async () => {
        const body = sampleCertBody('ELITE');
        const signed = certs.signCert(body);
        eq(signed.proof.type, 'Ed25519MultiSignature2020', '6.1 proof.type=Ed25519MultiSignature2020');
        truthy(Array.isArray(signed.proof.signatures), '6.2 signatures is array');
        eq(signed.proof.signatures.length, 2, '6.3 2 signatures present');
        eq(signed.proof.threshold, 2, '6.4 threshold=2');
        truthy(/^did:key:ed25519:[0-9a-f]{64}#key-basic$/.test(signed.proof.signatures[0].verificationMethod),
            '6.5 first VM has #key-basic');
        truthy(/^did:key:ed25519:[0-9a-f]{64}#key-elite$/.test(signed.proof.signatures[1].verificationMethod),
            '6.6 second VM has #key-elite');
    });

    await section('7. BASIC body -> legacy single-sig', async () => {
        const body = sampleCertBody('BASIC');
        const signed = certs.signCert(body);
        eq(signed.proof.type, 'Ed25519Signature2020', '7.1 type=Ed25519Signature2020');
        truthy(typeof signed.proof.signatureValue === 'string', '7.2 has signatureValue');
        truthy(!Array.isArray(signed.proof.signatures), '7.3 no signatures array');
    });

    await section('8. verifyCertSignature accepts both formats', async () => {
        const elite = certs.signCert(sampleCertBody('ELITE'));
        const basic = certs.signCert(sampleCertBody('BASIC'));
        const ve = certs.verifyCertSignature(elite);
        const vb = certs.verifyCertSignature(basic);
        truthy(ve.valid && ve.multisig === true, '8.1 ELITE multi-sig verifies');
        truthy(vb.valid && vb.multisig === false, '8.2 BASIC single-sig verifies');
        eq(ve.threshold, 2, '8.3 ELITE threshold=2');
        eq(ve.validCount, 2, '8.4 ELITE validCount=2');
    });

    await section('9. Tampered multi-sig rejected', async () => {
        const elite = certs.signCert(sampleCertBody('ELITE'));
        // Flip a byte in the FIRST signature
        const orig = elite.proof.signatures[0].signatureValue;
        elite.proof.signatures[0].signatureValue = orig.replace(/.$/,
            orig.endsWith('0') ? '1' : '0');
        const v = certs.verifyCertSignature(elite);
        truthy(!v.valid, '9.1 tampered cert rejected');
        truthy(v.validCount === 1 && v.threshold === 2, '9.2 1<2 threshold');
    });

    await section('10. Canonical hash determinism', async () => {
        const body = sampleCertBody('ELITE');
        const c1 = certs.canonicalize(body);
        const c2 = certs.canonicalize(JSON.parse(JSON.stringify(body)));
        eq(c1, c2, '10.1 canonicalize is deterministic');
    });

    await section('11. CERT_ELITE_MULTISIG=false → ELITE falls back to single-sig', async () => {
        const prev = process.env.CERT_ELITE_MULTISIG;
        process.env.CERT_ELITE_MULTISIG = 'false';
        try {
            const signed = certs.signCert(sampleCertBody('ELITE'));
            eq(signed.proof.type, 'Ed25519Signature2020', '11.1 fallback to single-sig');
            truthy(signed.proof.signingRole === 'ELITE', '11.2 signingRole=ELITE');
        } finally {
            if (prev === undefined) delete process.env.CERT_ELITE_MULTISIG;
            else process.env.CERT_ELITE_MULTISIG = prev;
        }
    });

    await section('12. Threshold rejects under-signed bundle', async () => {
        const msg = crypto.randomBytes(32);
        const r = hubkeys.signMultiSig({ message: msg, roles: ['BASIC', 'ELITE'] });
        // Pretend only BASIC was provided to the verifier
        const v = hubkeys.verifyMultiSig(msg, [r.signatures[0]], 2);
        truthy(!v.valid, '12.1 1 sig with threshold 2 => invalid');
        eq(v.validCount, 1, '12.2 validCount=1');
        eq(v.threshold, 2, '12.3 threshold=2');
    });

    await section('13. Break-glass 3-of-3 with ROOT (if configured)', async () => {
        const rootPub = hubkeys.getPubkeyForRole('ROOT');
        if (!rootPub) {
            console.log('  (skipped: ROOT key not configured in this env)');
            return;
        }
        // Explicit override on signCert to invoke the break-glass path
        const signed = certs.signCert(sampleCertBody('ELITE'), undefined, {
            multiSig: true,
            roles: ['BASIC', 'ELITE', 'ROOT'],
            threshold: 3,
        });
        eq(signed.proof.type, 'Ed25519MultiSignature2020', '13.1 multi-sig type');
        eq(signed.proof.threshold, 3, '13.2 threshold=3');
        eq(signed.proof.signatures.length, 3, '13.3 3 signatures');
        const v = certs.verifyCertSignature(signed);
        truthy(v.valid, '13.4 3-of-3 verifies');
        eq(v.validCount, 3, '13.5 validCount=3');
        // Verify per-role attribution
        const roles = signed.proof.signatures.map(s => s.role);
        eq(roles, ['BASIC', 'ELITE', 'ROOT'], '13.6 roles in declared order');
    });

    console.log(`\n=== RESULTS ===`);
    console.log(`PASS: ${passed}  FAIL: ${failed}`);
    if (failed > 0) for (const f of fails) console.log(`  - ${f.n}: ${f.d || ''}`);
    process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
    console.error('FATAL', e);
    process.exit(99);
});
