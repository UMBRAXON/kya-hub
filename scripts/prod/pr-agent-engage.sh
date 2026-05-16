#!/usr/bin/env bash
# Moltbook comments: own-post replies + relevant feed. PM2 cron: 15 */3 * * *
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"
cd "$ROOT/agents/umbraxon-pr-agent"
set -a && source .env && set +a
exec ./run-python.sh main.py moltbook-engage --log-dir "$LOG_DIR" 2>&1 | tee -a "$LOG_DIR/cron-engage.log"
