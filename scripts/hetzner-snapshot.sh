#!/usr/bin/env bash
# ============================================================================
# UMBRAXON KYA-Hub — Hetzner Cloud weekly server snapshot
# ============================================================================
# Creates a Hetzner *image* snapshot of this server via Cloud API, then prunes
# older auto snapshots (label kya-hub-snapshot=auto).
#
# Cost: API calls are free; stored snapshots are billed per GB-month (~€0.012/GB).
#
# Prerequisites (Hetzner Console → Security → API tokens):
#   Read & Write on Servers + Images for the project.
#   Add to /root/kya-hub/.env:
#     HCLOUD_TOKEN=<token>
#
# Cron (Sunday 02:00 server local time):
#   0 2 * * 0 /root/kya-hub/scripts/hetzner-snapshot.sh >> /var/log/kyahub-hetzner-snapshot.log 2>&1
#
# Usage:
#   ./scripts/hetzner-snapshot.sh              # create (if due) + prune
#   ./scripts/hetzner-snapshot.sh --dry-run    # print actions only
#   ./scripts/hetzner-snapshot.sh --prune-only # delete excess, no new snapshot
# ============================================================================

set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/kya-hub/.env}"
LOG_FILE="${SNAPSHOT_LOG:-/var/log/kyahub-hetzner-snapshot.log}"
API_BASE="${HCLOUD_API_URL:-https://api.hetzner.cloud/v1}"
METADATA_URL="${HCLOUD_METADATA_URL:-http://169.254.169.254/hetzner/v1/metadata}"
RETAIN_COUNT="${SNAPSHOT_RETAIN_COUNT:-4}"
LABEL_KEY="${SNAPSHOT_LABEL_KEY:-kya-hub-snapshot}"
LABEL_VALUE="${SNAPSHOT_LABEL_VALUE:-auto}"
MIN_AGE_HOURS="${SNAPSHOT_MIN_AGE_HOURS:-144}" # 6 days — skip 2nd create same week
HCLOUD_BIN="${HCLOUD_BIN:-hcloud}"

DRY_RUN=0
PRUNE_ONLY=0

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --prune-only) PRUNE_ONLY=1 ;;
        -h|--help)
            sed -n '1,22p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

readEnv() {
    local key="$1"
    [[ -f "$ENV_FILE" ]] || { echo ""; return; }
    grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true
}

log() {
    echo "[$(date -Is)] $*"
}

notify_fail() {
    local msg="$*"
    log "FAIL: $msg"
    local token chat
    token="$(readEnv TELEGRAM_BOT_TOKEN)"
    chat="$(readEnv TELEGRAM_CHAT_ID)"
    if [[ -n "$token" && -n "$chat" ]]; then
        curl -sS --max-time 5 -X POST \
            "https://api.telegram.org/bot${token}/sendMessage" \
            --data-urlencode "chat_id=${chat}" \
            --data-urlencode "text=🖥 KYA-Hub Hetzner snapshot FAIL: ${msg}" \
            > /dev/null 2>&1 || true
    fi
}

api_json() {
    local method="$1"
    local path="$2"
    local body="${3:-}"
    local http tmp
    tmp="$(mktemp)"
    if [[ -n "$body" ]]; then
        http="$(curl -sS --max-time 120 -X "$method" "${API_BASE}${path}" \
            -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$body" -o "$tmp" -w "%{http_code}")"
    else
        http="$(curl -sS --max-time 120 -X "$method" "${API_BASE}${path}" \
            -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
            -o "$tmp" -w "%{http_code}")"
    fi
    if [[ "$http" -lt 200 || "$http" -ge 300 ]]; then
        local err
        err="$(jq -r '.error.message // .error.code // .' "$tmp" 2>/dev/null || cat "$tmp")"
        rm -f "$tmp"
        echo "HTTP ${http}: ${err}" >&2
        return 1
    fi
    cat "$tmp"
    rm -f "$tmp"
}

resolve_server_id() {
    local from_env
    from_env="$(readEnv HCLOUD_SERVER_ID)"
    if [[ -n "$from_env" ]]; then
        echo "$from_env"
        return 0
    fi
    curl -sS --max-time 3 "${METADATA_URL}/instance-id" 2>/dev/null || true
}

list_managed_snapshots() {
    local selector="${LABEL_KEY}=${LABEL_VALUE}"
    api_json GET "/images?type=snapshot&label_selector=${selector}&sort=created:desc&per_page=50"
}

