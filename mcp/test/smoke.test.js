import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHubClient } from '../src/hub-client.js';

test('createHubClient normalizes trailing slash', () => {
  const c = createHubClient({ baseUrl: 'https://example.com/' });
  assert.equal(c.baseUrl, 'https://example.com');
});

test('createHubClient default base', () => {
  const c = createHubClient({});
  assert.equal(c.baseUrl, 'https://umbraxon.xyz');
});
