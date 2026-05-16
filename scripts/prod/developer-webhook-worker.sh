#!/usr/bin/env bash
# Process developer webhook outbox (retry queue). PM2 cron: */1 * * * *
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"
cd "$ROOT"
# shellcheck disable=SC1090
set -a && source .env && set +a
exec node "$ROOT/scripts/run-developer-webhook-worker.js" 2>&1 | tee -a "$LOG_DIR/cron-dev-webhook.log"
