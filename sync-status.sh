#!/bin/bash
# UMBRAXON KYA-Hub — Bitcoin/BTCPay/Lightning Sync Monitor
# Použitie:
#   ./sync-status.sh            # jednorazové zobrazenie
#   ./sync-status.sh --watch    # opakuje každých 30 s (Ctrl+C ukončí)
#   ./sync-status.sh --json     # strojovo čitateľný výstup

set -u

# Farby
G='\033[32m'; R='\033[31m'; Y='\033[33m'; B='\033[36m'; D='\033[2m'; N='\033[0m'

WATCH=0
JSON=0
for arg in "$@"; do
    case "$arg" in
        --watch|-w) WATCH=1 ;;
        --json|-j) JSON=1 ;;
    esac
done

# Historický súbor pre ETA výpočet
HIST=/tmp/kya-sync-history
touch "$HIST"

# Aktuálna výška blockchainu (referenčná z verejného API, fallback na pevné číslo)
get_target_height() {
    local h
    h=$(curl -s --max-time 3 "https://mempool.space/api/blocks/tip/height" 2>/dev/null)
    if [[ -n "$h" && "$h" =~ ^[0-9]+$ ]]; then
        echo "$h"
    else
        # fallback: konzervatívny odhad (aktualizuj manuálne ak by si bol offline)
        echo "870000"
    fi
}

# Aktuálna výška lokálneho bitcoind (parsované z dockerlogov, lebo RPC počas IBD nereaguje)
get_local_height() {
    docker logs --tail 30 btcpayserver_bitcoind 2>&1 \
        | grep -oP 'UpdateTip:.*height=\K\d+' | tail -1
}

# Posledný blok dátum
get_local_date() {
    docker logs --tail 30 btcpayserver_bitcoind 2>&1 \
        | grep -oP "UpdateTip:.*date='\K[^']+" | tail -1
}

# Bitcoind internal sync progress (factor in tx/block density, presnejšie ako height ratio)
get_btcd_progress() {
    docker logs --tail 30 btcpayserver_bitcoind 2>&1 \
        | grep -oP 'UpdateTip:.*progress=\K[0-9.]+' | tail -1
}

# Peer count (RPC môže nereagovať počas IBD, tichý fail)
get_peers() {
    docker exec btcpayserver_bitcoind bitcoin-cli getconnectioncount 2>/dev/null || echo "?"
}

# Lightning node status
get_ln_status() {
    if docker ps --format '{{.Names}}' | grep -qiE "lightning|lnd|cln|alby"; then
        echo "running"
    elif pgrep -f -i "alby|albyhub|lnd|lightningd" >/dev/null 2>&1; then
        echo "running (host)"
    else
        echo "not-running"
    fi
}

# BTCPay reachability
get_btcpay_status() {
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 https://pay.umbraxon.xyz/api/v1/server/info 2>/dev/null)
    [[ "$code" == "200" || "$code" == "401" ]] && echo "up" || echo "down ($code)"
}

