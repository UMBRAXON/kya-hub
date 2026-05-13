# ============================================================================
# UMBRAXON KYA-Hub — Shared S3-compatible upload helper
# (sourced by backup-channel-state.sh + backup-database.sh)
# ----------------------------------------------------------------------------
# Provides:
#   s3backup::detect_provider          — sets PROVIDER_KIND globally
#   s3backup::upload <src> <object>    — uploads, sets UPLOAD_RC and UPLOAD_ERR
#
# Provider selection (env vars):
#   BACKUP_S3_ENDPOINT          — preferred: any S3-compat endpoint
#                                 (Cloudflare R2, AWS S3, MinIO, DO Spaces, B2)
#                                 e.g. https://<acct-id>.r2.cloudflarestorage.com
#                                 e.g. https://<acct-id>.eu.r2.cloudflarestorage.com (EU jurisdiction)
#   BACKUP_S3_REGION            — default "auto" (correct for R2);
#                                 use "us-east-1" / "eu-central-1" for AWS S3
#   BACKUP_S3_ACCESS_KEY_ID
#   BACKUP_S3_SECRET_ACCESS_KEY
#   BACKUP_S3_BUCKET
#   BACKUP_S3_PREFIX            — optional, default "kyahub/"
#
#   Legacy (kept for backwards compatibility — used only when BACKUP_S3_* unset):
#   B2_KEY_ID / B2_APP_KEY / B2_BUCKET / B2_S3_ENDPOINT
#
# Tools (auto-detected):
#   1. `aws` CLI            — primary path (S3 v4 signing, works with R2)
#                             install: apt install awscli     (Debian/Ubuntu)
#                                      pip install awscli     (any Linux)
#   2. `rclone`             — portable fallback (single binary, no python)
#                             install: apt install rclone     (Debian/Ubuntu)
#                                      curl https://rclone.org/install.sh | bash
#   3. `b2` (legacy)        — used ONLY when BACKUP_S3_* unset AND B2_* set
#                             AND `b2` CLI is present; runs Backblaze-native
#                             auth.
#
# One-time R2 lifecycle setup hint (operator runs this in the Cloudflare
# dashboard, not via the script):
#   Bucket → Settings → Object Lifecycle Rules → Add rule:
#     - "hot tier 90d" — Delete after 90 days for everything under
#       kyahub/lightning_channel/ (channel state churn is high)
#     - "cold tier" — Transition to Infrequent Access after 30 days for
#       kyahub/db/ and kyahub/dac8/ (these are append-only / monthly read)
#     - Optional cross-region replication for disaster recovery.
# ============================================================================

# Globals populated by s3backup::detect_provider:
#   PROVIDER_KIND     — one of: s3-compat | b2-legacy | none
#   PROVIDER_ENDPOINT — resolved endpoint URL (s3-compat path)
#   PROVIDER_REGION   — resolved region
#   PROVIDER_BUCKET   — bucket name
#   PROVIDER_PREFIX   — object key prefix (with trailing slash)
#   PROVIDER_AKID     — access key id
#   PROVIDER_SECRET   — secret access key
#   PROVIDER_TOOL     — aws | rclone | b2 | none

