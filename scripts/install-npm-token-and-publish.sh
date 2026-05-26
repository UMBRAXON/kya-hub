#!/usr/bin/env bash
# One-shot: paste npm Classic Automation token (hidden), then publish.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_FILE="$ROOT/.secrets/npm-publish-token.txt"
mkdir -p "$ROOT/.secrets"
chmod 700 "$ROOT/.secrets"
if [[ -f "$TOKEN_FILE" ]]; then
  echo "Token file already exists: $TOKEN_FILE"
  read -r -p "Overwrite? [y/N] " ans
  [[ "${ans,,}" == "y" ]] || true
  if [[ "${ans,,}" != "y" ]]; then
    exec "$ROOT/scripts/publish-kya-verify-local.sh"
  fi
fi
echo "Paste npm token (Classic → Automation), then Enter:"
read -rs TOKEN
echo
printf '%s' "$TOKEN" | tr -d '\n\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
unset TOKEN
exec "$ROOT/scripts/publish-kya-verify-local.sh"
