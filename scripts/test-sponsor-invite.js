#!/usr/bin/env node
'use strict';

const assert = require('assert');
const sponsorInvite = require('../lib/sponsor-invite');

assert.strictEqual(sponsorInvite.isEnabled(), false, 'default disabled');

const payload = sponsorInvite.buildInviteCanonicalPayload({
    nonce: 'abc123',
    timestamp: '2026-05-15T12:00:00.000Z',
    invitee_pubkey: 'a'.repeat(64),
    tier_requested: 'BASIC',
    expected_agent_name: 'test-bot',
    ttl_hours: 72,
});
assert.ok(payload.includes('"kind":"sponsor_invite"'));
assert.ok(payload.includes('"tier_requested":"BASIC"'));

const badSig = '0'.repeat(128);
assert.strictEqual(
    sponsorInvite.verifySponsorActionSignature('b'.repeat(64), badSig, {
        nonce: 'n1',
        timestamp: '2026-05-15T12:00:00.000Z',
        invitee_pubkey: 'a'.repeat(64),
        tier_requested: 'ELITE',
    }),
    false
);

console.log('test-sponsor-invite: OK');
