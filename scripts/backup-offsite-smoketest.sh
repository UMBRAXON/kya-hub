#!/usr/bin/env bash
# ============================================================================
# UMBRAXON KYA-Hub — Off-site backup smoke test (R2 / S3-compatible)
# ----------------------------------------------------------------------------
# Purpose:
#   Quick, low-risk verification that BACKUP_S3_* credentials have enough
#   permissions to upload objects to the bucket/prefix used by backups.
#
# What it does:
#   - Detect provider via scripts/lib/s3-backup-upload.sh (same logic as backups)
#   - Creates a small encrypted-like probe file (no secrets)
#   - PUT (upload) → LIST → GET (download) → DELETE under:
#       s3://$BACKUP_S3_BUCKET/${BACKUP_S3_PREFIX:-kyahub/}_smoketest/
#
# Exit codes:
#   0 OK
#   1 FATAL preflight (missing env or tool)
#   2 FAIL (network/auth/permission/path issue)
#
# Usage:
#   bash scripts/backup-offsite-smoketest.sh
#   bash scripts/backup-offsite-smoketest.sh --verbose
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="$ROOT/.env"

VERBOSE=0
for a in "$@"; do
  case "$a" in
    --verbose|-v) VERBOSE=1 ;;
    --help|-h) grep -E '^# ' "$0" | head -60; exit 0 ;;
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
  BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-$(load_env_key BACKUP_S3_ENDPOINT)}"
  BACKUP_S3_REGION="${BACKUP_S3_REGION:-$(load_env_key BACKUP_S3_REGION)}"
  BACKUP_S3_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-$(load_env_key BACKUP_S3_ACCESS_KEY_ID)}"
  BACKUP_S3_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-$(load_env_key BACKUP_S3_SECRET_ACCESS_KEY)}"
  BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-$(load_env_key BACKUP_S3_BUCKET)}"
  BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-$(load_env_key BACKUP_S3_PREFIX)}"
fi

log() {
  local lvl="$1"; shift
  local msg="$*"
  printf '{"ts":"%s","level":"%s","component":"backup-offsite-smoketest","msg":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$lvl" "${msg//\"/\\\"}"
}
verbose() { [[ "$VERBOSE" == "1" ]] && log debug "$*" || true; }

# Reuse provider detection + tool selection.
# shellcheck source=lib/s3-backup-upload.sh
source "$ROOT/scripts/lib/s3-backup-upload.sh"
s3backup::detect_provider

if [[ "$PROVIDER_KIND" != "s3-compat" ]]; then
  log error "FATAL: BACKUP_S3_* not configured (provider_kind=$PROVIDER_KIND). Configure BACKUP_S3_* for R2/S3."
  exit 1
fi
if [[ "$PROVIDER_TOOL" == "missing" || "$PROVIDER_TOOL" == "none" ]]; then
  log error "FATAL: no S3 upload tool installed (need awscli or rclone)"
  exit 1
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TMPDIR_OWN="$(mktemp -d -t kyahub-offsite-smoke-XXXXXXXX)"
trap 'rm -rf "$TMPDIR_OWN"' EXIT

PROBE_LOCAL="$TMPDIR_OWN/probe-${TS}.bin"
PROBE_DOWN="$TMPDIR_OWN/probe-downloaded-${TS}.bin"
printf 'kyahub offsite smoketest %s\n' "$TS" > "$PROBE_LOCAL"

RAW_PREFIX="${BACKUP_S3_PREFIX:-kyahub/}"
RAW_PREFIX="${RAW_PREFIX#/}"
[[ "$RAW_PREFIX" != "" && "${RAW_PREFIX: -1}" != "/" ]] && RAW_PREFIX="$RAW_PREFIX/"
SMOKE_KEY="${RAW_PREFIX}_smoketest/probe-${TS}.bin"
SMOKE_URI="s3://${BACKUP_S3_BUCKET}/${SMOKE_KEY}"

log info "starting provider_tool=$PROVIDER_TOOL endpoint=$BACKUP_S3_ENDPOINT bucket=$BACKUP_S3_BUCKET key=$SMOKE_KEY"

fail() {
  local stage="$1"; shift
  log error "FAIL stage=$stage detail=$*"
  exit 2
}

