#!/usr/bin/env bash
# ============================================================================
# KYA-Hub — integrator smoke (5 minutes, no registration payment)
# ============================================================================
set -euo pipefail

HUB="${HUB_URL:-https://www.umbraxon.xyz}"
PASS=0
FAIL=0

ok() { echo "  OK  $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL $*"; FAIL=$((FAIL + 1)); }

echo "=== KYA integrator 5-min smoke ==="
echo "Hub: $HUB"
echo ""

echo "1) Health"
if curl -fsS "$HUB/api/health" | grep -qE '"server"\s*:\s*"OK"'; then ok health; else bad health; fi

echo "2) Protocol versions"
if curl -fsS "$HUB/api/protocol/versions" | grep -q 'supported'; then ok versions; else bad versions; fi

echo "3) Sandbox status (verified)"
if curl -fsS "$HUB/api/v1/agents/UMBRA-TEST-0001/status" | grep -q '"verified":true'; then ok sandbox_ok; else bad sandbox_ok; fi

echo "4) Sandbox status (revoked fixture)"
if curl -fsS "$HUB/api/v1/agents/UMBRA-TEST-0005/status" | grep -q '"verified":false'; then ok sandbox_revoked; else bad sandbox_revoked; fi

echo "5) Public metrics"
if curl -fsS "$HUB/api/protocol/public-metrics" | grep -q 'production_agents_paid'; then ok metrics; else bad metrics; fi

echo "6) Discovery feed"
if curl -fsS "$HUB/api/discovery/v1/agents.json" | grep -q '"agents"'; then ok discovery; else bad discovery; fi

echo "7) Trusted hubs (federation doc)"
if curl -fsS "$HUB/api/protocol/trusted-hubs.json" | grep -q 'hub_id'; then ok federation; else bad federation; fi

echo ""
echo "SUMMARY: $PASS passed, $FAIL failed"
echo "Next: docs/INTEGRATOR-QUICKSTART-5MIN.md · register bot: docs/REGISTRATION-QUICKSTART.md"
exit "$([[ $FAIL -eq 0 ]] && echo 0 || echo 1)"
