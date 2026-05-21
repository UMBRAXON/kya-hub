#!/usr/bin/env bash
# Daily growth cycle: demo witness + community listener + integrator scout (+ optional PR github-scan)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${GROWTH_LOG_DIR:-$ROOT/logs/growth}"
mkdir -p "$LOG_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$LOG_DIR/cycle-$STAMP.log"

exec > >(tee -a "$LOG") 2>&1
echo "=== kya-growth-cycle $STAMP UTC ==="

echo "--- demo-witness ---"
bash "$ROOT/scripts/growth/demo-witness.sh" || echo "demo-witness: non-zero exit (logged)"

echo "--- community-listener ---"
python3 "$ROOT/scripts/growth/community-listener.py" || echo "community-listener failed"

echo "--- integrator-scout-issues ---"
if [ -f "$ROOT/agents/umbraxon-pr-agent/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT/agents/umbraxon-pr-agent/.env"
  set +a
fi
python3 "$ROOT/scripts/growth/integrator-scout-issues.py" || echo "scout failed"

if [ "${GROWTH_WITH_PR_GITHUB_SCAN:-false}" = "true" ]; then
  echo "--- pr-agent github-scan ---"
  (cd "$ROOT/agents/umbraxon-pr-agent" && ./run-python.sh main.py github-scan) || true
fi

echo "=== done ==="
ln -sf "cycle-$STAMP.log" "$LOG_DIR/cycle-latest.log"
