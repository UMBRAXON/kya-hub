#!/usr/bin/env bash
# Moltbook comments: own-post replies + relevant feed. PM2 cron: 15 */3 * * *
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"
cd "$ROOT/agents/umbraxon-pr-agent"
set -a && source .env && set +a
./run-python.sh main.py moltbook-engage --log-dir "$LOG_DIR" 2>&1 | tee -a "$LOG_DIR/cron-engage.log"

# Audit-only self-action (delta 0): signed action proves identity + canonical signing works.
python3 "$ROOT/scripts/umbrexon_bot_client.py" action \
  --base-url "${KYA_HUB_BASE_URL}" \
  --kya-id "${KYA_ID}" \
  --privkey-file "./secrets/bot.key" \
  --action-type SELF_HEALTH_CHECK \
  --target "moltbook:engage" \
  --context-json "{\"platform\":\"moltbook\",\"job\":\"engage\"}" \
  --connect-timeout 5 --read-timeout 20 \
  >/dev/null || true
