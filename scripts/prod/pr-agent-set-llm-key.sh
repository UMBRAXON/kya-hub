#!/usr/bin/env bash
# Store OpenAI (or compatible) API key for PR agent — not committed to git.
set -euo pipefail
TARGET="${LLM_API_KEY_FILE:-/root/kya-hub/.secrets/openai-api-key.txt}"
mkdir -p "$(dirname "$TARGET")"
if [[ -t 0 ]]; then
  read -r -s -p "Paste LLM API key: " key
  echo
else
  read -r key
fi
key="${key//$'\r'/}"
key="${key//$'\n'/}"
key="${key#"${key%%[![:space:]]*}"}"
key="${key%"${key##*[![:space:]]}"}"
if [[ -z "$key" ]]; then
  echo "Empty key, abort." >&2
  exit 1
fi
printf '%s\n' "$key" >"$TARGET"
chmod 600 "$TARGET"
echo "Saved to $TARGET"
