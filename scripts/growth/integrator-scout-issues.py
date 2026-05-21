#!/usr/bin/env python3
"""GitHub issue scout — draft integrator comments (dry-run only, never posts)."""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HUB = os.getenv("KYA_HUB_BASE_URL", "https://www.umbraxon.xyz").rstrip("/")
QUERIES = [
    q.strip()
    for q in os.getenv(
        "SCOUT_ISSUE_QUERIES",
        "agent verification is:issue,state:open|sybil agent is:issue,state:open|"
        "L402 lightning is:issue,state:open|AI agent identity is:issue,state:open",
    ).split("|")
    if q.strip()
]
MAX_PER_QUERY = int(os.getenv("SCOUT_MAX_PER_QUERY", "8"))
OUT_DIR = Path(os.getenv("GROWTH_LOG_DIR", "/root/kya-hub/logs/growth")) / "scout"


def gh_search(q: str, token: str) -> dict:
    params = urllib.parse.urlencode(
        {"q": q, "sort": "updated", "order": "desc", "per_page": min(MAX_PER_QUERY, 30)}
    )
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "kya-growth-scout/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"https://api.github.com/search/issues?{params}", headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def draft_comment(issue: dict) -> str:
    title = issue.get("title") or ""
    return f"""Hi — saw "{title}" and this might be relevant.

KYA Hub is a Lightning-paid, Ed25519-anchored **agent identity** registry with a single HTTP gate before you trust a bot:

```bash
curl -sS "{HUB}/api/v1/agents/UMBRA-TEST-0001/status"
```

Sandbox on production (`UMBRA-TEST-0001` = verified, `UMBRA-TEST-0005` = revoked). Integrator quickstart: {HUB}/integrators

(If off-topic, ignore — no auto-followups.)
"""


def main() -> int:
    token = os.getenv("GITHUB_TOKEN", "").strip()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    seen: set[str] = set()
    leads: list[dict] = []

    for q in QUERIES:
        try:
            data = gh_search(q, token)
        except urllib.error.HTTPError as e:
            print(json.dumps({"ok": False, "query": q, "http": e.code}), file=sys.stderr)
            continue
        except urllib.error.URLError as e:
            print(json.dumps({"ok": False, "query": q, "error": str(e.reason)}), file=sys.stderr)
            continue
        for item in data.get("items") or []:
            url = item.get("html_url") or ""
            if not url or url in seen:
                continue
            if item.get("pull_request"):
                continue
            seen.add(url)
            body = draft_comment(item)
            safe = re.sub(r"[^a-zA-Z0-9]+", "_", url)[-80:]
            md_path = OUT_DIR / f"{stamp}_{safe}.md"
            md_path.write_text(
                f"# Scout draft\n\n- **URL:** {url}\n- **Query:** `{q}`\n\n## Suggested comment\n\n{body}\n",
                encoding="utf-8",
            )
            leads.append(
                {
                    "url": url,
                    "title": item.get("title"),
                    "repo": (item.get("repository_url") or "").split("/repos/")[-1],
                    "updated_at": item.get("updated_at"),
                    "query": q,
                    "draft_file": str(md_path),
                }
            )
            if len(leads) >= MAX_PER_QUERY * len(QUERIES):
                break

    summary = {"ok": True, "ts": stamp, "count": len(leads), "leads": leads}
    summary_path = OUT_DIR / f"summary-{stamp}.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
