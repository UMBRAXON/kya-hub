#!/bin/bash
# ============================================================================
# UMBRAXON KYA-Hub — migrate containerd store off root onto HC volume
# ============================================================================
# Docker data-root is already on /mnt/HC_Volume_105979036/docker.
# Image layers still live in /var/lib/containerd (~4.7G on /).
#
# Cutover stops docker + containerd (~5–15 min). Proxies (nakus/klubo/jasne),
# BTCPay and bitcoind are down for that window.
#
# Preflight: destination Avail must be >= source size + MARGIN (default 1 GiB).
# 20 GB volume (2026-09-03) has ~3.6G free — NOT enough. Resize first:
#   hcloud volume resize 105979036 40
#   resize2fs /dev/disk/by-id/scsi-0HC_Volume_105979036
#
# Usage:
#   DRY_RUN=1 /root/kya-hub/scripts/migrate-containerd-to-volume.sh
#   /root/kya-hub/scripts/migrate-containerd-to-volume.sh
#
# Night window (after resize): 21:00 UTC — before NaKus ingest 01:00 UTC.
# Do NOT cron this until df on the volume clears preflight.
# ============================================================================

set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/kya-hub/.env}"
LOG_FILE="${LOG_FILE:-/var/log/kyahub-containerd-migrate.log}"
DRY_RUN="${DRY_RUN:-0}"
VOLUME_MNT="${VOLUME_MNT:-/mnt/HC_Volume_105979036}"
DEST="${DEST:-${VOLUME_MNT}/containerd}"
SRC="${SRC:-/var/lib/containerd}"
MARGIN_BYTES="${MARGIN_BYTES:-1073741824}" # 1 GiB
FSTAB_LINE="${DEST} ${SRC} none bind 0 0"

mkdir -p "$(dirname "$LOG_FILE")"

readEnv() {
    local key="$1"
    [[ -f "$ENV_FILE" ]] || { echo ""; return; }
    grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"' || true
}

TELEGRAM_BOT_TOKEN="$(readEnv TELEGRAM_BOT_TOKEN)"
TELEGRAM_CHAT_ID="$(readEnv TELEGRAM_CHAT_ID)"

log() {
    echo "[$(date -Is)] $*" | tee -a "$LOG_FILE"
}

notify() {
    local level="$1"; shift
    local msg="$*"
    log "${level}: ${msg}"
    if [[ -n "$TELEGRAM_BOT_TOKEN" && -n "$TELEGRAM_CHAT_ID" ]]; then
        curl -sS --max-time 5 -X POST \
            "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
            --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
            --data-urlencode "text=📦 containerd migrate ${level}: ${msg}" \
            >/dev/null 2>&1 || true
    fi
}

bytes_of() {
    du -sb "$1" 2>/dev/null | awk '{print $1}'
}

avail_bytes() {
    df -B1 -P "$1" | awk 'NR==2 {print $4}'
}

already_on_volume() {
    findmnt -n -o SOURCE,TARGET "$SRC" 2>/dev/null | grep -q "$DEST" && return 0
    local src_dev dest_dev
    src_dev="$(df -P "$SRC" | awk 'NR==2 {print $1}')"
    dest_dev="$(df -P "$VOLUME_MNT" | awk 'NR==2 {print $1}')"
    [[ -n "$src_dev" && "$src_dev" == "$dest_dev" ]]
}

verify_stack() {
    docker info >/dev/null
    local missing=0
    local name
    # CRITICAL: `nginx`+`tor` bind host :443 (Cloudflare origin). Proxies alone
    # are not enough — 2026-09-04 outage = migrate OK + edge never returned.
    for name in nginx tor kya-hub-proxy klubo-proxy jasnelabs-proxy btcpayserver_bitcoind generated_btcpayserver_1; do
        if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
            log "WARN: container not running: ${name}"
            missing=1
        fi
    done
    return "$missing"
}

heal_public_edge() {
    local ensure=/root/kya-hub/scripts/prod/ensure-public-edge.sh
    if [[ -x "$ensure" ]]; then
        log "INFO: ensure-public-edge…"
        "$ensure" || return 1
        return 0
    fi
    docker start nginx tor >/dev/null 2>&1 || true
    sleep 3
    docker ps --format '{{.Names}}' | grep -qx nginx
}

probe_public_https() {
    local ok=0
    local host code
    for host in www.nakus.sk www.klubo.sk www.umbraxon.xyz; do
        code="$(curl -sk --max-time 12 -o /dev/null -w '%{http_code}' "https://${host}/" || echo 000)"
        log "probe ${host} HTTP ${code}"
        if [[ "$code" =~ ^[23] ]]; then
            ok=1
        fi
    done
    [[ "$ok" -eq 1 ]]
}

