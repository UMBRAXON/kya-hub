#!/usr/bin/env bash
# Bootstrap UMBRAXON-PR-AMBASSADOR: keygen + show pubkey + tier price (BASIC ≈ 10k sats).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${PR_ENV:-$ROOT/agents/umbraxon-pr-agent/.env}"
SECRETS_DIR="${PR_SECRETS_DIR:-$ROOT/agents/umbraxon-pr-agent/secrets}"
KEY_FILE="${PR_KEY_FILE:-$SECRETS_DIR/bot.key}"

mkdir -p "$SECRETS_DIR" logs
chmod 700 "$SECRETS_DIR" 2>/dev/null || true

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT/agents/umbraxon-pr-agent/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE — edit KYA_LIGHTNING_NODE_ID and URLs before register."
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

BASE_URL="${KYA_HUB_BASE_URL:-https://www.umbraxon.xyz}"
AGENT_NAME="${KYA_AGENT_NAME:-UMBRAXON-PR-AMBASSADOR}"

echo "=== KYA Hub tiers (confirm BASIC = 10k sats) ==="
curl -fsS "${BASE_URL%/}/api/tiers" | python3 -m json.tool

if [[ ! -f "$KEY_FILE" ]]; then
  echo "=== Generating Ed25519 key: $KEY_FILE ==="
  python3 "$ROOT/scripts/umbrexon_bot_client.py" keygen --out "$KEY_FILE"
fi

PUB="$(python3 -c "
import sys
sys.path.insert(0, '$ROOT/scripts')
import umbrexon_bot_client as u
seed = u.load_seed('$KEY_FILE', None)
print(u.derive_pubkey_hex(seed))
")"

echo ""
echo "Agent name:     $AGENT_NAME"
echo "Public key:     $PUB"
echo "Key file:       $KEY_FILE"
echo "Env file:       $ENV_FILE"
echo ""
echo "Next: run scripts/prod/pr-agent-register-watch.sh"
