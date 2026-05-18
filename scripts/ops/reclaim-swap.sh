#!/usr/bin/env bash
# Reclaim swap when RAM is available (fixes stale 90% swap alerts on Netdata).
# Safe when `available` in `free` is comfortably above current swap used.
set -euo pipefail

AVAIL_KB=$(awk '/^Mem:/ {print $7}' /proc/meminfo)
SWAP_USED_KB=$(awk '/^Swap:/ {print $3}' /proc/meminfo)

if [[ "$SWAP_USED_KB" -lt 102400 ]]; then
  echo "swap already low (${SWAP_USED_KB} KiB used) — nothing to do"
  free -h
  exit 0
fi

# Require at least swap_used + 512 MiB headroom
NEED=$((SWAP_USED_KB + 524288))
if [[ "$AVAIL_KB" -lt "$NEED" ]]; then
  echo "ERROR: insufficient MemAvailable (${AVAIL_KB} KiB) to reclaim ${SWAP_USED_KB} KiB swap" >&2
  echo "Top swap consumers:" >&2
  for f in /proc/[0-9]*/status; do
    awk -v f="$f" '/^Name:|VmSwap:/ {if($1=="Name:") n=$2; if($1=="VmSwap:" && $2>50000) print $2/1024 " MB", n}' "$f" 2>/dev/null
  done | sort -rn | head -8 >&2
  exit 1
fi

echo "Before:" && free -h
swapoff -a
swapon -a
echo "After:" && free -h
