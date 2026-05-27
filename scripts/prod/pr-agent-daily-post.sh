#!/usr/bin/env bash
# Daily Moltbook post (themed, 1x per 24h cadence). PM2 cron: 0 10 * * *
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"
cd "$ROOT/agents/umbraxon-pr-agent"
# shellcheck disable=SC1090
set -a && source .env && set +a
./run-python.sh main.py daily-post --log-dir "$LOG_DIR" 2>&1 | tee -a "$LOG_DIR/cron-daily.log"

# Audit-only self-action (delta 0): prove the bot can sign /api/agent/:id/action like any external agent.
python3 "$ROOT/scripts/umbrexon_bot_client.py" action \
  --base-url "${KYA_HUB_BASE_URL}" \
  --kya-id "${KYA_ID}" \
  --privkey-file "./secrets/bot.key" \
  --action-type SELF_HEALTH_CHECK \
  --target "moltbook:daily-post" \
  --context-json "{\"platform\":\"moltbook\",\"job\":\"daily-post\"}" \
  --connect-timeout 5 --read-timeout 20 \
  >/dev/null || true
