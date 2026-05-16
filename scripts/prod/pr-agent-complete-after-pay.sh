#!/usr/bin/env bash
# Poll existing registration until COMPLETED + fetch cert (after operator paid BOLT11).
set -euo pipefail
REG_ID="${1:?Usage: $0 REG-...}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="${PR_LOG_DIR:-$ROOT/logs/pr-agent}"
mkdir -p "$LOG_DIR"

cd "$ROOT/agents/umbraxon-pr-agent"
# shellcheck disable=SC1090
set -a && source .env && set +a

export PR_REGISTRATION_ID="$REG_ID"
python3 <<'PY'
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__) or ".", "../../scripts"))
import umbrexon_bot_client as ubc
from pathlib import Path

# import agent logging
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents/umbraxon-pr-agent"))
from config import load_settings
from logging_util import new_trace_logger
from hub.register import wait_until_registered

reg_id = os.environ["PR_REGISTRATION_ID"]
s = load_settings()
log = new_trace_logger(os.environ.get("PR_LOG_DIR", "logs"), prefix="pr-complete")
log.info("await_payment", registration_id=reg_id)
final = wait_until_registered(s, reg_id, log=log, timeout_sec=float(os.environ.get("PR_WAIT_TIMEOUT", "900")))
print(json.dumps(final, indent=2, ensure_ascii=False))
PY

echo ""
echo "=== Hub logs (grep) ==="
pm2 logs kya-hub --nostream --lines 200 2>/dev/null | grep -E "$REG_ID|UMBRAXON-PR-AMBASSADOR|agent_registered" | tail -20 || true
