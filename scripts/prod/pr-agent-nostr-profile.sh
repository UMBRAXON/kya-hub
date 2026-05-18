#!/usr/bin/env bash
# Publish Nostr kind-0 profile (run once after key setup, or after bio changes).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"
cd "$ROOT/agents/umbraxon-pr-agent"
# shellcheck disable=SC1090
set -a && source .env && set +a
exec ./run-python.sh main.py nostr-profile --log-dir "$LOG_DIR" 2>&1 | tee -a "$LOG_DIR/nostr-profile.log"