case "$PROVIDER_TOOL" in
  aws)
    AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
      aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
        s3 cp "$PROBE_LOCAL" "$SMOKE_URI" --only-show-errors >/dev/null 2>&1 \
        || fail "put" "aws s3 cp failed (likely token scope / bucket / endpoint)."

    AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
      aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
        s3 ls "s3://${BACKUP_S3_BUCKET}/${RAW_PREFIX}_smoketest/" >/dev/null 2>&1 \
        || fail "list" "aws s3 ls failed (need ListBucket permission)."

    AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
      aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
        s3 cp "$SMOKE_URI" "$PROBE_DOWN" --only-show-errors >/dev/null 2>&1 \
        || fail "get" "aws s3 cp download failed (need GetObject permission)."

    cmp -s "$PROBE_LOCAL" "$PROBE_DOWN" || fail "verify" "downloaded payload mismatch"

    AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
      aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
        s3 rm "$SMOKE_URI" --only-show-errors >/dev/null 2>&1 \
        || fail "delete" "aws s3 rm failed (need DeleteObject permission)."
    ;;
  rclone)
    # rclone uses an ephemeral remote via env vars (same pattern as s3-backup-upload.sh).
    RCLONE_CONFIG_REMOTE_TYPE=s3 \
    RCLONE_CONFIG_REMOTE_PROVIDER=Other \
    RCLONE_CONFIG_REMOTE_ENDPOINT="$BACKUP_S3_ENDPOINT" \
    RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_REMOTE_REGION="${BACKUP_S3_REGION:-auto}" \
      rclone copyto "$PROBE_LOCAL" "remote:${BACKUP_S3_BUCKET}/${SMOKE_KEY}" \
        --s3-no-check-bucket --quiet >/dev/null 2>&1 \
        || fail "put" "rclone copyto failed (likely token scope / bucket / endpoint)."

    RCLONE_CONFIG_REMOTE_TYPE=s3 \
    RCLONE_CONFIG_REMOTE_PROVIDER=Other \
    RCLONE_CONFIG_REMOTE_ENDPOINT="$BACKUP_S3_ENDPOINT" \
    RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_REMOTE_REGION="${BACKUP_S3_REGION:-auto}" \
      rclone lsf "remote:${BACKUP_S3_BUCKET}/${RAW_PREFIX}_smoketest/" \
        --s3-no-check-bucket --quiet >/dev/null 2>&1 \
        || fail "list" "rclone lsf failed (need ListBucket permission)."

    RCLONE_CONFIG_REMOTE_TYPE=s3 \
    RCLONE_CONFIG_REMOTE_PROVIDER=Other \
    RCLONE_CONFIG_REMOTE_ENDPOINT="$BACKUP_S3_ENDPOINT" \
    RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_REMOTE_REGION="${BACKUP_S3_REGION:-auto}" \
      rclone copyto "remote:${BACKUP_S3_BUCKET}/${SMOKE_KEY}" "$PROBE_DOWN" \
        --s3-no-check-bucket --quiet >/dev/null 2>&1 \
        || fail "get" "rclone copyto download failed (need GetObject permission)."

    cmp -s "$PROBE_LOCAL" "$PROBE_DOWN" || fail "verify" "downloaded payload mismatch"

    RCLONE_CONFIG_REMOTE_TYPE=s3 \
    RCLONE_CONFIG_REMOTE_PROVIDER=Other \
    RCLONE_CONFIG_REMOTE_ENDPOINT="$BACKUP_S3_ENDPOINT" \
    RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
    RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
    RCLONE_CONFIG_REMOTE_REGION="${BACKUP_S3_REGION:-auto}" \
      rclone deletefile "remote:${BACKUP_S3_BUCKET}/${SMOKE_KEY}" \
        --s3-no-check-bucket --quiet >/dev/null 2>&1 \
        || fail "delete" "rclone deletefile failed (need DeleteObject permission)."
    ;;
  *)
    log error "FATAL: unsupported provider tool: $PROVIDER_TOOL"
    exit 1
    ;;
esac

verbose "probe_local_sha256=$(sha256sum "$PROBE_LOCAL" | awk '{print $1}')"
log info "OK off-site permissions verified (put/list/get/delete)"
exit 0

