#!/usr/bin/env bash
# ============================================================================
# UMBRAXON KYA-Hub — Strategic Sprint §30 Item 1
# Off-Hetzner encrypted backup for Lightning channel state (Alby Hub LDK + SCB)
# ----------------------------------------------------------------------------
# Source:      /root/kya-hub/albyhub/workdir/{ldk,nwc.db,nwc.db-shm,nwc.db-wal}
# Encryption:  AES-256-CBC PBKDF2 (200k iter) + HMAC-SHA256 tail (encrypt-then-MAC).
#              Client-side, keyed off BACKUP_PASSPHRASE (.env, 64-hex / 32 bytes).
#              See docs/RESTORE-PROCEDURES.md §1 for the on-disk format.
# Destination: S3-compatible bucket (PREFERRED) → Backblaze B2 legacy → local.
#              Cloudflare R2 is the default operator choice; any provider
#              that speaks S3 v4 signing works (AWS S3, MinIO, DigitalOcean
#              Spaces, Wasabi, ...). Switch providers by changing env vars
#              only — no code change required.
# Audit:       insert one row into `backup_log` per run (uses psql).
# Retention:   hot (local, 30 days). Cold retention is enforced by the
#              bucket's lifecycle policy — see scripts/lib/s3-backup-upload.sh
#              top-of-file comments for the recommended R2 lifecycle config.
# Frequency:   hourly via cron (operator installs the crontab line, see docs).
#
# Exit codes:
#   0  OK (uploaded off-site OR local-only fallback)
#   1  FATAL — couldn't even build the encrypted artifact
#   2  PARTIAL — local artifact built, off-site upload failed (still alarms)
#
# CLI:
#   scripts/backup-channel-state.sh             # normal run
#   scripts/backup-channel-state.sh --dry-run   # no FS / DB / network writes
#   scripts/backup-channel-state.sh --verbose   # extra logging
#
# Required system packages (install once on the host):
#   apt install -y awscli                      # preferred S3 client
#   # OR (more portable single-binary fallback):
#   apt install -y rclone
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# --- 0) parse args ----------------------------------------------------------
DRY_RUN=0
VERBOSE=0
for a in "$@"; do
    case "$a" in
        --dry-run|--dry) DRY_RUN=1 ;;
        --verbose|-v)    VERBOSE=1 ;;
        --help|-h)       grep -E '^# ' "$0" | head -40; exit 0 ;;
    esac
done

# --- 1) load .env (only the keys we need; tolerant of values with spaces) ---
ENV_FILE="$ROOT/.env"
load_env_key() {
    local k="$1"
    local v
    v="$(grep -E "^${k}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
    v="${v%$'\r'}"
    v="${v#\"}"; v="${v%\"}"
    v="${v#\'}"; v="${v%\'}"
    printf '%s' "$v"
}

if [[ -f "$ENV_FILE" ]]; then
    BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-$(load_env_key BACKUP_PASSPHRASE)}"
    # S3-compatible (preferred)
    BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-$(load_env_key BACKUP_S3_ENDPOINT)}"
    BACKUP_S3_REGION="${BACKUP_S3_REGION:-$(load_env_key BACKUP_S3_REGION)}"
    BACKUP_S3_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-$(load_env_key BACKUP_S3_ACCESS_KEY_ID)}"
    BACKUP_S3_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-$(load_env_key BACKUP_S3_SECRET_ACCESS_KEY)}"
    BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-$(load_env_key BACKUP_S3_BUCKET)}"
    BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-$(load_env_key BACKUP_S3_PREFIX)}"
    # Legacy B2 fallback (only used if BACKUP_S3_* unset)
    B2_KEY_ID="${B2_KEY_ID:-$(load_env_key B2_KEY_ID)}"
    B2_APP_KEY="${B2_APP_KEY:-$(load_env_key B2_APP_KEY)}"
    B2_BUCKET="${B2_BUCKET:-$(load_env_key B2_BUCKET)}"
    B2_S3_ENDPOINT="${B2_S3_ENDPOINT:-$(load_env_key B2_S3_ENDPOINT)}"
    BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-$(load_env_key BACKUP_LOCAL_DIR)}"
    BACKUP_HOT_RETENTION_DAYS="${BACKUP_HOT_RETENTION_DAYS:-$(load_env_key BACKUP_HOT_RETENTION_DAYS)}"
    BACKUP_COLD_RETENTION_DAYS="${BACKUP_COLD_RETENTION_DAYS:-$(load_env_key BACKUP_COLD_RETENTION_DAYS)}"
    ALBY_DATA_DIR="${ALBY_DATA_DIR:-$(load_env_key ALBY_DATA_DIR)}"
    DB_HOST="${DB_HOST:-$(load_env_key DB_HOST)}"
    DB_PORT="${DB_PORT:-$(load_env_key DB_PORT)}"
    DB_USER="${DB_USER:-$(load_env_key DB_USER)}"
    DB_NAME="${DB_NAME:-$(load_env_key DB_NAME)}"
    PGPASSWORD="${PGPASSWORD:-$(load_env_key DB_PASSWORD)}"
    export PGPASSWORD
