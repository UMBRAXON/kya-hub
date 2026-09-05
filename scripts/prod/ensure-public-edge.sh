#!/bin/bash
# ============================================================================
# UMBRAXON — ensure public HTTPS edge (BTCPay nginx + tor) is up
# ============================================================================
# Topology: Cloudflare → host :443 (container `nginx`) → kya-hub-proxy → apps.
# After docker/containerd cutovers the edge can stay Exited even when proxies
# are healthy → Cloudflare "Host Error" / 521 on nakus + klubo + umbraxon.
#
# Safe to run often (idempotent). Exit 0 = :443 listening; 1 = still down.
# ============================================================================
set -euo pipefail

LOG="${LOG:-/var/log/kyahub-ensure-public-edge.log}"
BTCPAY_COMPOSE="${BTCPAY_COMPOSE:-/root/btcpayserver-docker/Generated/docker-compose.generated.yml}"
ENV_SH="${BTCPAY_ENV:-/etc/profile.d/btcpay-env.sh}"

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

port443_up() {
  ss -ltn 2>/dev/null | grep -qE ':443\s' || ss -ltn 2>/dev/null | grep -q ':443 '
}

container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"
}

start_edge() {
  if container_running nginx && container_running tor; then
    return 0
  fi

  log "INFO: starting edge containers (nginx/tor)"
  # Prefer existing containers (restart policy unless-stopped)
  docker start nginx tor >/dev/null 2>&1 || true
  sleep 2
  if container_running nginx; then
    return 0
  fi

  # Recreate from BTCPay compose when containers were removed (post-migrate)
  if [[ -f "$ENV_SH" && -f "$BTCPAY_COMPOSE" ]]; then
    # shellcheck disable=SC1090
    . "$ENV_SH"
    log "INFO: compose up -d nginx tor"
    (cd "$(dirname "$BTCPAY_COMPOSE")" && docker-compose -f "$(basename "$BTCPAY_COMPOSE")" up -d nginx tor) >>"$LOG" 2>&1 || \
      (cd "$(dirname "$BTCPAY_COMPOSE")" && docker compose -f "$(basename "$BTCPAY_COMPOSE")" up -d nginx tor) >>"$LOG" 2>&1 || true
  fi
}

if port443_up && container_running nginx; then
  exit 0
fi

log "WARN: public edge down (443=$(port443_up && echo up || echo down) nginx=$(container_running nginx && echo up || echo down))"
start_edge

for i in $(seq 1 20); do
  if port443_up && container_running nginx; then
    log "OK: public edge restored after ${i} checks"
    exit 0
  fi
  sleep 1
done

log "FAIL: public edge still down after heal attempt"
exit 1
