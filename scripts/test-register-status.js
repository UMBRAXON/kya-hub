#!/usr/bin/env node
'use strict';

const registerStatus = require('../lib/register-status');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(registerStatus.REG_ID_RE.test('REG-' + 'a'.repeat(24)), 'valid reg id');
assert(!registerStatus.REG_ID_RE.test('REG-bad'), 'invalid reg id');

console.log('[test-register-status] OK');
