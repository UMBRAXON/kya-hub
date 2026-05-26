#!/usr/bin/env bash
# One-shot installer: validate token, persist secrets, install cron, optional first run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
SECRETS_FILE="${HCLOUD_SECRETS_FILE:-/root/.secrets/hcloud-token}"
HCLOUD_CONFIG="${HCLOUD_CONFIG:-/root/.config/hcloud/cli.toml}"
SNAPSHOT_SCRIPT="$ROOT/scripts/hetzner-snapshot.sh"
CRON_LINE='0 2 * * 0 /root/kya-hub/scripts/hetzner-snapshot.sh >> /var/log/kyahub-hetzner-snapshot.log 2>&1'
RUN_NOW="${RUN_NOW:-1}"
SKIP_CRON="${SKIP_CRON:-0}"

readEnv() {
    local key="$1"
    [[ -f "$ENV_FILE" ]] || { echo ""; return; }
    grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true
}

setEnvKey() {
    local key="$1" val="$2"
    python3 - "$ENV_FILE" "$key" "$val" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
key, val = sys.argv[2], sys.argv[3]
lines = path.read_text().splitlines() if path.exists() else []
out, found = [], False
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={val}")
        found = True
    else:
        out.append(line)
if not found:
    out.append(f"{key}={val}")
path.write_text("\n".join(out) + "\n")
PY
}

resolve_token() {
    local t="${HCLOUD_TOKEN:-${1:-}}"
    if [[ -z "$t" && -f "$SECRETS_FILE" ]]; then
        t="$(<"$SECRETS_FILE")"
    fi
    if [[ -z "$t" ]]; then
        t="$(readEnv HCLOUD_TOKEN)"
    fi
    if [[ -z "$t" ]]; then
        t="$(readEnv HETZNER_API_TOKEN)"
    fi
    if [[ -z "$t" && -f "$HCLOUD_CONFIG" ]]; then
        t="$(grep -E '^\s*token\s*=' "$HCLOUD_CONFIG" | head -n1 | sed -E 's/.*=\s*"([^"]+)".*/\1/; s/.*=\s*([^#[:space:]]+).*/\1/')"
    fi
    printf '%s' "$t"
}

resolve_server_id() {
    local id
    id="$(readEnv HCLOUD_SERVER_ID)"
    if [[ -n "$id" ]]; then
        echo "$id"
        return 0
    fi
    curl -sS --max-time 3 "http://169.254.169.254/hetzner/v1/metadata/instance-id" 2>/dev/null || true
}

validate_token() {
    local token="$1" server_id="$2"
    local http
    http="$(curl -sS -o /tmp/hcloud_setup_probe.json -w '%{http_code}' \
        -H "Authorization: Bearer ${token}" \
        "https://api.hetzner.cloud/v1/servers/${server_id}")"
    if [[ "$http" != "200" ]]; then
        local err
        err="$(jq -r '.error.message // .' /tmp/hcloud_setup_probe.json 2>/dev/null || cat /tmp/hcloud_setup_probe.json)"
        echo "Token validation failed (HTTP ${http}): ${err}" >&2
        return 1
    fi
    return 0
}

install_cron() {
    local tmp existing
    existing="$(crontab -l 2>/dev/null || true)"
    if grep -Fq 'scripts/hetzner-snapshot.sh' <<<"$existing"; then
        echo "cron: hetzner-snapshot already installed"
        return 0
    fi
    tmp="$(mktemp)"
    {
        echo "$existing"
        echo ""
        echo "# KYA-Hub — weekly Hetzner Cloud server snapshot (Sunday 02:00 UTC)"
        echo "$CRON_LINE"
    } | sed '/^$/N;/^\n$/d' >"$tmp"
    crontab "$tmp"
    rm -f "$tmp"
    echo "cron: installed Sunday 02:00 UTC"
}

main() {
    local token server_id
    token="$(resolve_token)"
    server_id="$(resolve_server_id)"
    : "${server_id:?could not resolve HCLOUD_SERVER_ID / metadata instance-id}"

    if [[ -z "$token" ]]; then
        echo "ERROR: HCLOUD_TOKEN missing." >&2
        echo "Provide via: HCLOUD_TOKEN=... $0   OR   $0 <token>   OR   $SECRETS_FILE" >&2
        exit 1
    fi

    validate_token "$token" "$server_id"

    mkdir -p "$(dirname "$SECRETS_FILE")" "$(dirname "$HCLOUD_CONFIG")"
    chmod 700 "$(dirname "$SECRETS_FILE")"
    printf '%s' "$token" >"$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"

    if [[ ! -f "$HCLOUD_CONFIG" ]]; then
        cat >"$HCLOUD_CONFIG" <<EOF
active_context = "kya-hub"

[[contexts]]
  name = "kya-hub"
  token = "${token}"
EOF
        chmod 600 "$HCLOUD_CONFIG"
    fi

    setEnvKey HCLOUD_TOKEN "$token"
    setEnvKey HCLOUD_SERVER_ID "$server_id"
    chmod 600 "$ENV_FILE" 2>/dev/null || true

    echo "secrets: $SECRETS_FILE"
    echo "server_id: $server_id"

    if [[ "$SKIP_CRON" != "1" ]]; then
        install_cron
    fi

    touch /var/log/kyahub-hetzner-snapshot.log
    chmod 640 /var/log/kyahub-hetzner-snapshot.log 2>/dev/null || true

    if [[ "$RUN_NOW" == "1" ]]; then
        echo "running first snapshot..."
        HCLOUD_TOKEN="$token" HCLOUD_SERVER_ID="$server_id" ENV_FILE="$ENV_FILE" "$SNAPSHOT_SCRIPT"
    fi

    echo "setup complete"
}

main "$@"
