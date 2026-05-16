#!/usr/bin/env bash
# Full production register flow with JSONL trace + hub PM2 log tail.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/agents/umbraxon-pr-agent"

ENV_FILE="${PR_ENV:-.env}"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — run scripts/prod/pr-agent-bootstrap.sh first" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

REG_LOG="$LOG_DIR/register-$(date -u +%Y%m%dT%H%M%SZ).log"
echo "Trace log (agent): $REG_LOG"
echo "Hub logs: pm2 logs kya-hub --lines 200 | grep -E 'registration_id|UMBRAXON-PR-AMBASSADOR|agent_registered'"

(
  python3 main.py register --log-dir "$LOG_DIR" --wait-complete --wait-timeout "${PR_WAIT_TIMEOUT:-900}"
) 2>&1 | tee "$REG_LOG"

echo ""
echo "=== Hub-side grep (last 50 matching lines) ==="
if command -v pm2 >/dev/null 2>&1; then
  pm2 logs kya-hub --nostream --lines 400 2>/dev/null \
    | grep -E 'registration_intent_created|agent_registered|UMBRAXON-PR-AMBASSADOR|REG-' \
    | tail -50 || true
else
  echo "pm2 not installed — check /root/.pm2/logs/kya-hub-out.log manually"
fi
