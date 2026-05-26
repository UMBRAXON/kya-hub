#!/usr/bin/env bash
# Post a small number of scout drafts as GitHub issue comments (safe + rate-limited).
# Requires: `gh auth login` OR env GH_TOKEN/GITHUB_TOKEN with comment permission.
#
# This script is intentionally conservative:
# - posts at most SCOUT_POST_MAX_PER_RUN comments (default 2)
# - only from drafts created by integrator-scout-issues.py
# - keeps a local state file of already-posted URLs to prevent repeats
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCOUT_DIR="${SCOUT_DIR:-$ROOT/logs/growth/scout}"
STATE_FILE="${SCOUT_POST_STATE_FILE:-$ROOT/.tmp-scout-posted.json}"
MAX_PER_RUN="${SCOUT_POST_MAX_PER_RUN:-2}"

mkdir -p "$ROOT/.tmp-scout"
touch "$STATE_FILE"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh missing; skipping"
  exit 0
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "gh not authenticated; skipping (run: gh auth login)"
  exit 0
fi

python3 - "$SCOUT_DIR" "$STATE_FILE" "$MAX_PER_RUN" <<'PY'
import json, sys
from pathlib import Path

scout_dir = Path(sys.argv[1])
state_file = Path(sys.argv[2])
max_per_run = int(sys.argv[3])

def load_state():
    try:
        return set(json.loads(state_file.read_text() or "[]"))
    except Exception:
        return set()

def save_state(s):
    state_file.write_text(json.dumps(sorted(s), indent=2) + "\n")

posted = load_state()
drafts = sorted(scout_dir.glob("summary-*.json"), reverse=True)
urls = []
for p in drafts[:25]:
    try:
        data = json.loads(p.read_text())
    except Exception:
        continue
    for lead in data.get("leads") or []:
        url = (lead.get("url") or "").strip()
        df = (lead.get("draft_file") or "").strip()
        if not url or url in posted:
            continue
        if df:
            urls.append((url, df))
    if len(urls) >= max_per_run:
        break

print(json.dumps({"candidates": len(urls)}, indent=2))
save_state(posted)  # ensure file exists
PY

posted_count=0

# Post newest-first; draft_file contains markdown with "## Suggested comment"
for summary in $(ls -1t "$SCOUT_DIR"/summary-*.json 2>/dev/null | head -25); do
  [ "$posted_count" -ge "$MAX_PER_RUN" ] && break
  while IFS= read -r draft_file; do
    [ "$posted_count" -ge "$MAX_PER_RUN" ] && break
    [ -f "$draft_file" ] || continue
    url="$(python3 - <<PY
import re, pathlib
txt = pathlib.Path("$draft_file").read_text(encoding="utf-8", errors="ignore")
m = re.search(r"^\\- \\*\\*URL:\\*\\*\\s*(.+)\\s*$", txt, re.M)
print((m.group(1).strip() if m else ""))
PY
)"
    [ -n "$url" ] || continue

    # Extract comment body
    body="$(python3 - <<PY
import pathlib
txt = pathlib.Path("$draft_file").read_text(encoding="utf-8", errors="ignore")
marker = "## Suggested comment"
idx = txt.find(marker)
out = txt[idx + len(marker):] if idx >= 0 else txt
print(out.strip())
PY
)"
    [ -n "$body" ] || continue

    # Parse owner/repo and issue number from URL
    owner_repo="$(python3 - <<PY
import re
u="$url"
m=re.search(r"github\\.com/([^/]+/[^/]+)/issues/\\d+", u)
print(m.group(1) if m else "")
PY
)"
    issue_no="$(python3 - <<PY
import re
u="$url"
m=re.search(r"/issues/(\\d+)", u)
print(m.group(1) if m else "")
PY
)"
    if [ -z "$owner_repo" ] || [ -z "$issue_no" ]; then
      continue
    fi

    echo "posting comment -> $url"
    if gh api -X POST "repos/${owner_repo}/issues/${issue_no}/comments" -f body="$body" >/dev/null; then
      python3 - "$STATE_FILE" "$url" <<'PY'
import json, sys
from pathlib import Path
f = Path(sys.argv[1])
url = sys.argv[2]
try:
    s = set(json.loads(f.read_text() or "[]"))
except Exception:
    s = set()
s.add(url)
f.write_text(json.dumps(sorted(s), indent=2) + "\n")
PY
      posted_count=$((posted_count+1))
    fi
  done < <(python3 - <<'PY'
import glob
for p in sorted(glob.glob("/root/kya-hub/logs/growth/scout/*.md")):
    print(p)
PY
)
done

echo "done posted=$posted_count"
