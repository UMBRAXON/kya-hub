#!/usr/bin/env node
'use strict';

// Hermetic test: README must link to critical operator docs.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const README = path.join(ROOT, 'README.md');

let passed = 0, failed = 0;
function ok(n) { console.log(`  ✓ ${n}`); passed++; }
function fail(n, d) { console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); failed++; }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

truthy(fs.existsSync(README), 'README exists');
if (!fs.existsSync(README)) process.exit(1);

const body = fs.readFileSync(README, 'utf8');
const mustMention = [
  'UMBRAXON.md',
  'docs/DEPLOY-CHECKLIST.md',
  'docs/RESTORE-PROCEDURES.md',
  'docs/ALERTING-RUNBOOK.md',
  'docs/LOGGING.md',
  'scripts/backup-offsite-smoketest.sh',
  'docs/WATCHTOWER-MONITORING.md',
  'docs/SENTRY.md',
  'openapi/openapi.yaml',
];

for (const m of mustMention) {
  truthy(body.includes(m), `README mentions ${m}`);
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

