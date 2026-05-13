#!/bin/bash
# ============================================================================
# UMBRAXON KYA-Hub — Health Alert Script
# ============================================================================
# Volá GET /api/admin/system-health a píše alerty do /var/log/kyahub-health.log
# Pri "critical" stave podpíše dodatočný marker do /tmp/kyahub-critical.flag
# tak, že každý ďalší beh môže rozpoznať trvajúci incident.
#
# Cron príklad (každých 5 min):
#   */5 * * * * /root/kya-hub/scripts/health-alert.sh >> /var/log/kyahub-health.log 2>&1
#
# Voliteľne: WEBHOOK_URL pre Telegram/Slack/etc.
# ============================================================================

set -euo pipefail

# Pri cron behu netreba dediť shell HUB_URL (môže byť externá Hub URL s HTTPS) —
# Health endpoint je interný a vždy lokálny, takže preferujeme loopback.
HUB_URL="${HUB_URL_OVERRIDE:-http://127.0.0.1:3000}"
ENV_FILE="${ENV_FILE:-/root/kya-hub/.env}"
LOG_FILE="${LOG_FILE:-/var/log/kyahub-health.log}"
FLAG_FILE="/tmp/kyahub-critical.flag"

# Načítaj credentials z .env (read-only)
readEnv() {
    local key="$1"
    [[ -f "$ENV_FILE" ]] || { echo ""; return; }
    grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true
}

ADMIN_KEY="$(readEnv ADMIN_API_KEY)"
TELEGRAM_BOT_TOKEN="$(readEnv TELEGRAM_BOT_TOKEN)"
TELEGRAM_CHAT_ID="$(readEnv TELEGRAM_CHAT_ID)"
DISCORD_WEBHOOK_URL="$(readEnv DISCORD_WEBHOOK_URL)"

if [[ -z "$ADMIN_KEY" ]]; then
    echo "[$(date -Is)] ERROR: ADMIN_API_KEY missing in $ENV_FILE"
    exit 2
fi

# Spoločná notifikačná funkcia — pošle správu na všetky nakonfigurované kanály.
sendNotification() {
    local message="$1"
    # Telegram
    if [[ -n "$TELEGRAM_BOT_TOKEN" && -n "$TELEGRAM_CHAT_ID" ]]; then
        curl -sS --max-time 5 -X POST \
            "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
            --data-urlencode "text=${message}" \
            --data-urlencode "parse_mode=HTML" \
            > /dev/null 2>&1 || echo "[$(date -Is)] telegram send FAIL"
    fi
    # Discord
    if [[ -n "$DISCORD_WEBHOOK_URL" ]]; then
        local payload
        payload=$(jq -n --arg c "$message" '{content: $c}')
        curl -sS --max-time 5 -X POST -H "Content-Type: application/json" \
            -d "$payload" "$DISCORD_WEBHOOK_URL" > /dev/null 2>&1 \
            || echo "[$(date -Is)] discord send FAIL"
    fi
}

# Fetch
HTTP_CODE=$(curl -sS -o /tmp/.kyahub-health.json -w "%{http_code}" \
    -H "X-Admin-Key: $ADMIN_KEY" \
    "$HUB_URL/api/admin/system-health" || echo "000")

if [[ "$HTTP_CODE" != "200" ]]; then
    echo "[$(date -Is)] hub_unreachable http_code=$HTTP_CODE"
    sendNotification "<b>KYA-Hub UNREACHABLE</b>%0AHTTP $HTTP_CODE @ $(hostname)"
    exit 1
fi

STATUS=$(jq -r '.status' /tmp/.kyahub-health.json 2>/dev/null || echo "?")
DISK_PCT=$(jq -r '.disk.percent_used // "?"' /tmp/.kyahub-health.json)
RAM_PCT=$(jq -r '.ram.percent_used // "?"' /tmp/.kyahub-health.json)
LOAD1=$(jq -r '.load.load1 // "?"' /tmp/.kyahub-health.json)
ALERTS=$(jq -r '.alerts // [] | map("- " + .level + " " + .kind + ": " + .message) | join("\n")' /tmp/.kyahub-health.json)
ALERTS_JSON=$(jq -c '.alerts // []' /tmp/.kyahub-health.json)

echo "[$(date -Is)] status=$STATUS disk=${DISK_PCT}% ram=${RAM_PCT}% load1=$LOAD1 alerts=$ALERTS_JSON"

case "$STATUS" in
    critical)
        if [[ ! -f "$FLAG_FILE" ]]; then
            echo "[$(date -Is)] NEW_CRITICAL alerts=$ALERTS_JSON"
            MSG="🚨 <b>KYA-Hub CRITICAL</b>
host: $(hostname)
disk: ${DISK_PCT}%   ram: ${RAM_PCT}%   load1: ${LOAD1}
${ALERTS}"
            sendNotification "$MSG"
            touch "$FLAG_FILE"
        fi
        ;;
    warning)
        # tichý warning — len log
        ;;
    ok)
        if [[ -f "$FLAG_FILE" ]]; then
            echo "[$(date -Is)] CRITICAL_RESOLVED"
            sendNotification "✅ <b>KYA-Hub recovered</b>
host: $(hostname) → status OK
disk: ${DISK_PCT}%   ram: ${RAM_PCT}%   load1: ${LOAD1}"
            rm -f "$FLAG_FILE"
        fi
        ;;
esac

exit 0
