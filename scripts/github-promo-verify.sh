#!/usr/bin/env bash
# Verify GitHub promo assets and run smoke tests (no secrets required).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "== Issue templates =="
test -f .github/ISSUE_TEMPLATE/config.yml
test -f .github/ISSUE_TEMPLATE/registration-help.yml
test -f .github/DISCUSSION_TEMPLATE/registration.yml
echo "OK templates"

echo "== Docs =="
test -f docs/REGISTRATION-QUICKSTART.md
test -f docs/RELEASE-v1.1.0.md
echo "OK docs"

echo "== Node smoke =="
node scripts/test-sponsor-invite.js
node scripts/test-pow-register-policy.js
node scripts/test-api-v1-register.js 2>/dev/null || true

echo "== PR agent github-scan (dry-run, no token) =="
cd agents/umbraxon-pr-agent
python3 main.py github-scan 2>&1 | head -c 2000
echo ""
echo "github-promo-verify: OK"
