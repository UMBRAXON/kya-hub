#!/usr/bin/env node
/**
 * Hermetic checks for integrations / delegation-pass helpers (no DB).
 */
'use strict';

const assert = require('assert');
const integrationsManifest = require('./lib/integrations-manifest');
const delegationPass = require('./lib/delegation-pass');

function ok(name, cond, msg) {
    if (!cond) throw new Error(`${name}: ${msg || 'failed'}`);
    console.log(`ok — ${name}`);
}

// payment_hints + integrations AJV-adjacent audit
const goodManifest = {
    protocol_version: '1.0',
    agent: { name: 'TestBot-001', version: '1.0.0', pubkey: 'a'.repeat(64), capabilities: ['btc_payments'] },
    tier_requested: 'BASIC',
    timestamp: new Date().toISOString(),
    nonce: 'abcd1234',
    payment_hints: [{ type: 'lightning_address', value: 'bot@example.com' }],
    integrations: {
        discovery_opt_in: true,
        developer_webhooks: [{
            url: 'https://hooks.example.com/kya',
            events: ['agent.registered', 'reputation.changed'],
        }],
    },
};
ok('audit good manifest', integrationsManifest.auditManifestExtensions(goodManifest).ok);

const badWebhook = JSON.parse(JSON.stringify(goodManifest));
badWebhook.integrations.developer_webhooks[0].url = 'http://insecure.example/hook';
ok('reject http webhook', !integrationsManifest.auditManifestExtensions(badWebhook).ok);

// normalizeInet
ok('inet null', delegationPass.normalizeInet(null) === null);
ok('inet ipv4', delegationPass.normalizeInet('203.0.113.9') === '203.0.113.9');
ok('inet garbage', delegationPass.normalizeInet('not-an-ip') === null);

// caveat validation
ok('caveats required', !delegationPass.validateCaveats([]).ok);
ok('caveats ok', delegationPass.validateCaveats(['payment.max_satoshi:1']).ok);

// L402 profile doc shape
const prof = delegationPass.l402DelegationProfileDoc();
ok('l402 profile id', prof.profile === delegationPass.L402_PROFILE_ID);

// verifyDelegationPass rejects junk
const bad = delegationPass.verifyDelegationPass({ typ: 'wrong' });
ok('verify junk', bad.valid === false);

console.log('\nAll integration devex checks passed.\n');
