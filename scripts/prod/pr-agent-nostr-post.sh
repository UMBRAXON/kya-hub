#!/usr/bin/env bash
# Themed Nostr post (Mon/Wed/Fri 14:00 UTC). PM2 cron: 0 14 * * 1,3,5
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"
cd "$ROOT/agents/umbraxon-pr-agent"
# shellcheck disable=SC1090
set -a && source .env && set +a
exec ./run-python.sh main.py nostr-post --log-dir "$LOG_DIR" 2>&1 | tee -a "$LOG_DIR/cron-nostr.log"
