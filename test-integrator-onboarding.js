#!/usr/bin/env node
'use strict';

const assert = require('assert');
const sandbox = require('./lib/platform-integrator-sandbox');
const integratorKeyRequests = require('./lib/integrator-key-requests');

let passed = 0;
function ok(cond, msg) {
    assert.ok(cond, msg);
    passed++;
    console.log('  OK', msg);
}

console.log('=== integrator sandbox ===');
ok(sandbox.isSandboxKyaId('UMBRA-TEST-0001'), 'sandbox id');
ok(!sandbox.isSandboxKyaId('UMBRA-000001'), 'prod id not sandbox');
const v = sandbox.statusBody('UMBRA-TEST-0001');
ok(v.status === 200 && v.body.verified === true, 'TEST-0001 verified');
const rev = sandbox.statusBody('UMBRA-TEST-0005');
ok(rev.body.verified === false, 'TEST-0005 not verified');
const nf = sandbox.statusBody('UMBRA-TEST-0000');
ok(nf.error === 'AGENT_NOT_FOUND', 'TEST-0000 not found');

console.log('=== key request validate ===');
const bad = integratorKeyRequests.validateSubmit({ organization: 'x', contact_email: 'bad', use_case: 'short' });
ok(!bad.ok, 'reject bad email/use_case');
const good = integratorKeyRequests.validateSubmit({
    organization: 'Test Co',
    contact_email: 'ops@example.com',
    use_case: 'We integrate KYA gate into our LN marketplace checkout flow.',
});
ok(good.ok, 'accept valid request');

console.log(`\nintegrator-onboarding: ${passed} checks passed`);
