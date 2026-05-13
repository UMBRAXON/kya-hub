#!/usr/bin/env bash
# ============================================================================
# UMBRAXON KYA-Hub — Strategic Sprint §30 Item 2
# PostgreSQL daily backup: pg_dump -Fc → gzip → AES-256-CBC+HMAC → off-site
# ----------------------------------------------------------------------------
# Uses the SAME BACKUP_PASSPHRASE + on-disk format as Item 1 (channel state).
# Destination is S3-compatible (Cloudflare R2 preferred) with legacy B2 fallback.
# Audit row inserted into backup_log per run.
#
# CLI:
#   scripts/backup-database.sh                # normal run (use from cron)
#   scripts/backup-database.sh --dry-run      # no FS / DB / network writes
#   scripts/backup-database.sh --verbose      # extra logging
#
# Exit codes:
#   0  OK
#   1  FATAL — pg_dump failed or precondition failed
#   2  PARTIAL — encrypted dump on disk, off-site upload failed
#
# Required system packages (install once on the host):
#   apt install -y awscli         # preferred S3 client
#   # OR:
#   apt install -y rclone         # portable fallback
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="$ROOT/.env"

DRY_RUN=0
VERBOSE=0
for a in "$@"; do
    case "$a" in
        --dry-run|--dry) DRY_RUN=1 ;;
        --verbose|-v)    VERBOSE=1 ;;
        --help|-h)       grep -E '^# ' "$0" | head -25; exit 0 ;;
    esac
done

load_env_key() {
    local k="$1"; local v
    v="$(grep -E "^${k}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
    v="${v%$'\r'}"
    v="${v#\"}"; v="${v%\"}"
    v="${v#\'}"; v="${v%\'}"
    printf '%s' "$v"
}
if [[ -f "$ENV_FILE" ]]; then
    BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-$(load_env_key BACKUP_PASSPHRASE)}"
    BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-$(load_env_key BACKUP_S3_ENDPOINT)}"
    BACKUP_S3_REGION="${BACKUP_S3_REGION:-$(load_env_key BACKUP_S3_REGION)}"
    BACKUP_S3_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-$(load_env_key BACKUP_S3_ACCESS_KEY_ID)}"
    BACKUP_S3_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-$(load_env_key BACKUP_S3_SECRET_ACCESS_KEY)}"
    BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-$(load_env_key BACKUP_S3_BUCKET)}"
    BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-$(load_env_key BACKUP_S3_PREFIX)}"
    B2_KEY_ID="${B2_KEY_ID:-$(load_env_key B2_KEY_ID)}"
    B2_APP_KEY="${B2_APP_KEY:-$(load_env_key B2_APP_KEY)}"
    B2_BUCKET="${B2_BUCKET:-$(load_env_key B2_BUCKET)}"
    B2_S3_ENDPOINT="${B2_S3_ENDPOINT:-$(load_env_key B2_S3_ENDPOINT)}"
    BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-$(load_env_key BACKUP_LOCAL_DIR)}"
    BACKUP_HOT_RETENTION_DAYS="${BACKUP_HOT_RETENTION_DAYS:-$(load_env_key BACKUP_HOT_RETENTION_DAYS)}"
    DB_HOST="${DB_HOST:-$(load_env_key DB_HOST)}"
    DB_PORT="${DB_PORT:-$(load_env_key DB_PORT)}"
    DB_USER="${DB_USER:-$(load_env_key DB_USER)}"
    DB_NAME="${DB_NAME:-$(load_env_key DB_NAME)}"
    PGPASSWORD="${PGPASSWORD:-$(load_env_key DB_PASSWORD)}"
    export PGPASSWORD
fi

: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE missing in .env}"
: "${DB_NAME:?DB_NAME missing in .env}"

