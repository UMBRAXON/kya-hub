#!/usr/bin/env bash
# Weekly Hetzner server snapshot. Cron: 0 2 * * 0
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${SNAPSHOT_LOG_DIR:-/var/log}"
mkdir -p "$LOG_DIR"
exec "$ROOT/scripts/hetzner-snapshot.sh" "$@" 2>&1 | tee -a "$LOG_DIR/kyahub-hetzner-snapshot.log"
