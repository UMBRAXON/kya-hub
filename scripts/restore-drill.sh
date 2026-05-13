#!/usr/bin/env bash
# ============================================================================
# UMBRAXON KYA-Hub — Quarterly DB-restore drill (Strategic Sprint §31 / A.3)
# ----------------------------------------------------------------------------
# Runs once per quarter under PM2 (`cron_restart: 0 9 1 */3 *`) and verifies
# that the latest off-site DB backup is RESTORABLE *without* performing an
# actual restore against the live database.
#
# Flow:
#   1. List kyahub/db/*.dump.gz.enc on R2 via `aws s3 ls`, take the newest.
#   2. Download to /tmp/restore-drill-<ts>/<basename>
#   3. Verify HMAC-SHA256 tail (last 32 bytes) using BACKUP_PASSPHRASE.
#   4. Strip HMAC → openssl enc -d to recover gzip stream.
#   5. gunzip → custom-format pg_dump file.
#   6. `pg_restore --list` to confirm structural integrity (no actual restore).
#   7. Insert audit row into backup_log with kind='restore_drill'.
#   8. Telegram OK or FAIL.
#   9. Clean up /tmp/restore-drill-*.
#
# Single-shot: PM2 starts us, we exit, PM2 keeps us scheduled for the
# next cron tick. `autorestart: false` in ecosystem.config.js.
#
# Manual trigger (anytime):
#   pm2 trigger kya-restore-drill   # OR run this script directly
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="$ROOT/.env"

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
    DB_HOST="${DB_HOST:-$(load_env_key DB_HOST)}"
    DB_PORT="${DB_PORT:-$(load_env_key DB_PORT)}"
    DB_USER="${DB_USER:-$(load_env_key DB_USER)}"
    DB_NAME="${DB_NAME:-$(load_env_key DB_NAME)}"
    PGPASSWORD="${PGPASSWORD:-$(load_env_key DB_PASSWORD)}"
    export PGPASSWORD
fi

: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE missing in .env}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET missing}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT missing}"

PREFIX_RAW="${BACKUP_S3_PREFIX:-kyahub/}"
PREFIX="${PREFIX_RAW%/}/"   # ensure trailing slash, no leading slash
PREFIX="${PREFIX#/}"

TS_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$(mktemp -d -t restore-drill-XXXXXXXX -p /tmp)"
trap 'rm -rf "$WORK_DIR"; find /tmp -maxdepth 1 -type d -name "restore-drill-*" -mmin +60 -exec rm -rf {} + 2>/dev/null || true' EXIT

log() {
    local lvl="$1"; shift
    printf '{"ts":"%s","level":"%s","component":"restore-drill","msg":"%s"}\n' \
        "$(date -u +%FT%TZ)" "$lvl" "${*//\"/\\\"}"
}

drill_fail() {
    local stage="$1"; local detail="$2"
    log error "FAIL stage=${stage} detail=${detail}"
    audit_insert "FAIL" "${stage}: ${detail}" ""
    telegram_notify "critical" "KYA-Hub restore-drill FAILED" "stage: ${stage}\ndetail: ${detail}\nartifact: ${LATEST_KEY:-?}"
    exit 2
}

telegram_notify() {
    local cat="$1"; local title="$2"; local body="$3"
    node -e "
        require('dotenv').config({path:'$ENV_FILE'});
        const n=require('$ROOT/lib/notifications');
        n.notify({category:'${cat}', title:'${title//\'/\\\'}', body:'${body//\'/\\\'}', dedupe_key:'restore_drill'})
          .then(()=>{}).catch(()=>{});
    " 2>/dev/null || true
}

audit_insert() {
    local status="$1"; local err="$2"; local meta="$3"
    [[ -z "$meta" ]] && meta="{}"
    psql --quiet -h "${DB_HOST:?}" -p "${DB_PORT:?}" -U "${DB_USER:?}" -d "${DB_NAME:?}" \
        -v ON_ERROR_STOP=1 <<EOSQL 2>/dev/null || log warn "backup_log insert skipped"
SET search_path=public;
INSERT INTO backup_log (backup_kind, object_path, destination, size_bytes, sha256, status, error_message, metadata, host, finished_at)
VALUES (
    'restore_drill',
    '${LATEST_KEY:-<unknown>}',
    's3-compat',
    ${ARTIFACT_BYTES:-0},
    '${ARTIFACT_SHA256:-}',
    '${status}',
    NULLIF('${err//\'/\'\'}', ''),
    '${meta//\'/\'\'}'::jsonb,
    '$(hostname -s 2>/dev/null || echo unknown)',
    NOW()
);
EOSQL
}

# --- 0) deps ---------------------------------------------------------------
command -v aws >/dev/null 2>&1 || drill_fail "preflight" "awscli not installed"
command -v openssl >/dev/null 2>&1 || drill_fail "preflight" "openssl not installed"
command -v pg_restore >/dev/null 2>&1 || drill_fail "preflight" "pg_restore not installed"

log info "starting restore drill ts=${TS_UTC} bucket=${BACKUP_S3_BUCKET} prefix=${PREFIX}db/"

# --- 1) latest object via aws s3 ls ----------------------------------------
LS_OUT="$(AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
          AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
          AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
          aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
              s3 ls "s3://${BACKUP_S3_BUCKET}/${PREFIX}db/" 2>&1 || true)"

