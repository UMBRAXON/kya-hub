#!/usr/bin/env bash
# POST /api/v1/agents/me/setup-owner-email (Moltbook skill.md)
set -euo pipefail
EMAIL="${1:-}"
if [[ -z "$EMAIL" ]]; then
  echo "Usage: $0 <owner@email.com>" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/agents/umbraxon-pr-agent"
set -a && source .env && set +a
if [[ -z "${MOLTBOOK_API_KEY:-}" ]]; then
  echo "MOLTBOOK_API_KEY missing in agents/umbraxon-pr-agent/.env" >&2
  exit 1
fi
exec python3 - "$EMAIL" <<'PY'
import json, sys
from config import load_settings
from connectors.moltbook import MoltbookConnector

email = sys.argv[1]
s = load_settings()
mb = MoltbookConnector(s.moltbook_base_url, s.moltbook_api_key)
try:
    out = mb.setup_owner_email(email)
    print(json.dumps(out, indent=2, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}, indent=2))
    raise SystemExit(1) from e
PY
