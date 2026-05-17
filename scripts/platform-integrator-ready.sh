#!/usr/bin/env bash
# Platform integrator — production readiness gate (unit + live + worker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== Unit tests (hermetic) =="
node test-platform-integrator.js
node test-developer-api-keys.js
node test-developer-webhook-queue.js
node test-integrator-lsat.js

echo ""
echo "== DB migrations =="
node migrations/run.js

echo ""
echo "== Live API smoke =="
node test-platform-integrator-live.js

echo ""
echo "== Developer webhook worker (one batch) =="
node scripts/run-developer-webhook-worker.js

echo ""
echo "platform-integrator-ready: OK"
echo "Next: pm2 restart kya-hub --update-env && pm2 start kya-dev-webhook-worker"
echo "Partner doc: docs/FAQ-FOR-BOT-DEVELOPERS.md §I, examples/plugin-gate-v1.js"
