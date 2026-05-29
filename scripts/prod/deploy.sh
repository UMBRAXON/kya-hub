#!/usr/bin/env bash
# Production deploy: hub deps + portal build + PM2 restart + smoke checks.
#
# Usage:
#   bash scripts/prod/deploy.sh           # full deploy (hub + portal)
#   bash scripts/prod/deploy.sh --portal  # portal only (Next.js build + kya-portal)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PORTAL_ONLY=false
if [[ "${1:-}" == "--portal" ]]; then
  PORTAL_ONLY=true
fi

unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy SOCKS_PROXY socks_proxy

log() { echo "[deploy] $*"; }

if [[ "$PORTAL_ONLY" == false ]]; then
  log "hub: npm ci"
  npm ci --omit=dev
fi

log "portal: npm ci + build"
npm --prefix portal ci
npm --prefix portal run build

log "pm2: restart services"
if [[ "$PORTAL_ONLY" == true ]]; then
  pm2 restart kya-portal --update-env
else
  pm2 restart kya-hub kya-portal --update-env
fi

log "pm2: ensure web uptime watcher"
if pm2 describe kya-web-uptime-watch >/dev/null 2>&1; then
  pm2 restart kya-web-uptime-watch --update-env
else
  pm2 start ecosystem.config.js --only kya-web-uptime-watch --update-env
fi

pm2 save

log "verify public endpoints"
curl -fsS -m 15 -o /dev/null -w "www: HTTP %{http_code}\n" https://www.umbraxon.xyz/
curl -fsS -m 15 -o /dev/null -w "bots: HTTP %{http_code}\n" https://www.umbraxon.xyz/bots/
curl -fsS -m 15 https://www.umbraxon.xyz/api/health | head -c 240
echo
log "done"
