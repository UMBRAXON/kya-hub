#!/usr/bin/env bash
# Daily / cron PR ambassador full cycle (dry-run unless PR_DRY_RUN=false in .env).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"
cd "$ROOT/agents/umbraxon-pr-agent"
# shellcheck disable=SC1090
set -a && source .env && set +a
exec ./run-python.sh main.py run-cycle --log-dir "$LOG_DIR" "$@"
