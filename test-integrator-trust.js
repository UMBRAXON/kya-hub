#!/usr/bin/env node
'use strict';

const integratorTrust = require('./lib/integrator-trust');
const platform = require('./lib/platform-integrator');

function ok(cond, msg) {
    if (!cond) throw new Error(msg || 'assert failed');
}

function hubKeysAvailable() {
    try {
        require('./lib/hubkeys').getPublicInfo();
        return true;
    } catch {
        return false;
    }
}

(async () => {
    const env = integratorTrust.verificationEnvelope('UMBRA-000001');
    ok(env.cert_fetch.includes('/api/cert/'), 'verification envelope');

    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    ok(integratorTrust.sandboxBlockedInProduction('UMBRA-TEST-0001') === true, 'sandbox blocked prod');
    process.env.NODE_ENV = 'development';
    ok(integratorTrust.sandboxBlockedInProduction('UMBRA-TEST-0001') === false, 'sandbox ok dev');
    process.env.NODE_ENV = prev;

    if (hubKeysAvailable()) {
        const certs = require('./lib/certs');
        const body = certs.buildCertBody({
            kya_id: 'UMBRA-000001',
            agentName: 'T',
            pubkey: 'aa'.repeat(32),
            tier: 'BASIC',
            grade: 'B',
            validUntil: new Date(Date.now() + 86400000),
            manifestHash: 'bb'.repeat(32),
            reputationScore: 100,
            paymentMethod: 'lightning',
            paymentHash: 'ph',
            amountSats: 10000,
            serial: 'CERT-000001-001',
        });
        const signed = certs.signCert(body);
        const proof = integratorTrust.certProofFromBody(signed);
        ok(proof.cert_signature_valid === true, 'cert proof valid');

        const mockPool = {
            query: async () => ({
                rowCount: 1,
                rows: [{
                    kya_id: 'UMBRA-000467',
                    agent_name: 'BOT',
                    tier: 'BASIC',
                    conduct_grade: 'B',
                    reputation_score: 500,
                    violations_count: 0,
                    total_slashed: 0,
                    is_active: true,
                    status: 'VERIFIED',
                    manufacturer_id: null,
                    manufacturer_verified: false,
                    valid_until: new Date(Date.now() + 1e7),
                    last_heartbeat_at: new Date(),
                    heartbeat_count: 1,
                    is_dormant: false,
                    suspended_at: null,
                    retired_at: null,
                    retire_reason: null,
                    discovery_opt_in: false,
                    public_key: 'cc'.repeat(32),
                    serial: 'CERT-467-001',
                    cert_issued_at: new Date(),
                    cert_valid_until: new Date(Date.now() + 1e7),
                    revoked_at: null,
                    revoke_reason: null,
                    cert_body: signed,
                }],
            }),
        };
        const gate = await platform.getAgentStatusGate(mockPool, 'UMBRA-000467', {
            skipCache: true,
            includeCertBody: true,
        });
        ok(gate.body.verified === true, 'verified');
        ok(gate.cert_body, 'cert body attached');
    } else {
        console.log('  (skip cert crypto — hub keys not in env)');
    }

    console.log('test-integrator-trust: OK');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
