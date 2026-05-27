#!/usr/bin/env bash
# Daily Mastodon post (curated queue). PM2 cron suggested: 30 9 * * *
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${GROWTH_LOG_DIR:-$ROOT/logs/growth}"
mkdir -p "$LOG_DIR"

TOKEN_FILE="${MASTODON_TOKEN_FILE:-$ROOT/.secrets/mastodon.token}"

export MASTODON_BASE_URL="${MASTODON_BASE_URL:-https://mastodon.social}"
export MASTODON_TOKEN_FILE="$TOKEN_FILE"
export MASTODON_MAX_PER_RUN="${MASTODON_MAX_PER_RUN:-1}"

exec node "$ROOT/scripts/mastodon/post-scheduled.js" 2>&1 | tee -a "$LOG_DIR/mastodon-cron.log"

