#!/usr/bin/env python3
"""HN + Reddit keyword scan → logs/growth/community-*.json (no auto-post)."""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UA = "kya-growth-listener/1.0 (contact: hello@umbraxon.xyz)"
QUERIES = [
    q.strip()
    for q in os.getenv(
        "COMMUNITY_QUERIES",
        "lightning agent,AI agent verification,L402,sybil bot",
    ).split(",")
    if q.strip()
]
OUT_DIR = Path(os.getenv("GROWTH_LOG_DIR", "/root/kya-hub/logs/growth"))


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def hn_hits(query: str) -> list[dict]:
    q = urllib.parse.quote(query)
    data = fetch_json(
        f"https://hn.algolia.com/api/v1/search?query={q}&tags=story&hitsPerPage=5"
    )
    out = []
    for h in data.get("hits") or []:
        oid = h.get("objectID")
        url = h.get("url") or (f"https://news.ycombinator.com/item?id={oid}" if oid else "")
        out.append(
            {
                "source": "hn",
                "query": query,
                "title": h.get("title"),
                "url": url,
                "points": h.get("points"),
            }
        )
    return out


def reddit_hits(query: str) -> list[dict]:
    q = urllib.parse.quote(query)
    try:
        data = fetch_json(f"https://www.reddit.com/search.json?q={q}&sort=new&limit=5")
    except Exception as e:
        return [{"source": "reddit", "query": query, "error": str(e)}]
    out = []
    for c in data.get("data", {}).get("children") or []:
        d = c.get("data") or {}
        out.append(
            {
                "source": "reddit",
                "query": query,
                "title": d.get("title"),
                "url": f"https://reddit.com{d.get('permalink', '')}",
            }
        )
    return out


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    doc = {
        "ts": stamp,
        "hn": [h for q in QUERIES for h in hn_hits(q)],
        "reddit": [h for q in QUERIES for h in reddit_hits(q)],
    }
    path = OUT_DIR / f"community-{stamp}.json"
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    latest = OUT_DIR / "community-latest.json"
    if latest.exists() or True:
        latest.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "path": str(path), "hn": len(doc["hn"]), "reddit": len(doc["reddit"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
