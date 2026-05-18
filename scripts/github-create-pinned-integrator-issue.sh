#!/usr/bin/env bash
# Create + pin the integrator welcome issue (requires GITHUB_TOKEN with repo scope).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="${GITHUB_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "Set GITHUB_TOKEN (repo scope) and re-run." >&2
  exit 1
fi
BODY_FILE="$ROOT/.github/PINNED_ISSUE_BODY.md"
# Strip the pin instruction header for GitHub body
BODY="$(sed -n '/^---$/,${ /^---$/d; p; }' "$BODY_FILE" | tail -n +2)"
JSON=$(jq -n \
  --arg title "Integrate KYA in 5 minutes (pinned)" \
  --arg body "$BODY" \
  '{title: $title, body: $body, labels: ["integrator","documentation"]}')
RESP=$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/UMBRAXON/kya-hub/issues" \
  -d "$JSON")
NUM=$(echo "$RESP" | jq -r .number)
echo "Created issue #$NUM"
curl -fsS -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/UMBRAXON/kya-hub/issues/$NUM" \
  -d '{"state":"open"}' >/dev/null
echo "Pin manually in GitHub UI: Issues → #$NUM → Pin"