recent_snapshot_exists() {
    local now_ts cutoff created created_ts
    now_ts="$(date +%s)"
    cutoff=$(( now_ts - MIN_AGE_HOURS * 3600 ))
    while read -r created; do
        [[ -z "$created" ]] && continue
        created_ts="$(date -d "$created" +%s 2>/dev/null || date -d "${created%%.*}" +%s)"
        if (( created_ts >= cutoff )); then
            return 0
        fi
    done < <(list_managed_snapshots | jq -r '.images[]?.created // empty')
    return 1
}

prune_old_snapshots() {
    local list_json count to_delete id desc protected
    list_json="$(list_managed_snapshots)"
    count="$(echo "$list_json" | jq '.images | length')"
    log "managed snapshots: ${count} (retain ${RETAIN_COUNT})"
    if (( count <= RETAIN_COUNT )); then
        log "prune: nothing to delete"
        return 0
    fi
    to_delete=$(( count - RETAIN_COUNT ))
    echo "$list_json" | jq -r --argjson n "$to_delete" '.images[-$n:][] | [.id, .description, .created] | @tsv' |
        while IFS=$'\t' read -r id desc created; do
            protected="$(api_json GET "/images/${id}" | jq -r '.image.protection.delete // false')"
            if [[ "$protected" == "true" ]]; then
                log "prune: skip image ${id} (delete protection on)"
                continue
            fi
            if (( DRY_RUN )); then
                log "dry-run: would delete image ${id} (${desc}, ${created})"
                continue
            fi
            api_json DELETE "/images/${id}" > /dev/null
            log "prune: deleted image ${id} (${desc})"
        done
}

create_snapshot() {
    local server_id="$1"
    local host desc image_id
    host="$(hostname -s)"
    desc="kya-auto-$(date +%Y%m%d)-${host}"
    if (( DRY_RUN )); then
        log "dry-run: would hcloud server create-image ${server_id} (${desc})"
        return 0
    fi
    if ! command -v "$HCLOUD_BIN" >/dev/null 2>&1; then
        notify_fail "hcloud CLI missing (apt install hcloud-cli)"
        exit 4
    fi
    log "create: starting hcloud server create-image (${desc})"
    local out
    if ! out="$(
        HCLOUD_TOKEN="$HCLOUD_TOKEN" "$HCLOUD_BIN" server create-image "$server_id" \
            --type snapshot \
            --description "$desc" \
            --label "${LABEL_KEY}=${LABEL_VALUE}" \
            --label "hostname=${host}" 2>&1
    )"; then
        notify_fail "hcloud create-image failed: ${out}"
        exit 4
    fi
    image_id="$(sed -n 's/^Image \([0-9][0-9]*\) created.*/\1/p' <<<"$out")"
    log "create: success — ${desc}${image_id:+ (image ${image_id})}"
}

read_token_file() {
    local f="$1"
    [[ -f "$f" ]] || return 1
    tr -d '\n\r' <"$f"
}

read_hcloud_toml_token() {
    local f="${HCLOUD_CONFIG:-/root/.config/hcloud/cli.toml}"
    [[ -f "$f" ]] || return 1
    grep -E '^\s*token\s*=' "$f" | head -n1 | sed -E 's/.*=\s*"([^"]+)".*/\1/; s/.*=\s*([^#[:space:]]+).*/\1/'
}

# --- main ---
HCLOUD_TOKEN="${HCLOUD_TOKEN:-$(readEnv HCLOUD_TOKEN)}"
if [[ -z "$HCLOUD_TOKEN" ]]; then
    HCLOUD_TOKEN="$(readEnv HETZNER_API_TOKEN)"
fi
if [[ -z "$HCLOUD_TOKEN" ]]; then
    HCLOUD_TOKEN="$(read_token_file "${HCLOUD_SECRETS_FILE:-/root/.secrets/hcloud-token}" 2>/dev/null || true)"
fi
if [[ -z "$HCLOUD_TOKEN" ]]; then
    HCLOUD_TOKEN="$(read_hcloud_toml_token 2>/dev/null || true)"
fi
: "${HCLOUD_TOKEN:?HCLOUD_TOKEN missing — run scripts/hetzner-snapshot-setup.sh with a Console API token}"

SERVER_ID="$(resolve_server_id)"
: "${SERVER_ID:?could not resolve server id — set HCLOUD_SERVER_ID in $ENV_FILE or run on Hetzner Cloud}"

log "start host=$(hostname -s) server_id=${SERVER_ID} retain=${RETAIN_COUNT} dry_run=${DRY_RUN} prune_only=${PRUNE_ONLY}"

if (( PRUNE_ONLY )); then
    prune_old_snapshots
    log "done (prune-only)"
    exit 0
fi

if recent_snapshot_exists; then
    log "create: skipped — snapshot younger than ${MIN_AGE_HOURS}h already exists"
else
    create_snapshot "$SERVER_ID"
fi

prune_old_snapshots
log "done"
exit 0
