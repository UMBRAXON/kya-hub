#!/usr/bin/env bash
# Runs integrator smoke test; writes public-ish proof for operators.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/logs/growth"
mkdir -p "$OUT"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG="$OUT/demo-witness-latest.txt"

{
  echo "KYA demo witness — $STAMP UTC"
  echo "Hub: ${HUB_URL:-https://www.umbraxon.xyz}"
  echo "---"
  HUB_URL="${HUB_URL:-https://www.umbraxon.xyz}" "$ROOT/scripts/integrate-in-5min.sh" || true
} >"$LOG" 2>&1

FAIL=0
grep -qE 'SUMMARY: [0-9]+ passed, 0 failed' "$LOG" 2>/dev/null || FAIL=1

if [ "$FAIL" -ne 0 ] && [ -f "$ROOT/.env" ]; then
  TELEGRAM_BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  TELEGRAM_CHAT_ID="$(grep -E '^TELEGRAM_CHAT_ID=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    MSG="⚠️ KYA demo witness FAIL at $STAMP — see logs/growth/demo-witness-latest.txt on server"
    curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=$MSG" >/dev/null 2>&1 || true
  fi
fi

echo "Wrote $LOG (fail=$FAIL)"
exit "$FAIL"
