#!/usr/bin/env bash
# Signed heartbeat for the PR ambassador agent (treat as external bot).
# Runs via PM2 cron; uses the Python reference client (umbrexon_bot_client.py).
set -euo pipefail

ROOT="/root/kya-hub"
AGENT_DIR="$ROOT/agents/umbraxon-pr-agent"

# shellcheck disable=SC1090
set -a && source "$AGENT_DIR/.env" && set +a

exec python3 "$ROOT/scripts/umbrexon_bot_client.py" heartbeat \
  --base-url "${KYA_HUB_BASE_URL}" \
  --kya-id "${KYA_ID}" \
  --privkey-file "$AGENT_DIR/secrets/bot.key" \
  --fetch-reputation

