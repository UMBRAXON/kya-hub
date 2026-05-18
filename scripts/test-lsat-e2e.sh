#!/usr/bin/env bash
# E2E LSAT day-pass: invoice → pay (you) → poll → redeem → verify API.
#
# Usage:
#   ./scripts/test-lsat-e2e.sh              # create invoice + print pay link
#   ./scripts/test-lsat-e2e.sh --poll ID    # wait until paid (webhook)
#   ./scripts/test-lsat-e2e.sh --redeem ID  # mint umb_lsat_ after paid
#   ./scripts/test-lsat-e2e.sh --verify TOKEN  # call status API with token
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export DOTENV_CONFIG_QUIET=true
BASE="${KYA_HUB_BASE_URL:-http://127.0.0.1:${PORT:-3000}}"
BASE="${BASE%/}"
KYA_TEST="${TEST_KYA_ID:-UMBRA-000467}"

json() { python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))" 2>/dev/null || cat; }

cmd="${1:-}"

if [[ "$cmd" == "--poll" ]]; then
  ACCESS="${2:?access_id}"
  for i in $(seq 1 60); do
    R=$(curl -sS "${BASE}/api/v1/integrator/lsat/status?access_id=${ACCESS}")
    ST=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
    echo "[$i/60] status=$ST"
    if [[ "$ST" == "paid" ]]; then echo "$R" | json; exit 0; fi
    sleep 5
  done
  echo "Timeout — pay invoice or check BTCPay webhook" >&2
  exit 1
fi

if [[ "$cmd" == "--redeem" ]]; then
  ACCESS="${2:?access_id}"
  curl -sS -X POST "${BASE}/api/v1/integrator/lsat/redeem" \
    -H "Content-Type: application/json" \
    -d "{\"access_id\":\"${ACCESS}\"}" | json
  exit 0
fi

if [[ "$cmd" == "--verify" ]]; then
  TOKEN="${2:?umb_lsat token}"
  curl -sS "${BASE}/api/v1/agents/${KYA_TEST}/status" \
    -H "Authorization: Bearer ${TOKEN}" | json
  exit 0
fi

echo "Creating LSAT invoice at ${BASE} ..."
INV=$(curl -sS -X POST "${BASE}/api/v1/integrator/lsat/invoice" \
  -H "Content-Type: application/json" -d '{}')
echo "$INV" | json

ACCESS=$(echo "$INV" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_id'])")
CHECKOUT=$(echo "$INV" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('checkout_link') or '')")
BOLT11=$(echo "$INV" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('bolt11') or '')")

echo ""
echo "=== Pay (5000 sats default) ==="
if [[ -n "$CHECKOUT" ]]; then
  echo "Browser / wallet checkout: $CHECKOUT"
fi
if [[ -n "$BOLT11" ]]; then
  echo "BOLT11: $BOLT11"
fi
echo ""
echo "After payment, run:"
echo "  ./scripts/test-lsat-e2e.sh --poll ${ACCESS}"
echo "  ./scripts/test-lsat-e2e.sh --redeem ${ACCESS}"
echo "  ./scripts/test-lsat-e2e.sh --verify '<lsat_token from redeem>'"
