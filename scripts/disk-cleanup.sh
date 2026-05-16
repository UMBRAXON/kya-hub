#!/bin/bash
# ============================================================================
# UMBRAXON KYA-Hub — Safe rotating disk cleanup
# ============================================================================
# Removes caches and stale temp files only. Never touches:
#   - Docker volumes (Bitcoin blocks/chainstate, Postgres, Tor, certs)
#   - /var/backups/kyahub/*
#   - Running Cursor server binary
#   - Application .env / secrets / active PM2 processes
#
# Cron (daily 03:30 UTC, after DB backup):
#   30 3 * * * /root/kya-hub/scripts/disk-cleanup.sh >> /var/log/kyahub-disk-cleanup.log 2>&1
#
# Dry-run:  DRY_RUN=1 /root/kya-hub/scripts/disk-cleanup.sh
# ============================================================================

set -euo pipefail

LOG_FILE="${LOG_FILE:-/var/log/kyahub-disk-cleanup.log}"
DRY_RUN="${DRY_RUN:-0}"
KYA_ROOT="${KYA_ROOT:-/root/kya-hub}"
TMP_MAX_AGE_DAYS="${TMP_MAX_AGE_DAYS:-3}"
ALBY_LOG_MAX_AGE_DAYS="${ALBY_LOG_MAX_AGE_DAYS:-7}"
JOURNAL_MAX_SIZE="${JOURNAL_MAX_SIZE:-150M}"
DISK_WARN_PCT="${DISK_WARN_PCT:-80}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date -Is)] $*" | tee -a "$LOG_FILE"
}

du_bytes() {
    local path="$1"
    if [[ -e "$path" ]]; then
        du -sb "$path" 2>/dev/null | cut -f1 || echo 0
    else
        echo 0
    fi
}

remove_path() {
    local path="$1"
    local label="${2:-$path}"
    [[ -e "$path" ]] || return 0
    local size
    size="$(du_bytes "$path")"
    if [[ "$DRY_RUN" == "1" ]]; then
        log "DRY_RUN would remove ${label} (~$(( size / 1024 / 1024 )) MiB)"
        return 0
    fi
    rm -rf "$path"
    log "removed ${label} (~$(( size / 1024 / 1024 )) MiB)"
}

find_delete_older_than() {
    local dir="$1"
    local days="$2"
    local pattern="${3:-*}"
    [[ -d "$dir" ]] || return 0
    while IFS= read -r -d '' f; do
        remove_path "$f" "$f"
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -name "$pattern" -mtime "+${days}" -print0 2>/dev/null)
}

bytes_used_root() {
    df -B1 / | awk 'NR==2 { print $3 }'
}

log "=== disk-cleanup start (DRY_RUN=${DRY_RUN}) ==="
BEFORE="$(bytes_used_root)"
DISK_PCT="$(df / | awk 'NR==2 { print $5 }' | tr -d '%')"
log "disk / used ${DISK_PCT}% before cleanup"

# --- Temp / IDE caches ---
if [[ -d /tmp/cursor-sandbox-cache ]]; then
    find_delete_older_than /tmp/cursor-sandbox-cache "$TMP_MAX_AGE_DAYS"
    # Empty stale sandbox dirs entirely if disk pressure
    if [[ "$DISK_PCT" -ge "$DISK_WARN_PCT" ]]; then
        for d in /tmp/cursor-sandbox-cache/*; do
            [[ -e "$d" ]] || continue
            remove_path "$d" "cursor-sandbox $(basename "$d")"
        done
    fi
fi
find_delete_older_than /tmp "$TMP_MAX_AGE_DAYS" "shadcn-*"

# --- Old Cursor server installs (keep running + newest) ---
CURSOR_BIN_ROOT="/root/.cursor-server/bin/linux-x64"
if [[ -d "$CURSOR_BIN_ROOT" ]]; then
    ACTIVE_HASH=""
    if pgrep -af 'cursor-server/bin/linux-x64' >/dev/null 2>&1; then
        ACTIVE_HASH="$(pgrep -af 'cursor-server/bin/linux-x64' | head -1 | grep -oE '/linux-x64/[0-9a-f]{40}' | head -1 | sed 's|.*/||' || true)"
    fi
    NEWEST_HASH=""
    NEWEST_MTIME=0
    for d in "$CURSOR_BIN_ROOT"/*/; do
        [[ -d "$d" ]] || continue
        h="$(basename "$d")"
        [[ "$h" =~ ^[0-9a-f]{40}$ ]] || continue
        mtime="$(stat -c %Y "$d" 2>/dev/null || echo 0)"
        if [[ "$mtime" -gt "$NEWEST_MTIME" ]]; then
            NEWEST_MTIME="$mtime"
            NEWEST_HASH="$h"
        fi
    done
    KEEP="$ACTIVE_HASH"
    [[ -n "$KEEP" ]] || KEEP="$NEWEST_HASH"
    for d in "$CURSOR_BIN_ROOT"/*/; do
        [[ -d "$d" ]] || continue
        h="$(basename "$d")"
        [[ "$h" =~ ^[0-9a-f]{40}$ ]] || continue
        [[ "$h" == "$KEEP" ]] && continue
        [[ "$h" == "$NEWEST_HASH" && "$h" != "$KEEP" ]] && continue
        remove_path "$d" "cursor-server $h"
    done
