#!/usr/bin/env bash
# Poll registration status + tail hub logs for a given REG-... id.
set -euo pipefail
REG_ID="${1:?Usage: $0 REG-xxxxxxxx}"
BASE_URL="${KYA_HUB_BASE_URL:-https://www.umbraxon.xyz}"
INTERVAL="${2:-5}"

echo "Polling $BASE_URL/api/v1/register/status?registration_id=$REG_ID"
while true; do
  echo "--- $(date -u +%H:%M:%S) ---"
  curl -fsS "${BASE_URL%/}/api/v1/register/status?registration_id=$REG_ID" | python3 -m json.tool || break
  if command -v pm2 >/dev/null 2>&1; then
    pm2 logs kya-hub --nostream --lines 80 2>/dev/null \
      | grep "$REG_ID" | tail -5 || true
  fi
  sleep "$INTERVAL"
done
