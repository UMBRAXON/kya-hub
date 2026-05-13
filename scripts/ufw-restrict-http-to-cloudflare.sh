#!/usr/bin/env bash
# ============================================================================
# Restrict origin-facing HTTP/HTTPS (ports 80, 443) to Cloudflare edge IPs only.
#
# PREREQUISITES (order matters):
#   1. DNS for umbraxon.xyz (and pay.* if same host) uses Cloudflare proxy
#      ("orange cloud") — verified traffic reaches origin ONLY via CF.
#   2. SSL/TLS mode in Cloudflare: Full (strict) — origin cert still valid.
#   3. Smoke-test: curl -fsSI https://umbraxon.xyz/api/health
#
# WITHOUT orange-cloud, locking 80/443 to CF ranges blocks legitimate direct clients.
#
# Does NOT remove: SSH (22), Docker bridge → :3000 rules — edit manually if needed.
# Refreshes ranges from https://www.cloudflare.com/ips-v4 and ips-v6 on each run.
#
# Usage:
#   ./scripts/ufw-restrict-http-to-cloudflare.sh --dry-run
#   sudo ./scripts/ufw-restrict-http-to-cloudflare.sh --apply
# ============================================================================
set -euo pipefail

DRY_RUN=1
if [[ "${1:-}" == "--apply" ]]; then DRY_RUN=0; fi
if [[ "${1:-}" == "--dry-run" ]] || [[ $# -eq 0 ]]; then DRY_RUN=1; fi

log() { printf '%s\n' "$*"; }

fetch_ranges() {
    curl -fsS --max-time 30 https://www.cloudflare.com/ips-v4
    echo ""
    curl -fsS --max-time 30 https://www.cloudflare.com/ips-v6
}

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
fetch_ranges | sed '/^[[:space:]]*$/d' >"$TMP"

log "# Cloudflare IP ranges ($(wc -l <"$TMP") lines):"
head -5 "$TMP" | sed 's/^/#   /'
log "#   ... (truncated)"

allow_cf_port() {
    local port=$1
    while read -r cidr; do
        [[ -z "$cidr" ]] && continue
        if [[ $DRY_RUN -eq 1 ]]; then
            log "DRY: ufw allow from $cidr to any port $port proto tcp comment 'Cloudflare-$port'"
        else
            ufw allow from "$cidr" to any port "$port" proto tcp comment "Cloudflare-${port}"
        fi
    done <"$TMP"
}

if [[ $DRY_RUN -eq 0 ]] && [[ $(id -u) -ne 0 ]]; then
    echo "ERROR: --apply requires root (sudo)." >&2
    exit 1
fi

if [[ $DRY_RUN -eq 0 ]]; then
    # Often both IPv4 and IPv6 "allow 80/tcp" rows exist — delete until none left.
    for _ in 1 2 3 4; do ufw delete allow 80/tcp  2>/dev/null || true; done
    for _ in 1 2 3 4; do ufw delete allow 443/tcp 2>/dev/null || true; done
fi

allow_cf_port 80
allow_cf_port 443

if [[ $DRY_RUN -eq 1 ]]; then
    log ""
    log "# DRY-RUN only. Re-run with: sudo $0 --apply"
else
    ufw reload
    log "Applied. Verify: ufw status numbered | head -40"
fi