fi

# --- Alby rotated logs (keep current nwc.log) ---
ALBY_LOG_DIR="/root/.local/share/albyhub/log"
if [[ -d "$ALBY_LOG_DIR" ]]; then
    while IFS= read -r -d '' f; do
        remove_path "$f" "$(basename "$f")"
    done < <(find "$ALBY_LOG_DIR" -maxdepth 1 -name 'nwc-*.log' -mtime "+${ALBY_LOG_MAX_AGE_DAYS}" -print0 2>/dev/null)
fi

# --- Package manager caches ---
if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would run apt-get clean"
else
    apt-get clean -y >/dev/null 2>&1 || true
    log "apt-get clean done"
fi
if command -v npm >/dev/null 2>&1; then
    if [[ "$DRY_RUN" == "1" ]]; then
        log "DRY_RUN would run npm cache clean --force"
    else
        npm cache clean --force >/dev/null 2>&1 || true
        log "npm cache clean done"
    fi
fi

# --- systemd journal cap ---
if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would journalctl --vacuum-size=${JOURNAL_MAX_SIZE}"
else
    journalctl --vacuum-size="$JOURNAL_MAX_SIZE" >/dev/null 2>&1 || true
    log "journal vacuum (max ${JOURNAL_MAX_SIZE}) done"
fi

# --- Docker: dangling only (no volumes, no -a) ---
if command -v docker >/dev/null 2>&1; then
    if [[ "$DRY_RUN" == "1" ]]; then
        log "DRY_RUN would run docker system prune -f"
    else
        PRUNE_OUT="$(docker system prune -f 2>&1)" || PRUNE_OUT="prune failed: $?"
        log "docker system prune -f: $(echo "$PRUNE_OUT" | tail -1)"
    fi
fi

# --- Next.js build cache (rebuilt on deploy) ---
remove_path "${KYA_ROOT}/portal/.next/cache" "portal .next/cache"

# --- Python __pycache__ (not inside .venv) ---
if [[ "$DRY_RUN" == "1" ]]; then
    COUNT="$(find "$KYA_ROOT" -path '*/.venv' -prune -o -type d -name '__pycache__' -print 2>/dev/null | wc -l)"
    log "DRY_RUN would remove ${COUNT} __pycache__ dirs under ${KYA_ROOT}"
else
    find "$KYA_ROOT" -path '*/.venv' -prune -o -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
    log "__pycache__ cleanup done under ${KYA_ROOT}"
fi

# --- PM2: drop very old rotated logs if logrotate missed them ---
if [[ -d /root/.pm2/logs ]]; then
    while IFS= read -r -d '' f; do
        remove_path "$f" "pm2 log $(basename "$f")"
    done < <(find /root/.pm2/logs -type f \( -name '*.gz' -o -name '*__20*' \) -mtime +30 -print0 2>/dev/null)
fi

AFTER="$(bytes_used_root)"
FREED=$(( BEFORE - AFTER ))
if [[ "$FREED" -lt 0 ]]; then FREED=0; fi
DISK_PCT_AFTER="$(df / | awk 'NR==2 { print $5 }' | tr -d '%')"
log "disk / used ${DISK_PCT_AFTER}% after cleanup; freed ~$(( FREED / 1024 / 1024 )) MiB"
log "=== disk-cleanup end ==="
