#!/usr/bin/env bash
# ============================================================================
# UMBRAXON KYA-Hub — Smoke test for the new BACKUP_S3_* / B2_* provider
# detection helper (Cloudflare R2 refactor 2026-05-12).
#
# Verifies:
#   1. With BACKUP_S3_* set    → provider_kind=s3-compat
#   2. With only B2_* set      → provider_kind=b2-legacy
#   3. With neither set        → provider_kind=none
#   4. Prefix handling (default kyahub/, strips leading /, appends trailing /)
#
# Run:
#   bash scripts/test-backup-s3-detect.sh
# Exit 0 on all-pass, 1 otherwise.
# ============================================================================
set -u

cd "$(dirname "$0")/.."
HELPER="scripts/lib/s3-backup-upload.sh"

PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1 — $2"; }

run_case() {
    local label="$1"; shift
    # shellcheck disable=SC1090
    ( unset BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY_ID \
            BACKUP_S3_SECRET_ACCESS_KEY BACKUP_S3_BUCKET BACKUP_S3_PREFIX \
            B2_KEY_ID B2_APP_KEY B2_BUCKET B2_S3_ENDPOINT
      eval "$@"
      source "$HELPER"
      s3backup::detect_provider
      printf '%s|%s|%s\n' "$PROVIDER_KIND" "$PROVIDER_TOOL" "$PROVIDER_PREFIX"
    )
}

echo "=== 1) BACKUP_S3_* set → s3-compat ==="
out=$(run_case s3 \
    'BACKUP_S3_ENDPOINT=https://x.r2.cloudflarestorage.com' \
    'BACKUP_S3_ACCESS_KEY_ID=akid' \
    'BACKUP_S3_SECRET_ACCESS_KEY=secret' \
    'BACKUP_S3_BUCKET=bucket')
kind=$(echo "$out" | cut -d'|' -f1)
prefix=$(echo "$out" | cut -d'|' -f3)
[[ "$kind" == "s3-compat" ]] && ok "kind=s3-compat" || bad "kind" "got '$kind'"
[[ "$prefix" == "kyahub/" ]]  && ok "prefix default=kyahub/" || bad "prefix" "got '$prefix'"

echo "=== 2) only B2_* set → b2-legacy ==="
out=$(run_case b2 \
    'B2_KEY_ID=k' 'B2_APP_KEY=p' 'B2_BUCKET=b' 'B2_S3_ENDPOINT=https://s3.eu.b2.example')
kind=$(echo "$out" | cut -d'|' -f1)
[[ "$kind" == "b2-legacy" ]] && ok "kind=b2-legacy" || bad "kind" "got '$kind'"

echo "=== 3) neither set → none ==="
out=$(run_case none)
kind=$(echo "$out" | cut -d'|' -f1)
[[ "$kind" == "none" ]] && ok "kind=none" || bad "kind" "got '$kind'"

echo "=== 4) custom prefix handling ==="
out=$(run_case s3 \
    'BACKUP_S3_ENDPOINT=https://x' 'BACKUP_S3_ACCESS_KEY_ID=akid' \
    'BACKUP_S3_SECRET_ACCESS_KEY=secret' 'BACKUP_S3_BUCKET=bucket' \
    'BACKUP_S3_PREFIX=/sub/path')
prefix=$(echo "$out" | cut -d'|' -f3)
[[ "$prefix" == "sub/path/" ]] && ok "prefix normalisation /sub/path → sub/path/" \
                                || bad "prefix normalisation" "got '$prefix'"

echo "=== 5) BOTH sets present → BACKUP_S3_* wins ==="
out=$(run_case both \
    'BACKUP_S3_ENDPOINT=https://r2' 'BACKUP_S3_ACCESS_KEY_ID=akid' \
    'BACKUP_S3_SECRET_ACCESS_KEY=secret' 'BACKUP_S3_BUCKET=bucket' \
    'B2_KEY_ID=k' 'B2_APP_KEY=p' 'B2_BUCKET=b' 'B2_S3_ENDPOINT=https://b2')
kind=$(echo "$out" | cut -d'|' -f1)
[[ "$kind" == "s3-compat" ]] && ok "preference: BACKUP_S3_* over B2_*" \
                              || bad "preference" "got '$kind'"

echo ""
echo "SUMMARY: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