if [[ ${#BACKUP_PASSPHRASE} -lt 64 ]]; then
    echo "FATAL: BACKUP_PASSPHRASE too short (len=${#BACKUP_PASSPHRASE})" >&2
    exit 1
fi

LOCAL_BACKUP_DIR="${BACKUP_LOCAL_DIR:-/root/backups}/postgres"
HOT_DAYS="${BACKUP_HOT_RETENTION_DAYS:-30}"
TS_UTC="$(date -u +%Y%m%d)"
TS_LONG="$(date -u +%Y%m%dT%H%M%SZ)"
HOSTNAME_OWN="$(hostname -s 2>/dev/null || echo unknown)"
TMPDIR_OWN="$(mktemp -d -t kyahub-db-backup-XXXXXXXX)"
trap 'rm -rf "$TMPDIR_OWN"' EXIT

mkdir -p "$LOCAL_BACKUP_DIR"

log() {
    local lvl="$1"; shift
    local msg="$*"
    printf '{"ts":"%s","level":"%s","component":"backup-database","msg":"%s"}\n' \
        "$(date -u +%FT%TZ)" "$lvl" "${msg//\"/\\\"}"
}
verbose() { [[ "$VERBOSE" == "1" ]] && log debug "$*" || true; }

# Provider detection
# shellcheck source=lib/s3-backup-upload.sh
source "$ROOT/scripts/lib/s3-backup-upload.sh"
s3backup::detect_provider
log info "off-site provider: kind=$PROVIDER_KIND tool=$PROVIDER_TOOL bucket=${PROVIDER_BUCKET:-<none>}"

# --- 1) pg_dump -Fc -> gzip -------------------------------------------------
DUMP_BASE="kyahub-${TS_UTC}.dump.gz"
DUMP_GZ="$TMPDIR_OWN/$DUMP_BASE"
ENC_OUT="$TMPDIR_OWN/${DUMP_BASE}.enc"

log info "starting db backup ts=$TS_LONG db=$DB_NAME"

if [[ "$DRY_RUN" == "1" ]]; then
    log info "[dry-run] would pg_dump -Fc $DB_NAME | gzip -> $DUMP_GZ"
    printf '[dry-run db sentinel %s]\n' "$TS_LONG" | gzip > "$DUMP_GZ"
else
    DUMP_RC=0
    pg_dump --no-owner --no-privileges \
            --format=custom --compress=0 \
            -h "${DB_HOST:-127.0.0.1}" -p "${DB_PORT:-5432}" \
            -U "${DB_USER:?DB_USER missing}" \
            -d "$DB_NAME" \
        | gzip -6 > "$DUMP_GZ" || DUMP_RC=$?
    if [[ "$DUMP_RC" != "0" ]]; then
        log error "pg_dump FAILED rc=$DUMP_RC"
        node -e "
            require('dotenv').config({path:'$ENV_FILE'});
            const n=require('$ROOT/lib/notifications');
            n.notify({category:'critical', title:'KYA-Hub DB backup FAIL', body:'pg_dump exited rc=$DUMP_RC for db=$DB_NAME at $TS_LONG. Check /var/log/kya-db-backup.log.', dedupe_key:'db_backup_fail'}).then(()=>{}).catch(()=>{});
        " 2>/dev/null || true
        exit 1
    fi
fi

RAW_BYTES=$(stat -c%s "$DUMP_GZ" 2>/dev/null || echo 0)
verbose "gz dump bytes=$RAW_BYTES"

# --- 2) AES-256-CBC PBKDF2 + HMAC-SHA256 tail -------------------------------
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass "pass:$BACKUP_PASSPHRASE" \
    -in "$DUMP_GZ" -out "$ENC_OUT.cbc"
HMAC_HEX=$(openssl dgst -sha256 -hmac "$BACKUP_PASSPHRASE" -hex "$ENC_OUT.cbc" \
            | awk '{print $NF}')
cp "$ENC_OUT.cbc" "$ENC_OUT"
printf '%s' "$HMAC_HEX" | xxd -r -p >> "$ENC_OUT"
rm -f "$ENC_OUT.cbc"

ENC_BYTES=$(stat -c%s "$ENC_OUT" 2>/dev/null || echo 0)
SHA256=$(sha256sum "$ENC_OUT" | awk '{print $1}')
log info "artifact built bytes=$ENC_BYTES sha256=$SHA256"

# --- 3) place at local hot path --------------------------------------------
HOT_PATH="$LOCAL_BACKUP_DIR/${DUMP_BASE}.enc"
if [[ "$DRY_RUN" == "1" ]]; then
    log info "[dry-run] would cp $ENC_OUT -> $HOT_PATH"
else
    cp "$ENC_OUT" "$HOT_PATH"
    chmod 600 "$HOT_PATH"
fi

# --- 4) upload to off-site (if configured) ----------------------------------
DESTINATION="local"
REMOTE_URI=""
UPLOAD_OK=1
WARN_MISSING_OFFSITE=0
REL_KEY="db/${DUMP_BASE}.enc"

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
        log warn "off-site backup destination not configured (BACKUP_S3_* or B2_*) — DB backup stays local at $HOT_PATH"
        ;;
esac

# --- 5) prune retention -----------------------------------------------------
if [[ "$DRY_RUN" != "1" ]]; then
    find "$LOCAL_BACKUP_DIR" -type f -name "kyahub-*.dump.gz.enc" -mtime "+$HOT_DAYS" -print -delete \
        2>/dev/null | while IFS= read -r f; do log info "pruned old db artifact $f"; done || true
fi

# --- 6) audit row in backup_log ---------------------------------------------
STATUS="OK"; ERR_MSG=""; EXIT_CODE=0
if [[ "$UPLOAD_OK" == "2" ]]; then
    STATUS="PARTIAL"; ERR_MSG="off-site upload failed; local artifact intact at $HOT_PATH"; EXIT_CODE=2
fi

if [[ "$DRY_RUN" != "1" ]]; then
    METADATA_JSON=$(cat <<EOF
{
  "source_bytes": $RAW_BYTES,
  "encrypted_bytes": $ENC_BYTES,
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
    SHA_ESC="${SHA256//\'/}"
    ERR_ESC="${ERR_MSG//\'/\'\'}"
    META_ESC="${METADATA_JSON//\'/\'\'}"
    HOST_ESC="${HOSTNAME_OWN//\'/\'\'}"
    psql --quiet -h "${DB_HOST:?}" -p "${DB_PORT:?}" -U "${DB_USER:?}" -d "${DB_NAME:?}" \
        -v ON_ERROR_STOP=1 <<EOSQL 2>/dev/null || log error "backup_log insert failed"
SET search_path=public;
INSERT INTO backup_log (backup_kind, object_path, destination, size_bytes, sha256, status, error_message, metadata, host, finished_at)
VALUES (
    'postgres',
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

# --- 7) Telegram alerts -----------------------------------------------------
if [[ "$STATUS" != "OK" && "$DRY_RUN" != "1" ]]; then
    node -e "
        require('dotenv').config({path:'$ENV_FILE'});
        const n=require('$ROOT/lib/notifications');
        n.notify({category:'critical', title:'KYA-Hub DB backup $STATUS', body:'status: $STATUS\\nartifact: $HOT_PATH\\nsize: $ENC_BYTES bytes\\nsha256: $SHA256\\nerror: $ERR_MSG', dedupe_key:'db_backup_$STATUS'}).then(()=>{}).catch(()=>{});
    " 2>/dev/null || true
fi
if [[ "$WARN_MISSING_OFFSITE" == "1" && "$DRY_RUN" != "1" ]]; then
    node -e "
        require('dotenv').config({path:'$ENV_FILE'});
        const n=require('$ROOT/lib/notifications');
        n.notify({category:'warning', title:'DB backup destination: local fallback (off-site backup not configured)', body:'Configure BACKUP_S3_* (Cloudflare R2 / AWS S3 / any S3-compatible) — or legacy B2_* — to off-site DB dumps. Until then they sit on the Hetzner host only.', dedupe_key:'offsite_not_configured'}).then(()=>{}).catch(()=>{});
    " 2>/dev/null || true
fi

log info "done status=$STATUS exit=$EXIT_CODE dest=$DESTINATION provider=$PROVIDER_KIND"
exit "$EXIT_CODE"
