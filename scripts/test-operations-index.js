#!/usr/bin/env node
'use strict';

// Hermetic test: docs/OPERATIONS-INDEX.md must exist and link to key runbooks.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IDX = path.join(ROOT, 'docs', 'OPERATIONS-INDEX.md');

let passed = 0, failed = 0;
function ok(n) { console.log(`  ✓ ${n}`); passed++; }
function fail(n, d) { console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); failed++; }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

truthy(fs.existsSync(IDX), 'OPERATIONS-INDEX exists');
if (!fs.existsSync(IDX)) process.exit(1);

const body = fs.readFileSync(IDX, 'utf8');
const mustMention = [
  'UMBRAXON.md',
  'docs/DEPLOY-CHECKLIST.md',
  'docs/BOOTSTRAP-CHECKLIST.md',
  'docs/GO-LIVE-OPERATOR-WALKTHROUGH.md',
  'docs/RESTORE-PROCEDURES.md',
  'docs/ALERTING-RUNBOOK.md',
  'docs/NETDATA-ACCESS.md',
  'docs/PROMETHEUS-METRICS.md',
  'docs/LOGGING.md',
  'docs/DIAGNOSTIC-CHECKLIST.md',
  'docs/SENTRY.md',
  'docs/WATCHTOWER-SETUP.md',
  'docs/WATCHTOWER-MONITORING.md',
  'openapi/openapi.yaml',
  'nginx-proxy/README.md',
  'scripts/backup-channel-state.sh',
  'scripts/backup-database.sh',
  'scripts/restore-drill.sh',
  'scripts/backup-offsite-smoketest.sh',
  'mcp/README.md',
];

for (const m of mustMention) {
  truthy(body.includes(m), `OPERATIONS-INDEX mentions ${m}`);
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

