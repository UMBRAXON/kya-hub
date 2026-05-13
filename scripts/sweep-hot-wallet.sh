#!/bin/bash
# ============================================================================
# UMBRAXON KYA-Hub — Hot Wallet Sweep Trigger (Phase 2.5 payment setup)
# ============================================================================
# Pýta sa BTCPay na onchain balance. Ak je nad prahom, vytvorí payout request
# (PSBT) na cold/warm wallet a pošle Telegram alert s odkazom do BTCPay UI
# kde administrátor manuálne podpíše PSBT cez hardware wallet (alebo Sparrow).
#
# Beží z cronu (default každú hodinu, len v pracovných časoch).
# Manuálny test: `bash scripts/sweep-hot-wallet.sh --dry-run`
# ============================================================================

set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/kya-hub/.env}"
LOG_FILE="${LOG_FILE:-/var/log/kyahub-sweep.log}"
STATE_FILE="${STATE_FILE:-/var/lib/kyahub-sweep.state}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

readEnv() {
    grep -E "^${1}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true
}

BTCPAY_URL="$(readEnv BTCPAY_URL)"
BTCPAY_STORE_ID="$(readEnv BTCPAY_STORE_ID)"
BTCPAY_API_KEY="$(readEnv BTCPAY_API_KEY)"
TELEGRAM_BOT_TOKEN="$(readEnv TELEGRAM_BOT_TOKEN)"
TELEGRAM_CHAT_ID="$(readEnv TELEGRAM_CHAT_ID)"

# Prahy (override-able v .env)
SWEEP_THRESHOLD_SATS="$(readEnv SWEEP_THRESHOLD_SATS)"
SWEEP_THRESHOLD_SATS="${SWEEP_THRESHOLD_SATS:-50000}"   # 50 000 SAT default
SWEEP_KEEP_HOT_SATS="$(readEnv SWEEP_KEEP_HOT_SATS)"
SWEEP_KEEP_HOT_SATS="${SWEEP_KEEP_HOT_SATS:-10000}"    # ponechaj 10 000 SAT v hot pre fees
SWEEP_DESTINATION="$(readEnv SWEEP_DESTINATION_ADDRESS)"   # bc1q... cold/warm receive
SWEEP_PAYOUT_METHOD="${SWEEP_PAYOUT_METHOD:-BTC-CHAIN}"
SWEEP_COOLDOWN_HOURS="${SWEEP_COOLDOWN_HOURS:-24}"

log() {
    local lvl="$1"; shift
    local ts; ts="$(date -Is)"
    echo "[$ts] $lvl: $*" | tee -a "$LOG_FILE"
}

notify() {
    local emoji="$1"; shift
    local msg="$*"
    if [[ -n "$TELEGRAM_BOT_TOKEN" && -n "$TELEGRAM_CHAT_ID" ]]; then
        curl -sS --max-time 5 -X POST \
            "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
            --data-urlencode "text=${emoji} <b>KYA-Hub sweep</b>%0A${msg}" \
            --data-urlencode "parse_mode=HTML" \
            > /dev/null 2>&1 || true
    fi
}

if [[ -z "$BTCPAY_URL" || -z "$BTCPAY_STORE_ID" || -z "$BTCPAY_API_KEY" ]]; then
    log "FATAL" "BTCPAY_URL / BTCPAY_STORE_ID / BTCPAY_API_KEY chýbajú v $ENV_FILE"
    exit 2
fi

if [[ -z "$SWEEP_DESTINATION" ]]; then
    log "INFO" "SWEEP_DESTINATION_ADDRESS nie je nastavená — sweep skipnut\u00fd."
    log "INFO" "Postup: vygeneruj cold wallet → node scripts/gen-cold-wallet.js"
    log "INFO" "        a do .env pridaj SWEEP_DESTINATION_ADDRESS=<bc1q...>"
    exit 0
fi

# Pre-check: cooldown
if [[ -f "$STATE_FILE" ]]; then
    LAST_TS=$(cat "$STATE_FILE" 2>/dev/null || echo "0")
    NOW=$(date +%s)
    DIFF=$(( (NOW - LAST_TS) / 3600 ))
    if (( DIFF < SWEEP_COOLDOWN_HOURS )); then
        log "INFO" "cooldown active (${DIFF}/${SWEEP_COOLDOWN_HOURS}h) — skip"
        exit 0
    fi
