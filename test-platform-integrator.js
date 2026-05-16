#!/usr/bin/env node
/**
 * Hermetic tests for platform integrator read model (no live DB).
 */
'use strict';

const platform = require('./lib/platform-integrator');
const ttlCache = require('./lib/ttl-cache');

let passed = 0;
let failed = 0;

function ok(name, cond) {
    if (cond) {
        passed += 1;
        console.log('ok —', name);
    } else {
        failed += 1;
        console.error('FAIL —', name);
    }
}

ok('invalid kya id', platform.invalidKyaId('UMBRA-XXXXXX'));
ok('valid kya id', !platform.invalidKyaId('UMBRA-000467'));

const trustedRow = {
    kya_id: 'UMBRA-000467',
    serial: 'CERT-000467-001',
    revoked_at: null,
    cert_valid_until: null,
    retired_at: null,
    suspended_at: null,
    is_active: true,
    status: 'VERIFIED',
};

const mockPool = {
    async query(_sql, params) {
        if (params[0] === 'UMBRA-000467') {
            return {
                rowCount: 1,
                rows: [{
                    ...trustedRow,
                    agent_name: 'TEST',
                    tier: 'BASIC',
                    conduct_grade: 'B',
                    reputation_score: 500,
                    violations_count: 0,
                    total_slashed: 0,
                    manufacturer_id: null,
                    manufacturer_verified: false,
                    last_heartbeat_at: null,
                    heartbeat_count: 0,
                    is_dormant: false,
                    discovery_opt_in: false,
                    public_key: 'a'.repeat(64),
                    cert_issued_at: new Date(),
                    cert_body: { credentialSubject: { payment_hints: [] } },
                }],
            };
        }
        return { rowCount: 0, rows: [] };
    },
};

(async () => {
    ttlCache.clear();
    const gate = await platform.getAgentStatusGate(mockPool, 'UMBRA-000467', { skipCache: true });
    ok('status gate 200', gate.status === 200);
    ok('status verified', gate.body && gate.body.verified === true);

    const full = await platform.getAgentIntegratorView(mockPool, 'UMBRA-000467', { skipCache: true });
    ok('full view 200', full.status === 200);
    ok('full trust TRUSTED', full.body && full.body.trust && full.body.trust.trust_level === 'TRUSTED');
    ok('full has links', full.body && full.body.links && full.body.links.cert);

    const miss = await platform.getAgentStatusGate(mockPool, 'UMBRA-000001', { skipCache: true });
    ok('missing agent 404', miss.status === 404);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
