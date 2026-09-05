#!/bin/bash
# One-shot night runner for containerd migrate (scheduled via `at`).
# Owner: after 23:00 local (CEST) = 21:00+ UTC on 2026-09-03.
set -euo pipefail

LOG=/var/log/kyahub-containerd-migrate.log
LOCK=/var/lock/kyahub-containerd-migrate.lock
SCRIPT=/root/kya-hub/scripts/migrate-containerd-to-volume.sh

exec >>"$LOG" 2>&1
echo "===== at-runner start $(date -Is) ====="

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "LOCK busy — another migrate running; exit"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# Safety: only on the planned calendar day (UTC)
TODAY="$(date -u +%F)"
if [[ "$TODAY" != "2026-09-03" ]]; then
  echo "SKIP: today=${TODAY} (expected 2026-09-03 UTC)"
  exit 0
fi

if [[ ! -x "$SCRIPT" ]]; then
  echo "FAIL: missing $SCRIPT"
  exit 1
fi

"$SCRIPT"
rc=$?
echo "===== at-runner end $(date -Is) exit=${rc} ====="
exit "$rc"
