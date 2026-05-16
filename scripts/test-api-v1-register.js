#!/usr/bin/env node
'use strict';

const apiV1 = require('../lib/api-v1-register');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const compact = {
  agent_name: 'TESTBOT-001',
  public_key: 'a'.repeat(64),
  lightning_node_id: 'b'.repeat(66),
  capabilities: ['pr_marketing'],
  tier: 'BASIC',
  timestamp: new Date().toISOString(),
  nonce: 'abcd1234abcd1234',
  manifest_signature: 'c'.repeat(128),
  challenge_id: 'CH-1',
  challenge_response: 'd'.repeat(128),
};

const out = apiV1.normalizeToInitiateBody(compact);
assert(out.ok, 'normalize should succeed');
assert(out.body.manifest.agent.name === 'TESTBOT-001', 'agent name');
assert(
  out.body.manifest.payment_hints[0].type === 'lightning_node_id',
  'ln hint'
);

const bad = apiV1.normalizeToInitiateBody({ public_key: 'x' });
assert(!bad.ok && bad.json.error === 'INVALID_PUBLIC_KEY', 'bad pubkey');

console.log('[test-api-v1-register] OK');