fi

# Fetch onchain balance
BAL_RESPONSE=$(curl -sS -k --max-time 10 \
    -H "Authorization: token $BTCPAY_API_KEY" \
    "$BTCPAY_URL/api/v1/stores/$BTCPAY_STORE_ID/payment-methods/onchain/BTC/wallet" 2>&1) || {
    log "ERROR" "BTCPay API unreachable"
    exit 1
}

if echo "$BAL_RESPONSE" | grep -q "missingPermission"; then
    log "ERROR" "BTCPay API key nemá permission btcpay.store.canmodifystoresettings"
    log "ERROR" "Vygeneruj nový kľúč: BTCPay UI → Account → API Keys → 'Full access for store'"
    notify "🚨" "Sweep skipnutý — BTCPay API key má nedostatočné permissions"
    exit 3
fi

BALANCE_BTC=$(echo "$BAL_RESPONSE" | jq -r '.balance // 0')
UNCONF_BTC=$(echo "$BAL_RESPONSE" | jq -r '.unconfirmedBalance // 0')
BALANCE_SATS=$(awk "BEGIN { printf \"%.0f\", $BALANCE_BTC * 100000000 }")
UNCONF_SATS=$(awk "BEGIN { printf \"%.0f\", $UNCONF_BTC * 100000000 }")

log "INFO" "hot wallet: confirmed=${BALANCE_SATS} unconfirmed=${UNCONF_SATS} threshold=${SWEEP_THRESHOLD_SATS}"

if (( BALANCE_SATS < SWEEP_THRESHOLD_SATS )); then
    log "INFO" "below threshold — no sweep"
    exit 0
fi

SWEEP_AMOUNT_SATS=$(( BALANCE_SATS - SWEEP_KEEP_HOT_SATS ))
SWEEP_AMOUNT_BTC=$(awk "BEGIN { printf \"%.8f\", $SWEEP_AMOUNT_SATS / 100000000 }")

if $DRY_RUN; then
    log "DRY_RUN" "would sweep ${SWEEP_AMOUNT_SATS} SAT (${SWEEP_AMOUNT_BTC} BTC) → $SWEEP_DESTINATION"
    notify "🧪" "DRY RUN: would sweep <b>${SWEEP_AMOUNT_SATS} SAT</b> → <code>${SWEEP_DESTINATION:0:20}...</code>"
    exit 0
fi

# Create payout request v BTCPay (pull-payment + auto-payout)
PAYOUT_RESPONSE=$(curl -sS -k --max-time 15 -X POST \
    -H "Authorization: token $BTCPAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
        --arg dest "$SWEEP_DESTINATION" \
        --arg amount "$SWEEP_AMOUNT_BTC" \
        --arg method "$SWEEP_PAYOUT_METHOD" \
        '{destination:$dest, amount:$amount, payoutMethodId:$method, approved:false}')" \
    "$BTCPAY_URL/api/v1/stores/$BTCPAY_STORE_ID/payouts" 2>&1) || {
    log "ERROR" "payout creation failed"
    notify "🚨" "Sweep payout creation failed (API call)"
    exit 4
}

PAYOUT_ID=$(echo "$PAYOUT_RESPONSE" | jq -r '.id // empty')
if [[ -z "$PAYOUT_ID" ]]; then
    log "ERROR" "no payout ID in response: $(echo $PAYOUT_RESPONSE | head -c 300)"
    notify "🚨" "Sweep failed: BTCPay returned no payout ID"
    exit 5
fi

# Cooldown timestamp
mkdir -p "$(dirname "$STATE_FILE")"
date +%s > "$STATE_FILE"

log "OK" "payout created id=$PAYOUT_ID amount=${SWEEP_AMOUNT_SATS} SAT"
notify "💰" "Sweep ready for signature\namount: <b>${SWEEP_AMOUNT_SATS} SAT</b>\ndest: <code>${SWEEP_DESTINATION:0:20}...${SWEEP_DESTINATION: -10}</code>\npayout id: <code>${PAYOUT_ID}</code>\n→ Approve manually: ${BTCPAY_URL}/stores/${BTCPAY_STORE_ID}/payouts"

exit 0