rollback() {
    notify "FAIL" "rollback — restoring ${SRC} from bak"
    systemctl stop docker.socket docker containerd 2>/dev/null || true
    if mountpoint -q "$SRC"; then
        umount "$SRC" || umount -l "$SRC" || true
    fi
    if [[ -d "${SRC}.bak" && ! -d "${SRC}/io.containerd.content.v1.content" ]]; then
        rmdir "$SRC" 2>/dev/null || rm -rf "$SRC"
        mv "${SRC}.bak" "$SRC"
    fi
    systemctl start containerd docker
}

# --- already done? ---
if already_on_volume; then
    log "containerd already on volume — nothing to do"
    df -h "$SRC" "$VOLUME_MNT" /
    exit 0
fi

SRC_BYTES="$(bytes_of "$SRC")"
AVAIL_BYTES="$(avail_bytes "$VOLUME_MNT")"
NEED_BYTES=$(( SRC_BYTES + MARGIN_BYTES ))

log "=== containerd migrate start DRY_RUN=${DRY_RUN} ==="
log "src=${SRC} size=$(( SRC_BYTES / 1024 / 1024 )) MiB"
log "dest=${DEST} volume_avail=$(( AVAIL_BYTES / 1024 / 1024 )) MiB need=$(( NEED_BYTES / 1024 / 1024 )) MiB"

if [[ "$AVAIL_BYTES" -lt "$NEED_BYTES" ]]; then
    notify "FAIL" "nedostatok miesta na volume: avail=$(( AVAIL_BYTES / 1024 / 1024 ))MiB need=$(( NEED_BYTES / 1024 / 1024 ))MiB — najprv hcloud volume resize 105979036 40 && resize2fs"
    exit 2
fi

if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN OK — preflight passed; would stop docker, rsync, bind-mount, start, drop ${SRC}.bak"
    exit 0
fi

notify "INFO" "starting cutover (docker down ~5–15 min)"

systemctl stop docker.socket docker
systemctl stop containerd

mkdir -p "$DEST"
rsync -aHAX --numeric-ids --info=progress2 "$SRC"/ "$DEST"/

if [[ -e "${SRC}.bak" ]]; then
    log "FAIL: ${SRC}.bak already exists"
    systemctl start containerd docker
    exit 3
fi
mv "$SRC" "${SRC}.bak"
mkdir -p "$SRC"
mount --bind "$DEST" "$SRC"

if ! grep -qF "$DEST" /etc/fstab; then
    echo "$FSTAB_LINE" >> /etc/fstab
    log "fstab bind added"
fi

systemctl start containerd
systemctl start docker

# wait until docker answers
for i in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
        break
    fi
    sleep 2
done

if ! docker info >/dev/null 2>&1; then
    rollback
    exit 4
fi

sleep 8
if ! verify_stack; then
    log "WARN: some containers not up yet — healing public edge + recheck"
    docker ps -a --format '{{.Names}}\t{{.Status}}' | tee -a "$LOG_FILE"
    heal_public_edge || true
    sleep 5
    verify_stack || true
fi

# Proof: containerd blocks are on the volume device
SRC_DEV="$(df -P "$SRC" | awk 'NR==2 {print $1}')"
VOL_DEV="$(df -P "$VOLUME_MNT" | awk 'NR==2 {print $1}')"
if [[ "$SRC_DEV" != "$VOL_DEV" ]]; then
    notify "FAIL" "bind mount did not stick (src_dev=${SRC_DEV} vol_dev=${VOL_DEV})"
    rollback
    exit 5
fi

rm -rf "${SRC}.bak"
log "removed ${SRC}.bak"

# Hard gate: public HTTPS must answer or Telegram FAIL (do not claim OK)
if ! heal_public_edge || ! probe_public_https; then
    notify "FAIL" "containerd on volume but public edge/HTTPS down — run ensure-public-edge.sh + docker ps"
    docker ps -a --format '{{.Names}}\t{{.Status}}' | tee -a "$LOG_FILE" || true
    exit 6
fi

ROOT_PCT="$(df / | awk 'NR==2 {print $5}')"
VOL_PCT="$(df "$VOLUME_MNT" | awk 'NR==2 {print $5}')"
notify "INFO" "OK containerd on volume; root=${ROOT_PCT} volume=${VOL_PCT}; HTTPS probes OK"
df -h / "$SRC" "$VOLUME_MNT" | tee -a "$LOG_FILE"
log "=== containerd migrate end ==="
exit 0