fi

: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE not set in .env — refusing to back up without encryption}"

# Length sanity (must be 64 hex chars / 32 raw bytes for AES-256)
if [[ ${#BACKUP_PASSPHRASE} -lt 64 ]]; then
    echo "FATAL: BACKUP_PASSPHRASE looks too short (len=${#BACKUP_PASSPHRASE}). Expected 64 hex chars (32 raw bytes)." >&2
    exit 1
fi

ALBY_DATA_DIR="${ALBY_DATA_DIR:-/root/kya-hub/albyhub/workdir}"
LOCAL_BACKUP_DIR="${BACKUP_LOCAL_DIR:-/root/backups}/lightning_channel"
HOT_DAYS="${BACKUP_HOT_RETENTION_DAYS:-30}"
COLD_DAYS="${BACKUP_COLD_RETENTION_DAYS:-365}"
TS_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
HOSTNAME_OWN="$(hostname -s 2>/dev/null || echo unknown)"
TMPDIR_OWN="$(mktemp -d -t kyahub-chan-backup-XXXXXXXX)"
trap 'rm -rf "$TMPDIR_OWN"' EXIT

mkdir -p "$LOCAL_BACKUP_DIR"

log() {
    local lvl="$1"; shift
    local msg="$*"
    printf '{"ts":"%s","level":"%s","component":"backup-channel-state","msg":"%s"}\n' \
        "$(date -u +%FT%TZ)" "$lvl" "${msg//\"/\\\"}"
}

verbose() { [[ "$VERBOSE" == "1" ]] && log debug "$*" || true; }

# --- 2) verify source paths -------------------------------------------------
if [[ ! -d "$ALBY_DATA_DIR" ]]; then
    log error "alby data dir missing: $ALBY_DATA_DIR"
    exit 1
fi

# --- 3) load shared S3 upload helper + detect provider ---------------------
# shellcheck source=lib/s3-backup-upload.sh
source "$ROOT/scripts/lib/s3-backup-upload.sh"
s3backup::detect_provider
log info "off-site provider: kind=$PROVIDER_KIND tool=$PROVIDER_TOOL bucket=${PROVIDER_BUCKET:-<none>}"

# --- 4) build encrypted artifact --------------------------------------------
RAW_TAR="$TMPDIR_OWN/channel-state-$TS_UTC.tar.gz"
ENC_OUT="$TMPDIR_OWN/channel-state-$TS_UTC.tar.gz.enc"

log info "starting backup ts=$TS_UTC source=$ALBY_DATA_DIR"

# Best-effort tar; ignore "file changed while reading" because nwc.db-wal is hot
TAR_RC=0
if [[ "$DRY_RUN" == "1" ]]; then
    log info "[dry-run] would tar $ALBY_DATA_DIR -> $RAW_TAR"
    # In dry-run, create a small sentinel file so the rest of the pipeline
    # has something to encrypt + hash. The encryption step is also skipped
    # below, but downstream stats / SQL still want a non-zero size.
    printf '[dry-run sentinel %s]\n' "$TS_UTC" > "$RAW_TAR"
else
    (cd "$ALBY_DATA_DIR" && tar --warning=no-file-changed -czf "$RAW_TAR" . ) || TAR_RC=$?
    if [[ "$TAR_RC" -gt 1 ]]; then
        log error "tar FAILED rc=$TAR_RC"
        exit 1
    fi
    if [[ "$TAR_RC" == "1" ]]; then
        log info "tar rc=1 (files changed during read — acceptable for hot sqlite WAL)"
    fi
fi

RAW_BYTES=$(stat -c%s "$RAW_TAR" 2>/dev/null || echo 0)
verbose "raw tar bytes=$RAW_BYTES"

# AES-256-CBC PBKDF2 + HMAC-SHA256 tail (encrypt-then-MAC). Format on disk:
#   [openssl "Salted__" magic + 8B salt + AES-CBC ciphertext][32B HMAC-SHA256(pp, ciphertext)]
# Decryption: docs/RESTORE-PROCEDURES.md §1.
if [[ "$DRY_RUN" == "1" ]]; then
    log info "[dry-run] would encrypt -> $ENC_OUT"
    # Produce a small encrypted sentinel so downstream sha256 / upload-shape
    # checks have something real to operate on.
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
        -pass "pass:$BACKUP_PASSPHRASE" \
        -in "$RAW_TAR" -out "$ENC_OUT.cbc"
    HMAC_HEX=$(openssl dgst -sha256 -hmac "$BACKUP_PASSPHRASE" -hex "$ENC_OUT.cbc" | awk '{print $NF}')
    cp "$ENC_OUT.cbc" "$ENC_OUT"
    printf '%s' "$HMAC_HEX" | xxd -r -p >> "$ENC_OUT"
    rm -f "$ENC_OUT.cbc"
else
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
        -pass "pass:$BACKUP_PASSPHRASE" \
        -in "$RAW_TAR" -out "$ENC_OUT.cbc"
    HMAC_HEX=$(openssl dgst -sha256 -hmac "$BACKUP_PASSPHRASE" -hex "$ENC_OUT.cbc" \
                | awk '{print $NF}')
    cp "$ENC_OUT.cbc" "$ENC_OUT"
    printf '%s' "$HMAC_HEX" | xxd -r -p >> "$ENC_OUT"
    rm -f "$ENC_OUT.cbc"
fi

ENC_BYTES=$(stat -c%s "$ENC_OUT" 2>/dev/null || echo 0)
SHA256=$(sha256sum "$ENC_OUT" | awk '{print $1}')
log info "artifact built bytes=$ENC_BYTES sha256=$SHA256"

# --- 5) place artifact at local hot location --------------------------------
HOT_PATH="$LOCAL_BACKUP_DIR/channel-state-$TS_UTC.tar.gz.enc"
if [[ "$DRY_RUN" == "1" ]]; then
    log info "[dry-run] would cp $ENC_OUT -> $HOT_PATH"
else
    cp "$ENC_OUT" "$HOT_PATH"
    chmod 600 "$HOT_PATH"
fi

# --- 6) upload to off-site (if configured) ----------------------------------
DESTINATION="local"
REMOTE_URI=""
UPLOAD_OK=1            # 1 = not attempted, 0 = ok, 2 = failed
WARN_MISSING_OFFSITE=0
REL_KEY="lightning_channel/channel-state-${HOSTNAME_OWN}-${TS_UTC}.tar.gz.enc"

case "$PROVIDER_KIND" in
    s3-compat|b2-legacy)
        if [[ "$DRY_RUN" == "1" ]]; then
            log info "[dry-run] would upload via $PROVIDER_TOOL to $PROVIDER_KIND key=$REL_KEY"
            DESTINATION="${PROVIDER_KIND}+local"
            REMOTE_URI="dry-run://${PROVIDER_BUCKET}/${PROVIDER_PREFIX}${REL_KEY}"
        elif [[ "$PROVIDER_TOOL" == "missing" || "$PROVIDER_TOOL" == "none" ]]; then
            log error "off-site provider configured ($PROVIDER_KIND) but no upload tool installed (install awscli OR rclone)"
            UPLOAD_OK=2
        else
            s3backup::upload "$HOT_PATH" "$REL_KEY"
            if [[ "$UPLOAD_RC" == "0" ]]; then
                DESTINATION="${PROVIDER_KIND}+local"
                REMOTE_URI="$UPLOAD_URI"
                UPLOAD_OK=0
            else
                log error "off-site upload FAILED: $UPLOAD_ERR"
                UPLOAD_OK=2
            fi
        fi
        ;;
    none)
        WARN_MISSING_OFFSITE=1
        log warn "off-site backup destination not configured (BACKUP_S3_* or B2_*) — falling back to local /root/backups/"
        ;;
esac

# --- 7) prune retention -----------------------------------------------------
if [[ "$DRY_RUN" != "1" ]]; then
    find "$LOCAL_BACKUP_DIR" -type f -name "channel-state-*.tar.gz.enc" -mtime "+$HOT_DAYS" -print -delete \
        2>/dev/null | while IFS= read -r f; do log info "pruned local hot artifact $f"; done || true
fi

# --- 8) audit row in backup_log ---------------------------------------------
STATUS="OK"
ERR_MSG=""
EXIT_CODE=0
if [[ "$UPLOAD_OK" == "2" ]]; then
    STATUS="PARTIAL"
    ERR_MSG="off-site upload failed; local artifact intact at $HOT_PATH"
    EXIT_CODE=2
fi

if [[ "$DRY_RUN" != "1" ]]; then
    METADATA_JSON=$(cat <<EOF
{
  "source_bytes": $RAW_BYTES,
  "encrypted_bytes": $ENC_BYTES,
  "tar_rc": $TAR_RC,
  "hot_path": "$HOT_PATH",
  "provider_kind": "$PROVIDER_KIND",
  "provider_tool": "$PROVIDER_TOOL",
  "remote_uri": "$REMOTE_URI",
  "warn_missing_offsite": $([ $WARN_MISSING_OFFSITE = 1 ] && echo true || echo false)
}
EOF
)
    HOT_PATH_ESC="${HOT_PATH//\'/\'\'}"
    DEST_ESC="${DESTINATION//\'/\'\'}"
    REMOTE_ESC="${REMOTE_URI//\'/\'\'}"
    SHA_ESC="${SHA256//\'/}"
    ERR_ESC="${ERR_MSG//\'/\'\'}"
    META_ESC="${METADATA_JSON//\'/\'\'}"
    HOST_ESC="${HOSTNAME_OWN//\'/\'\'}"
    psql --quiet -h "${DB_HOST:?}" -p "${DB_PORT:?}" -U "${DB_USER:?}" -d "${DB_NAME:?}" \
        -v ON_ERROR_STOP=1 \
        <<EOSQL 2>/dev/null || log error "backup_log insert failed (continuing)"
SET search_path=public;
INSERT INTO backup_log (backup_kind, object_path, destination, size_bytes, sha256, status, error_message, metadata, host, finished_at)
VALUES (
    'lightning_channel',
    '$HOT_PATH_ESC',
    '$DEST_ESC',
    $ENC_BYTES,
    '$SHA_ESC',
    '$STATUS',
    NULLIF('$ERR_ESC', ''),
    '$META_ESC'::jsonb,
    '$HOST_ESC',
    NOW()
);
EOSQL
fi

# --- 9) Telegram alerts on failure / partial / missing-offsite --------------
NOTIFY_BODY=""
if [[ "$STATUS" != "OK" ]]; then
    NOTIFY_BODY="status: $STATUS\nartifact: $HOT_PATH\nsize: $ENC_BYTES bytes\nsha256: $SHA256\nerror: $ERR_MSG"
fi

if [[ -n "$NOTIFY_BODY" && "$DRY_RUN" != "1" ]]; then
    node -e "
        require('dotenv').config({path:'$ENV_FILE'});
        const n=require('$ROOT/lib/notifications');
        n.notify({category:'critical', title:'Lightning channel backup $STATUS', body:'$NOTIFY_BODY', dedupe_key:'channel_backup_$STATUS'}).then(()=>{}).catch(()=>{});
    " 2>/dev/null || true
fi

if [[ "$WARN_MISSING_OFFSITE" == "1" && "$DRY_RUN" != "1" ]]; then
    node -e "
        require('dotenv').config({path:'$ENV_FILE'});
        const n=require('$ROOT/lib/notifications');
        n.notify({category:'warning', title:'Backup destination: local fallback (off-site backup not configured)', body:'Configure BACKUP_S3_* (Cloudflare R2 / AWS S3 / any S3-compatible) — or the legacy B2_* set — in .env to activate off-Hetzner backups. Until then, channel backups land at $LOCAL_BACKUP_DIR/ only.', dedupe_key:'offsite_not_configured'}).then(()=>{}).catch(()=>{});
    " 2>/dev/null || true
fi

log info "done status=$STATUS exit=$EXIT_CODE dest=$DESTINATION provider=$PROVIDER_KIND"
exit "$EXIT_CODE"