s3backup::detect_provider() {
    PROVIDER_KIND="none"
    PROVIDER_TOOL="none"
    PROVIDER_ENDPOINT=""
    PROVIDER_REGION=""
    PROVIDER_BUCKET=""
    PROVIDER_PREFIX=""
    PROVIDER_AKID=""
    PROVIDER_SECRET=""

    # Preferred: BACKUP_S3_* set (R2 or any S3-compat).
    if [[ -n "${BACKUP_S3_ENDPOINT:-}" \
       && -n "${BACKUP_S3_ACCESS_KEY_ID:-}" \
       && -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" \
       && -n "${BACKUP_S3_BUCKET:-}" ]]; then
        PROVIDER_KIND="s3-compat"
        PROVIDER_ENDPOINT="$BACKUP_S3_ENDPOINT"
        PROVIDER_REGION="${BACKUP_S3_REGION:-auto}"
        PROVIDER_BUCKET="$BACKUP_S3_BUCKET"
        PROVIDER_AKID="$BACKUP_S3_ACCESS_KEY_ID"
        PROVIDER_SECRET="$BACKUP_S3_SECRET_ACCESS_KEY"
        local raw_prefix="${BACKUP_S3_PREFIX:-kyahub/}"
        # ensure trailing slash, strip leading slash
        raw_prefix="${raw_prefix#/}"
        [[ "$raw_prefix" != "" && "${raw_prefix: -1}" != "/" ]] && raw_prefix="$raw_prefix/"
        PROVIDER_PREFIX="$raw_prefix"

        if command -v aws >/dev/null 2>&1; then
            PROVIDER_TOOL="aws"
        elif command -v rclone >/dev/null 2>&1; then
            PROVIDER_TOOL="rclone"
        else
            PROVIDER_TOOL="missing"
        fi
        return 0
    fi

    # Legacy: B2_* set (still allow Backblaze users to keep their setup).
    if [[ -n "${B2_KEY_ID:-}" && -n "${B2_APP_KEY:-}" && -n "${B2_BUCKET:-}" ]]; then
        PROVIDER_KIND="b2-legacy"
        PROVIDER_ENDPOINT="${B2_S3_ENDPOINT:-}"
        PROVIDER_REGION="${BACKUP_S3_REGION:-us-west-002}"
        PROVIDER_BUCKET="$B2_BUCKET"
        PROVIDER_AKID="$B2_KEY_ID"
        PROVIDER_SECRET="$B2_APP_KEY"
        PROVIDER_PREFIX=""

        if command -v b2 >/dev/null 2>&1; then
            PROVIDER_TOOL="b2"
        elif [[ -n "$PROVIDER_ENDPOINT" ]] && command -v aws >/dev/null 2>&1; then
            PROVIDER_TOOL="aws"
        elif [[ -n "$PROVIDER_ENDPOINT" ]] && command -v rclone >/dev/null 2>&1; then
            PROVIDER_TOOL="rclone"
        else
            PROVIDER_TOOL="missing"
        fi
        return 0
    fi

    PROVIDER_KIND="none"
    return 0
}

# Upload <local-file> to <relative-object-key>.
# Sets:
#   UPLOAD_RC   — 0 ok, 2 failed
#   UPLOAD_ERR  — error message on failure
#   UPLOAD_URI  — provider URI (s3://bucket/key or b2://bucket/key)
s3backup::upload() {
    local src="$1"
    local rel_key="$2"
    UPLOAD_RC=2
    UPLOAD_ERR=""
    UPLOAD_URI=""

    case "$PROVIDER_KIND" in
        s3-compat)
            local key="${PROVIDER_PREFIX}${rel_key}"
            UPLOAD_URI="s3://${PROVIDER_BUCKET}/${key}"
            case "$PROVIDER_TOOL" in
                aws)
                    if AWS_ACCESS_KEY_ID="$PROVIDER_AKID" \
                       AWS_SECRET_ACCESS_KEY="$PROVIDER_SECRET" \
                       AWS_DEFAULT_REGION="$PROVIDER_REGION" \
                       aws --endpoint-url "$PROVIDER_ENDPOINT" \
                           s3 cp "$src" "$UPLOAD_URI" \
                           --only-show-errors >/dev/null 2>&1; then
                        UPLOAD_RC=0
                    else
                        UPLOAD_ERR="aws s3 cp -> $PROVIDER_ENDPOINT failed"
                    fi
                    ;;
                rclone)
                    # rclone uses an ephemeral remote via env vars
                    if RCLONE_CONFIG_REMOTE_TYPE=s3 \
                       RCLONE_CONFIG_REMOTE_PROVIDER=Other \
                       RCLONE_CONFIG_REMOTE_ENDPOINT="$PROVIDER_ENDPOINT" \
                       RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID="$PROVIDER_AKID" \
                       RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY="$PROVIDER_SECRET" \
                       RCLONE_CONFIG_REMOTE_REGION="$PROVIDER_REGION" \
                       rclone copyto "$src" "remote:${PROVIDER_BUCKET}/${key}" \
                              --s3-no-check-bucket --quiet >/dev/null 2>&1; then
                        UPLOAD_RC=0
                    else
                        UPLOAD_ERR="rclone copyto -> $PROVIDER_ENDPOINT failed"
                    fi
                    ;;
                missing)
                    UPLOAD_ERR="BACKUP_S3_* set but neither awscli nor rclone is installed. Run: apt install awscli (preferred) OR apt install rclone."
                    ;;
                *)
                    UPLOAD_ERR="no upload tool"
                    ;;
            esac
            ;;
        b2-legacy)
            local key="$rel_key"
            UPLOAD_URI="b2://${PROVIDER_BUCKET}/${key}"
            case "$PROVIDER_TOOL" in
                b2)
                    local b2_auth_rc=0
                    b2 account authorize "$PROVIDER_AKID" "$PROVIDER_SECRET" >/dev/null 2>&1 \
                        || b2 authorize-account "$PROVIDER_AKID" "$PROVIDER_SECRET" >/dev/null 2>&1 \
                        || b2_auth_rc=$?
                    if [[ "$b2_auth_rc" == "0" ]]; then
                        if b2 file upload "$PROVIDER_BUCKET" "$src" "$key" >/dev/null 2>&1 \
                            || b2 upload-file "$PROVIDER_BUCKET" "$src" "$key" >/dev/null 2>&1; then
                            UPLOAD_RC=0
                        else
                            UPLOAD_ERR="b2 file upload failed"
                        fi
                    else
                        UPLOAD_ERR="b2 authorize-account failed rc=$b2_auth_rc"
                    fi
                    ;;
                aws)
                    if AWS_ACCESS_KEY_ID="$PROVIDER_AKID" \
                       AWS_SECRET_ACCESS_KEY="$PROVIDER_SECRET" \
                       AWS_DEFAULT_REGION="$PROVIDER_REGION" \
                       aws --endpoint-url "$PROVIDER_ENDPOINT" \
                           s3 cp "$src" "s3://${PROVIDER_BUCKET}/${key}" \
                           --only-show-errors >/dev/null 2>&1; then
                        UPLOAD_RC=0
                        UPLOAD_URI="s3://${PROVIDER_BUCKET}/${key}"
                    else
                        UPLOAD_ERR="aws s3 cp -> B2 endpoint failed"
                    fi
                    ;;
                rclone)
                    if RCLONE_CONFIG_REMOTE_TYPE=s3 \
                       RCLONE_CONFIG_REMOTE_PROVIDER=Other \
                       RCLONE_CONFIG_REMOTE_ENDPOINT="$PROVIDER_ENDPOINT" \
                       RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID="$PROVIDER_AKID" \
                       RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY="$PROVIDER_SECRET" \
                       RCLONE_CONFIG_REMOTE_REGION="$PROVIDER_REGION" \
                       rclone copyto "$src" "remote:${PROVIDER_BUCKET}/${key}" \
                              --s3-no-check-bucket --quiet >/dev/null 2>&1; then
                        UPLOAD_RC=0
                        UPLOAD_URI="s3://${PROVIDER_BUCKET}/${key}"
                    else
                        UPLOAD_ERR="rclone copyto -> B2 endpoint failed"
                    fi
                    ;;
                missing)
                    UPLOAD_ERR="B2_* set but neither b2/awscli/rclone is installed."
                    ;;
                *)
                    UPLOAD_ERR="no upload tool"
                    ;;
            esac
            ;;
        none|*)
            UPLOAD_ERR="no off-site backup destination configured"
            ;;
    esac
}
