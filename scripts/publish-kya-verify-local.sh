#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_FILE="${NPM_TOKEN_FILE:-$ROOT/.secrets/npm-publish-token.txt}"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Create $TOKEN_FILE with one line: npm Classic Automation token" >&2
  exit 1
fi
TOKEN="$(tr -d '\n\r' < "$TOKEN_FILE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
export NODE_AUTH_TOKEN="$TOKEN"
cd "$ROOT/packages/kya-verify"
npm config set //registry.npmjs.org/:_authToken "$TOKEN"
npm whoami
npm publish --access public
echo "OK: https://www.npmjs.com/package/@umbraxon_kya/kya-verify"
