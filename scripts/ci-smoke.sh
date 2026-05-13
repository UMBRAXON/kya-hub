#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[ci-smoke] node $(node -v)"
echo "[ci-smoke] npm  $(npm -v)"

# Pure, hermetic checks only (no .env, no DB, no network).
node scripts/test-item7-log-redaction.js
node scripts/test-item13-watchtower-doc.js
node scripts/test-ci-hermetic.js
node scripts/test-openapi-sanity.js
node scripts/test-readme-links.js
node scripts/test-operations-index.js

echo "[ci-smoke] OK"

