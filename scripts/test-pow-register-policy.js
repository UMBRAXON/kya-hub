#!/usr/bin/env node
/**
 * Hermetic checks for register PoW difficulty policy (no DB).
 * Run: node scripts/test-pow-register-policy.js
 */
'use strict';

const assert = require('assert');
const pow = require('../lib/pow');

function ok(label, fn) {
    try {
        fn();
        console.log('  OK', label);
    } catch (e) {
        console.error(' FAIL', label, e.message);
        process.exitCode = 1;
    }
}

console.log('PoW register policy (CFG snapshot)');
console.log('  REGISTER_DIFFICULTY=', pow.CFG.REGISTER_DIFFICULTY);
console.log('  REGISTER_ELITE_DIFFICULTY=', pow.CFG.REGISTER_ELITE_DIFFICULTY);
console.log('  REGISTER_MIN_DIFFICULTY=', pow.CFG.REGISTER_MIN_DIFFICULTY);

ok('BASIC default is at least min floor', () => {
    const r = pow.resolveDifficulty({ purpose: 'register', tier: 'BASIC' });
    assert.strictEqual(r.difficulty, pow.CFG.REGISTER_DIFFICULTY);
    assert.ok(r.difficulty >= pow.CFG.REGISTER_MIN_DIFFICULTY);
});

ok('ELITE default uses elite difficulty', () => {
    const r = pow.resolveDifficulty({ purpose: 'register', tier: 'ELITE' });
    assert.strictEqual(r.difficulty, pow.CFG.REGISTER_ELITE_DIFFICULTY);
});

ok('client difficulty=1 is raised to floor', () => {
    const r = pow.resolveDifficulty({ purpose: 'register', requested: 1, tier: 'BASIC' });
    assert.strictEqual(r.difficulty, pow.CFG.REGISTER_MIN_DIFFICULTY);
    assert.strictEqual(r.difficulty_requested, 1);
});

ok('client difficulty=20 is allowed for ELITE', () => {
    const r = pow.resolveDifficulty({ purpose: 'register', requested: 20, tier: 'ELITE' });
    assert.strictEqual(r.difficulty, 20);
});

ok('pay purpose has no register floor', () => {
    const r = pow.resolveDifficulty({ purpose: 'pay', requested: 10 });
    assert.strictEqual(r.difficulty, 10);
    assert.strictEqual(r.difficulty_floor, null);
});

ok('heartbeat not in REQUIRED_FOR', () => {
    assert.strictEqual(pow.isRequiredFor('heartbeat'), false);
});

if (process.exitCode) {
    console.error('\nSome checks failed.');
    process.exit(1);
}
console.log('\nAll PoW register policy checks passed.');
