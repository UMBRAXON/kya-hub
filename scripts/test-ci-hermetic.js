#!/usr/bin/env node
'use strict';

// Hermetic CI test: verifies repo-shipped operational artifacts exist
// and contain expected sentinel strings. No network, no DB, no .env required.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(n) { console.log(`  ✓ ${n}`); passed++; }
function fail(n, d) { console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); failed++; }
function truthy(cond, n, d) { return cond ? ok(n) : fail(n, d); }

function mustExist(p) {
  const abs = path.join(ROOT, p);
  truthy(fs.existsSync(abs), `exists: ${p}`);
  return abs;
}

function mustInclude(p, needles) {
  const abs = path.join(ROOT, p);
  const body = fs.readFileSync(abs, 'utf8');
  for (const n of needles) {
    truthy(body.includes(n), `${p} includes ${JSON.stringify(n)}`);
  }
}

console.log('=== 1) GitHub Actions workflows ===');
mustExist('.github/workflows/ci.yml');
mustExist('.github/workflows/nightly.yml');
mustInclude('.github/workflows/ci.yml', [
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'npm ci',
  'npm run ci:audit',
  'npm run ci:smoke',
]);
mustInclude('.github/workflows/nightly.yml', [
  'cron:',
  'npm ci',
  'npm run ci:audit',
  'npm run ci:smoke',
]);

console.log('=== 2) Prometheus alert rules ===');
mustExist('config/prometheus-alerts.yml');
mustInclude('config/prometheus-alerts.yml', [
  'groups:',
  'KYAHubPayLatencyP99High',
  'KYAHubPayLatencyP99Critical',
  'KYAHubChainForkDetected',
  'KYAHubCertBreakerHalted',
  'kyahub_request_duration_seconds_bucket{route="/api/pay"}',
]);

console.log('=== 3) Logging baseline artifacts ===');
mustExist('config/logrotate-kya-hub');
mustInclude('config/logrotate-kya-hub', [
  '/root/.pm2/logs/*.log',
  '/var/log/kya-*.log',
  'rotate 30',
  'compress',
]);
mustExist('docs/LOGGING.md');
mustInclude('docs/LOGGING.md', [
  '/root/.pm2/logs/',
  'logrotate',
  'Do not `source .env`',
  'debug.log',
  'logrotate-btcpay-bitcoin-lnd.example',
]);
mustExist('config/logrotate-btcpay-bitcoin-lnd.example');
mustInclude('config/logrotate-btcpay-bitcoin-lnd.example', [
  'PLACEHOLDER_BITCOIND',
  'copytruncate',
  'debug.log',
  'docker inspect',
]);

console.log('=== 4) Alerting runbook artifacts ===');
mustExist('docs/ALERTING-RUNBOOK.md');
mustInclude('docs/ALERTING-RUNBOOK.md', [
  'First-5-min triage checklist',
  'pm2 logs kya-hub',
  'curl -fsS http://127.0.0.1:3000/api/health',
]);

console.log('=== 5) Offsite backup smoke test script ===');
mustExist('scripts/backup-offsite-smoketest.sh');
mustInclude('scripts/backup-offsite-smoketest.sh', [
  'put/list/get/delete',
  's3backup::detect_provider',
]);

console.log('=== 6) Error tracking (Sentry) wiring ===');
mustExist('lib/sentry.js');
mustInclude('lib/sentry.js', [
  'SENTRY_DSN',
  'beforeSend',
  'sendDefaultPii: false',
]);

console.log('=== 7) OpenAPI spec baseline ===');
mustExist('openapi/openapi.yaml');
mustInclude('openapi/openapi.yaml', [
  'openapi: 3.0.3',
  'title: UMBRAXON KYA-Hub API',
  '/api/health:',
  '/api/pay:',
  '/api/register/initiate:',
  '/api/webhook/btcpay:',
  '/api/metrics:',
  '/api/admin/ops-summary:',
  '/api/admin/pricing:',
  '/api/admin/invoices:',
  '/api/admin/deny-list:',
  '/api/admin/hub-keys:',
  '/api/manufacturer/attestation:',
  '/api/admin/abuse:',
  '/api/admin/anchor/queue:',
  '/api/admin/volumetric-limits:',
  '/api/admin/chain-status:',
  '/api/dashboard:',
  '/api/anchors/pending:',
  '/api/protocol/reputation-model:',
  'X-Admin-Key',
]);

console.log('=== 8) Watchtower monitoring (repo wiring) ===');
mustExist('scripts/watchtower-monitor.js');
mustExist('docs/WATCHTOWER-MONITORING.md');
mustInclude('docs/WATCHTOWER-MONITORING.md', [
  'WATCHTOWER_MONITOR_ENABLED=true',
  'pm2 trigger kya-watchtower-monitor',
]);

console.log('=== 9) Deploy + Sentry docs ===');
mustExist('docs/DEPLOY-CHECKLIST.md');
mustInclude('docs/DEPLOY-CHECKLIST.md', [
  'pm2 restart kya-hub',
  'node migrations/run.js',
  'docs/RESTORE-PROCEDURES.md',
]);
mustExist('docs/SENTRY.md');
mustInclude('docs/SENTRY.md', [
  'SENTRY_DSN',
  'sendDefaultPii: false',
  'beforeSend',
]);

console.log('=== 10) Bot portal: canonical /bots + alias redirect wiring ===');
mustInclude('server.js', [
  'BOTS_ALIAS_HOST',
  'BOTS_PORTAL_PUBLIC_BASE',
  'MAIN_WEB_HOSTS',
  "res.redirect(301",
  "app.use('/bots'",
  'public/bots',
]);

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

