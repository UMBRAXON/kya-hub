#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_FILE="${NPM_TOKEN_FILE:-$ROOT/.secrets/npm-publish-token.txt}"
if [[ -n "${NPM_TOKEN:-}" ]]; then
  TOKEN="$(printf '%s' "$NPM_TOKEN" | tr -d '\n\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
elif [[ -f "$TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '\n\r' < "$TOKEN_FILE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
else
  echo "Missing npm token. Either:" >&2
  echo "  export NPM_TOKEN=npm_... && $0" >&2
  echo "  echo -n 'npm_...' > $TOKEN_FILE && chmod 600 $TOKEN_FILE && $0" >&2
  exit 1
fi

if [[ "$TOKEN" == npm_npm_* ]]; then
  echo "ERROR: Double prefix npm_npm_ — paste the token exactly as npm shows (once)." >&2
  exit 1
fi
if [[ ! "$TOKEN" =~ ^npm_ ]] || [[ ${#TOKEN} -lt 80 ]]; then
  echo "ERROR: Token looks truncated (len=${#TOKEN}). Copy the full granular token from npm." >&2
  exit 1
fi

export NODE_AUTH_TOKEN="$TOKEN"
cd "$ROOT/packages/kya-verify"

# Granular tokens (2025+): verify with Bearer, then configure npm CLI
echo "Checking token with registry…"
CODE="$(curl -fsS -o /tmp/npm-whoami.json -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  https://registry.npmjs.org/-/whoami 2>/dev/null || echo "000")"
if [[ "$CODE" != "200" ]]; then
  echo "ERROR: npm registry rejected token (HTTP ${CODE})." >&2
  cat /tmp/npm-whoami.json 2>/dev/null || true
  echo "Create new granular token: Read and write, org umbraxon_kya, Bypass 2FA checked." >&2
  exit 1
fi
echo "Registry OK: $(cat /tmp/npm-whoami.json)"

npm config set //registry.npmjs.org/:_authToken "$TOKEN"
npm whoami
npm publish --access public
echo "OK: https://www.npmjs.com/package/@umbraxon_kya/kya-verify"
