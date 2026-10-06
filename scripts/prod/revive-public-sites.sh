#!/bin/bash
# ============================================================================
# KYA — revive all public sites (nakus + klubo + umbraxon)
# ============================================================================
# One-shot self-heal when Cloudflare/Host Error / 521 / apps dead.
# Safe to run often (idempotent). Designed for:
#   - PM2 kya-web-uptime-watch (automatic, owner offline)
#   - manual: bash /root/kya-hub/scripts/prod/revive-public-sites.sh
#   - nakus: npm run ops:revive-sites
#
# Steps: public :443 edge → proxies → NaKus Next → Klubo PM2 → probe → exit
# Never runs feed sync / full pipeline.
# ============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAKUS="${NAKUS_ROOT:-/root/nakus-project}"
KLUBO="${KLUBO_ROOT:-/root/klubo}"
LOG="${LOG:-/var/log/kyahub-revive-public-sites.log}"
ENSURE_EDGE="${ROOT}/scripts/prod/ensure-public-edge.sh"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-12}"

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

ok=0
fail=0
note() { log "$*"; }

step_edge() {
  if [[ -x "$ENSURE_EDGE" ]]; then
    if bash "$ENSURE_EDGE" >>"$LOG" 2>&1; then
      note "OK edge (:443 / nginx)"
      ok=$((ok + 1))
    else
      note "FAIL edge"
      fail=$((fail + 1))
    fi
  else
    note "SKIP edge (missing ensure-public-edge.sh)"
  fi
}

step_proxies() {
  local c
  for c in kya-hub-proxy klubo-proxy nginx; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
        note "OK proxy already up: $c"
        ok=$((ok + 1))
      else
        if docker start "$c" >>"$LOG" 2>&1; then
          note "OK started proxy: $c"
          ok=$((ok + 1))
        else
          note "FAIL start proxy: $c"
          fail=$((fail + 1))
        fi
      fi
    fi
  done
  # nginx-gen / companion — soft
  for c in nginx-gen letsencrypt-nginx-proxy-companion; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      docker start "$c" >>"$LOG" 2>&1 || true
    fi
  done
}

step_nakus() {
  if [[ ! -d "$NAKUS" ]]; then
    note "SKIP nakus (no dir)"
    return
  fi
  if [[ -x "$NAKUS/scripts/nakus-next-singleton.sh" ]]; then
    if bash "$NAKUS/scripts/nakus-next-singleton.sh" restart >>"$LOG" 2>&1; then
      note "OK nakus singleton restart"
      ok=$((ok + 1))
    else
      note "WARN nakus singleton failed — try web:up"
      if (cd "$NAKUS" && NAKUS_FORCE_RESTART=1 npm run web:up) >>"$LOG" 2>&1; then
        note "OK nakus web:up"
        ok=$((ok + 1))
      else
        note "FAIL nakus web:up"
        fail=$((fail + 1))
      fi
    fi
  else
    note "SKIP nakus singleton missing"
  fi
  # warm homepage (loads Next into RAM)
  curl -sS -o /dev/null --max-time "$PROBE_TIMEOUT" "http://127.0.0.1:3002/" >>"$LOG" 2>&1 || true
}

step_klubo() {
  if ! command -v pm2 >/dev/null 2>&1; then
    return
  fi
  if ! pm2 describe klubo >/dev/null 2>&1; then
    note "SKIP pm2 klubo not registered"
    return
  fi
  # Only bounce if unhealthy — unconditional restart every revive (= every 2 min
  # via web-uptime-watch) re-opens :3010 and spams Cursor port-forward toasts.
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" \
    "http://127.0.0.1:3010/login" 2>/dev/null || echo 000)
  if [[ "$code" =~ ^2|^3 ]]; then
    note "OK klubo already healthy (HTTP $code) — no restart"
    ok=$((ok + 1))
    return
  fi
  if pm2 restart klubo --update-env >>"$LOG" 2>&1; then
    note "OK pm2 restart klubo (was HTTP $code)"
    ok=$((ok + 1))
  else
    note "FAIL pm2 restart klubo"
    fail=$((fail + 1))
  fi
}

probe_url() {
  local url="$1"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" -L "$url" 2>/dev/null || echo 000)
  if [[ "$code" =~ ^2|^3 ]]; then
    note "PROBE OK $url → HTTP $code"
    ok=$((ok + 1))
    return 0
  fi
  note "PROBE FAIL $url → HTTP $code"
  fail=$((fail + 1))
  return 1
}

step_probe() {
  sleep 3
  probe_url "https://www.nakus.sk/" || probe_url "http://127.0.0.1:3002/" || true
  probe_url "https://www.klubo.sk/" || true
  probe_url "https://www.umbraxon.xyz/" || true
}

log "======== revive-public-sites START ========"
step_edge
step_proxies
step_nakus
step_klubo
step_probe
log "======== revive-public-sites END ok=$ok fail=$fail ========"

if [[ "$fail" -gt 0 && "$ok" -eq 0 ]]; then
  exit 1
fi
# Partial success still exit 0 if edge or any site recovered
exit 0
