#!/usr/bin/env bash
# ============================================================================
# PoC: P0-1 — kya-hub bypasses nginx because Express bound to 0.0.0.0:3000
# ----------------------------------------------------------------------------
# Status: FIXED in this sprint (server.js now binds 127.0.0.1 + UFW rule
# removed). This PoC is preserved as the reproduction script that would have
# shown the bypass before the fix.
#
# Pre-fix behaviour: a remote attacker could send a request directly to
#   http://<server-public-ip>:3000/api/admin/agents/... with an X-Admin-Key
#   guess (and no nginx rate-limit / WAF in front).
#
# Post-fix behaviour: connection refused from the public interface.
#
# Run from the server (loopback always works regardless of bind):
#   bash p0-1-nginx-bypass.sh
# ============================================================================
set -euo pipefail

echo "[1/3] Loopback request to :3000/api/status (must always work):"
curl -sS --max-time 5 http://127.0.0.1:3000/api/status
echo

echo "[2/3] LISTEN socket (post-fix should be 127.0.0.1 only):"
ss -tlnp 2>/dev/null | awk '/:3000 /'

echo "[3/3] Public-interface probe (post-fix should refuse / time out):"
PUBIP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [[ -n "${PUBIP:-}" && "$PUBIP" != "127.0.0.1" ]]; then
    if timeout 3 curl -sS -o /dev/null -w "HTTP %{http_code} (code=0 -> hung/refused)\n" "http://${PUBIP}:3000/api/status"; then
        echo "WARNING: public-interface hit succeeded — bind may be 0.0.0.0 again"
    else
        echo "OK: public-interface hit refused / timed out"
    fi
else
    echo "(no public IPv4 — skipped public probe)"
fi