# Filter: only *.dump.gz.enc files, sort by date desc, take the first.
LATEST_LINE="$(echo "$LS_OUT" | awk '/\.dump\.gz\.enc$/' | sort -k1,2 | tail -n1 || true)"
if [[ -z "$LATEST_LINE" ]]; then
    drill_fail "list" "no *.dump.gz.enc found under s3://${BACKUP_S3_BUCKET}/${PREFIX}db/"
fi

LATEST_NAME="$(echo "$LATEST_LINE" | awk '{print $NF}')"
LATEST_SIZE="$(echo "$LATEST_LINE" | awk '{print $3}')"
LATEST_KEY="${PREFIX}db/${LATEST_NAME}"
log info "latest object=${LATEST_KEY} size=${LATEST_SIZE}"

# --- 2) download -----------------------------------------------------------
LOCAL_ENC="${WORK_DIR}/${LATEST_NAME}"
if ! AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
     AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
     AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
     aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
         s3 cp "s3://${BACKUP_S3_BUCKET}/${LATEST_KEY}" "$LOCAL_ENC" --only-show-errors; then
    drill_fail "download" "aws s3 cp returned non-zero"
fi
ARTIFACT_BYTES="$(stat -c%s "$LOCAL_ENC" 2>/dev/null || echo 0)"
ARTIFACT_SHA256="$(sha256sum "$LOCAL_ENC" | awk '{print $1}')"
log info "downloaded bytes=${ARTIFACT_BYTES} sha256=${ARTIFACT_SHA256}"

# --- 3) verify HMAC-SHA256 tail (32 bytes) ---------------------------------
HMAC_BYTES=32
if (( ARTIFACT_BYTES < (HMAC_BYTES + 16) )); then
    drill_fail "hmac" "artifact too small (${ARTIFACT_BYTES} bytes)"
fi
CIPHER_LEN=$(( ARTIFACT_BYTES - HMAC_BYTES ))
CIPHER_PATH="${WORK_DIR}/cipher.bin"
TAIL_PATH="${WORK_DIR}/hmac.bin"
head -c "$CIPHER_LEN" "$LOCAL_ENC" > "$CIPHER_PATH"
tail -c "$HMAC_BYTES" "$LOCAL_ENC" > "$TAIL_PATH"

GOT_HMAC_HEX="$(openssl dgst -sha256 -hmac "$BACKUP_PASSPHRASE" -hex "$CIPHER_PATH" | awk '{print $NF}')"
EXP_HMAC_HEX="$(xxd -p -c 256 "$TAIL_PATH" | tr -d '\n')"
if [[ "$GOT_HMAC_HEX" != "$EXP_HMAC_HEX" ]]; then
    drill_fail "hmac" "HMAC mismatch — backup may be corrupted or wrong passphrase"
fi
log info "hmac verified"

# --- 4) decrypt + gunzip ---------------------------------------------------
GZ_PATH="${WORK_DIR}/restore.dump.gz"
DUMP_PATH="${WORK_DIR}/restore.dump"
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt \
        -pass "pass:$BACKUP_PASSPHRASE" \
        -in "$CIPHER_PATH" -out "$GZ_PATH" 2>/dev/null; then
    drill_fail "decrypt" "openssl enc -d failed"
fi
if ! gunzip -c "$GZ_PATH" > "$DUMP_PATH"; then
    drill_fail "gunzip" "gunzip failed (gzip stream corrupt?)"
fi
DUMP_BYTES="$(stat -c%s "$DUMP_PATH" 2>/dev/null || echo 0)"
log info "decrypted dump bytes=${DUMP_BYTES}"

# --- 5) pg_restore --list (no actual restore) ------------------------------
LIST_PATH="${WORK_DIR}/restore.list"
if ! pg_restore --list "$DUMP_PATH" > "$LIST_PATH" 2>"${WORK_DIR}/pg_restore.err"; then
    drill_fail "pg_restore-list" "pg_restore --list failed: $(head -1 "${WORK_DIR}/pg_restore.err" || true)"
fi
LIST_LINES="$(wc -l < "$LIST_PATH" | tr -d ' ')"
TABLE_COUNT="$(awk '/TABLE DATA|TABLE /{c++} END{print c+0}' "$LIST_PATH")"
log info "pg_restore --list lines=${LIST_LINES} tables=${TABLE_COUNT}"

if (( TABLE_COUNT < 5 )); then
    drill_fail "pg_restore-list" "implausible table_count=${TABLE_COUNT} (<5)"
fi

# --- 6) audit + telegram ---------------------------------------------------
META_JSON=$(cat <<EOF
{"latest_key":"${LATEST_KEY}","artifact_bytes":${ARTIFACT_BYTES},"dump_bytes":${DUMP_BYTES},"table_count":${TABLE_COUNT},"list_lines":${LIST_LINES},"ts":"${TS_UTC}"}
EOF
)
audit_insert "OK" "" "$META_JSON"

telegram_notify "info" "KYA-Hub restore-drill OK" \
    "ts: ${TS_UTC}\nartifact: ${LATEST_KEY}\nsize: ${ARTIFACT_BYTES} bytes\ndump: ${DUMP_BYTES} bytes\ntables in list: ${TABLE_COUNT}\nstructural integrity: PASS"

log info "drill PASS"
exit 0
