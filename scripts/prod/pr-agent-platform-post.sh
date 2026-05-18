#!/usr/bin/env bash
# One-shot Moltbook announcement — Platform Integrator API.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENT="$ROOT/agents/umbraxon-pr-agent"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"
cd "$AGENT"
exec python3 main.py platform-post 2>&1 | tee -a "$LOG_DIR/platform-post.log"
