#!/bin/bash
# ============================================================================
# UMBRAXON KYA-Hub — DB Backup Script (Phase 2.4 follow-up)
# ============================================================================
# Robí pg_dump kyahub DB do /var/backups/kyahub/ s rotáciou (7 daily, 4 weekly).
# Volaný z cronu raz denne (default 03:15 server time).
#
# Backup formát: PostgreSQL custom (pg_dump -Fc), kompresia level 6.
# Restore:
#   pg_restore -U postgres -d kyahub_restore --clean --if-exists --no-owner backup.dump
#
# Pre-check: musí byť dostatok miesta (≥ 2× DB size).
# Post-check: pri zlyhaní pošle Telegram alert cez lib/notifications.js cez API.
# ============================================================================

set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/kya-hub/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/kyahub}"
LOG_FILE="${BACKUP_LOG:-/var/log/kyahub-backup.log}"
RETAIN_DAILY="${RETAIN_DAILY:-7}"
RETAIN_WEEKLY="${RETAIN_WEEKLY:-4}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DOW="$(date +%u)" # 1=Mon..7=Sun

# Načítaj DB credentials z .env
readEnv() {
    local key="$1"
    grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true
}

DB_NAME="$(readEnv DB_NAME)"
DB_USER="$(readEnv DB_USER)"
DB_HOST="$(readEnv DB_HOST)"
DB_PORT="$(readEnv DB_PORT)"
DB_PASSWORD="$(readEnv DB_PASSWORD)"
TELEGRAM_BOT_TOKEN="$(readEnv TELEGRAM_BOT_TOKEN)"
TELEGRAM_CHAT_ID="$(readEnv TELEGRAM_CHAT_ID)"

: "${DB_NAME:?DB_NAME chýba v $ENV_FILE}"
: "${DB_USER:?DB_USER chýba v $ENV_FILE}"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
chmod 700 "$BACKUP_DIR"

notify() {
    local level="$1"; shift
    local msg="$*"
    echo "[$(date -Is)] $level: $msg"
    if [[ -n "$TELEGRAM_BOT_TOKEN" && -n "$TELEGRAM_CHAT_ID" && "$level" != "INFO" ]]; then
        curl -sS --max-time 5 -X POST \
            "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
            --data-urlencode "text=💾 KYA-Hub backup ${level}: ${msg}" \
            > /dev/null 2>&1 || true
    fi
}

# Pre-flight: voľné miesto
AVAIL_KB="$(df -P "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
DB_SIZE_BYTES="$(PGPASSWORD="$DB_PASSWORD" psql -tA -U "$DB_USER" -h "${DB_HOST:-127.0.0.1}" -p "${DB_PORT:-5432}" -d "$DB_NAME" -c "SELECT pg_database_size('$DB_NAME')")"
DB_SIZE_KB=$(( DB_SIZE_BYTES / 1024 ))
NEEDED_KB=$(( DB_SIZE_KB * 2 ))
if (( AVAIL_KB < NEEDED_KB )); then
    notify "FAIL" "nedostatok miesta: available=${AVAIL_KB}KB needed=${NEEDED_KB}KB"
    exit 2
fi

OUT="$BACKUP_DIR/daily/kyahub_${TIMESTAMP}.dump"
TMP="${OUT}.tmp"

# pg_dump cez postgres user (musí mať superuser práva alebo aspoň owner)
if ! PGPASSWORD="$DB_PASSWORD" pg_dump \
    -U "$DB_USER" -h "${DB_HOST:-127.0.0.1}" -p "${DB_PORT:-5432}" \
    -d "$DB_NAME" \
    -Fc -Z 6 \
    --no-owner --no-privileges \
    -f "$TMP" 2>>"$LOG_FILE"; then
    notify "FAIL" "pg_dump zlyhal — pozri $LOG_FILE"
    rm -f "$TMP"
    exit 3
fi

mv "$TMP" "$OUT"
chmod 600 "$OUT"

# SHA256 checksum (pre integrity check pri obnove)
sha256sum "$OUT" | awk '{print $1}' > "${OUT}.sha256"

SIZE_KB=$(( $(stat -c%s "$OUT") / 1024 ))
notify "INFO" "daily backup OK: ${OUT} (${SIZE_KB} KB)"

# Týždenná kópia (nedeľa = DOW 7) — hard-link na ten istý súbor v daily/
if [[ "$DOW" == "7" ]]; then
    WEEKLY="$BACKUP_DIR/weekly/kyahub_w$(date +%V)_${TIMESTAMP}.dump"
    cp -al "$OUT" "$WEEKLY" 2>/dev/null || cp "$OUT" "$WEEKLY"
    cp "$OUT.sha256" "$WEEKLY.sha256"
    notify "INFO" "weekly snapshot: $WEEKLY"
fi

# Rotácia daily — odstránime všetko staršie ako RETAIN_DAILY
find "$BACKUP_DIR/daily" -maxdepth 1 -name 'kyahub_*.dump*' -type f -mtime "+${RETAIN_DAILY}" -print -delete >> "$LOG_FILE" 2>&1 || true

# Rotácia weekly — odstránime všetko staršie ako RETAIN_WEEKLY * 7 dní
find "$BACKUP_DIR/weekly" -maxdepth 1 -name 'kyahub_*.dump*' -type f -mtime "+$(( RETAIN_WEEKLY * 7 ))" -print -delete >> "$LOG_FILE" 2>&1 || true

# Health summary do logu
TOTAL=$(ls -1 "$BACKUP_DIR/daily" 2>/dev/null | grep -c '\.dump$' || echo 0)
notify "INFO" "rotation done; daily snapshots: $TOTAL"
exit 0