print_status() {
    local local_height target_height progress progress_real remaining eta_min peers ln btcpay last_date prev_height prev_ts now_ts blocks_per_min
    local_height=$(get_local_height)
    target_height=$(get_target_height)
    last_date=$(get_local_date)
    peers=$(get_peers)
    ln=$(get_ln_status)
    btcpay=$(get_btcpay_status)
    progress_real=$(get_btcd_progress)

    if [[ -z "$local_height" ]]; then
        echo -e "${R}❌ Nepodarilo sa získať výšku z bitcoind (kontajner beží?)${N}"
        return 1
    fi

    # Height-based percento (zobrazuje pomer blokov)
    progress=$(awk "BEGIN{printf \"%.2f\", $local_height/$target_height*100}")
    # Real progress (bitcoind hodnota — váha podľa tx hustoty, presnejšie pre ETA)
    if [[ -n "$progress_real" ]]; then
        progress_real_pct=$(awk "BEGIN{printf \"%.2f\", $progress_real*100}")
    else
        progress_real_pct="$progress"
    fi
    remaining=$((target_height - local_height))

    # ETA z histórie
    now_ts=$(date +%s)
    read -r prev_height prev_ts < <(tail -1 "$HIST" 2>/dev/null || echo "0 0")
    if [[ "$prev_height" -gt 0 && "$prev_height" != "$local_height" ]]; then
        local diff_h=$((local_height - prev_height))
        local diff_t=$((now_ts - prev_ts))
        if (( diff_t > 0 && diff_h > 0 )); then
            blocks_per_min=$(awk "BEGIN{printf \"%.0f\", $diff_h/$diff_t*60}")
            eta_min=$(awk "BEGIN{printf \"%.0f\", $remaining/$blocks_per_min}")
        fi
    fi
    echo "$local_height $now_ts" >> "$HIST"
    # Trim history > 10 riadkov
    tail -10 "$HIST" > "$HIST.tmp" && mv "$HIST.tmp" "$HIST"

    if (( JSON )); then
        cat <<EOF
{"local_height":$local_height,"target_height":$target_height,"height_percent":$progress,"data_percent":$progress_real_pct,"remaining_blocks":$remaining,"blocks_per_min":${blocks_per_min:-0},"eta_minutes":${eta_min:-null},"peers":"$peers","last_block_date":"$last_date","lightning":"$ln","btcpay":"$btcpay","timestamp":"$(date -Iseconds)"}
EOF
        return 0
    fi

    # Progress bar (založený na data % — presnejší)
    local bar_width=40
    local filled=$(awk "BEGIN{printf \"%.0f\", $progress_real_pct/100*$bar_width}")
    local bar=""
    for ((i=0; i<filled; i++)); do bar+="█"; done
    for ((i=filled; i<bar_width; i++)); do bar+="░"; done

    local color=$R
    if (( $(echo "$progress_real_pct > 95" | bc -l 2>/dev/null || echo 0) )); then color=$G
    elif (( $(echo "$progress_real_pct > 50" | bc -l 2>/dev/null || echo 0) )); then color=$Y
    fi

    echo
    echo -e "${B}━━━ UMBRAXON KYA-Hub Sync Monitor ━━━${N}    ${D}$(date '+%H:%M:%S')${N}"
    echo
    echo -e "  ${color}${bar}${N}  ${color}${progress_real_pct}%${N} ${D}(data)${N} / ${progress}% ${D}(height)${N}"
    echo
    printf "  %-22s ${color}%s${N} / %s\n" "Block height:" "$local_height" "$target_height"
    printf "  %-22s %s blokov\n" "Remaining:" "$remaining"
    [[ -n "$last_date" ]] && printf "  %-22s ${D}%s${N}\n" "Last block:" "$last_date"
    if [[ -n "${blocks_per_min:-}" ]]; then
        printf "  %-22s %s blok/min\n" "Speed:" "$blocks_per_min"
    fi
    if [[ -n "${eta_min:-}" ]]; then
        local h=$((eta_min / 60))
        local m=$((eta_min % 60))
        if (( h > 0 )); then
            printf "  %-22s ${Y}~%sh %sm${N}\n" "ETA:" "$h" "$m"
        else
            printf "  %-22s ${Y}~%sm${N}\n" "ETA:" "$m"
        fi
    fi
    echo
    printf "  %-22s %s\n" "Bitcoin peers:" "$peers"

    # LN status farba
    if [[ "$ln" == "not-running" ]]; then
        printf "  %-22s ${R}%s${N}\n" "Lightning node:" "$ln"
    else
        printf "  %-22s ${G}%s${N}\n" "Lightning node:" "$ln"
    fi

    # BTCPay status farba
    if [[ "$btcpay" == "up" ]]; then
        printf "  %-22s ${G}%s${N}\n" "BTCPay Server:" "$btcpay"
    else
        printf "  %-22s ${R}%s${N}\n" "BTCPay Server:" "$btcpay"
    fi

    # KYA Hub local
    local kya_health
    kya_health=$(curl -s --max-time 2 http://127.0.0.1:3000/api/health 2>/dev/null | head -c 200)
    if [[ -n "$kya_health" ]]; then
        local db_ok btc_ok
        db_ok=$(echo "$kya_health" | grep -oP '"database":"[^"]*' | cut -d'"' -f4)
        btc_ok=$(echo "$kya_health" | grep -oP '"btcpay":"[^"]*' | cut -d'"' -f4)
        printf "  %-22s server=${G}OK${N}  db=%s  btcpay=%s\n" "KYA Hub (local):" "$([[ "$db_ok" == "OK" ]] && echo -e "${G}OK${N}" || echo -e "${R}$db_ok${N}")" "$([[ "$btc_ok" == "OK" ]] && echo -e "${G}OK${N}" || echo -e "${R}$btc_ok${N}")"
    else
        printf "  %-22s ${R}DOWN${N}\n" "KYA Hub (local):"
    fi

    echo
    if (( $(echo "$progress_real_pct < 99.5" | bc -l 2>/dev/null || echo 0) )); then
        echo -e "  ${Y}⚠ Bitcoind ešte nie je synced — onchain platby nebudú confirmované do dosyncu.${N}"
    else
        echo -e "  ${G}✓ Bitcoin synced — platby fungujú.${N}"
    fi
    if [[ "$ln" == "not-running" ]]; then
        echo -e "  ${Y}⚠ Lightning node nebeží — LN platby (LNURL) nepôjdu.${N}"
    fi
    echo
}

if (( WATCH )); then
    while true; do
        clear
        print_status
        sleep 30
    done
else
    print_status
fi
