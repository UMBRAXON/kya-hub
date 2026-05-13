#!/usr/bin/env bash
# Tail "live" API-related lines: nginx access log if present, else PM2 hub out log.
set -euo pipefail

NGINX_ACCESS="${NGINX_ACCESS_LOG:-/var/log/nginx/access.log}"
PM2_OUT="${PM2_HUB_OUT_LOG:-$HOME/.pm2/logs/kya-hub-out.log}"

if [[ -r "$NGINX_ACCESS" ]]; then
  echo "# tail nginx: $NGINX_ACCESS (filter /api/)"
  exec tail -f "$NGINX_ACCESS" | grep --line-buffered '/api/'
fi

if [[ -r "$PM2_OUT" ]]; then
  echo "# nginx access log not readable ($NGINX_ACCESS) — tail PM2: $PM2_OUT"
  exec tail -f "$PM2_OUT" | grep --line-buffered -E '/api/|register/initiate|"route":'
fi

echo "Neither log is readable:"
echo "  NGINX_ACCESS_LOG=$NGINX_ACCESS"
echo "  PM2_HUB_OUT_LOG=$PM2_OUT"
echo "Set env vars or run as user that owns PM2 logs (often root for /root/.pm2)."
exit 1
