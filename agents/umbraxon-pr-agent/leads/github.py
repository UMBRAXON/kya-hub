"""GitHub lead scan — new AI-agent repos (dry-run outreach by default)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from config import Settings
from pr import state

_GH_API = "https://api.github.com"


def search_repositories(settings: Settings) -> Dict[str, Any]:
    q = settings.github_search_query.strip()
    created_after = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%d")
    query = f"{q} created:>{created_after}"
    params = urllib.parse.urlencode({
        "q": query,
        "sort": "updated",
        "order": "desc",
        "per_page": min(settings.github_max_leads_per_run * 3, 30),
    })
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "umbraxon-pr-agent/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if settings.github_token:
        headers["Authorization"] = f"Bearer {settings.github_token}"
    url = f"{_GH_API}/search/repositories?{params}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"ok": False, "http_status": e.code, "body": e.read().decode("utf-8", errors="replace")[:400]}
    contacted = state.github_contacted()
    leads: List[Dict[str, Any]] = []
    for item in (data.get("items") or [])[: settings.github_max_leads_per_run * 2]:
        full = item.get("full_name") or ""
        if not full or full in contacted:
            continue
        leads.append({
            "full_name": full,
            "html_url": item.get("html_url"),
            "description": (item.get("description") or "")[:300],
            "stars": item.get("stargazers_count"),
            "updated_at": item.get("updated_at"),
        })
        if len(leads) >= settings.github_max_leads_per_run:
            break
    return {"ok": True, "query": query, "leads": leads, "total_count": data.get("total_count")}


def outreach_message(settings: Settings, repo: Dict[str, Any]) -> str:
    return (
        f"Hi — building autonomous agents on `{repo.get('full_name')}`?\n\n"
        f"Umbraxon KYA Hub offers M2M agent identity (Ed25519), Lightning registration "
        f"(`POST /api/v1/register`), reputation, and a public discovery feed.\n\n"
        f"Docs: {settings.kya_hub_base_url}/README_API.md\n"
        f"Register: {settings.kya_hub_base_url}/api/v1/register\n\n"
        f"_Automated outreach from UMBRAXON-PR-AMBASSADOR — reply if this isn't relevant._"
    )


def process_leads(settings: Settings) -> Dict[str, Any]:
    scan = search_repositories(settings)
    if not scan.get("ok"):
        return scan
    actions: List[Dict[str, Any]] = []
    out_dir = os.getenv("PR_LEADS_DIR", "/root/kya-hub/logs/pr-agent/leads")
    os.makedirs(out_dir, exist_ok=True)
    for repo in scan.get("leads") or []:
        msg = outreach_message(settings, repo)
        action = {
            "repo": repo["full_name"],
            "url": repo.get("html_url"),
            "message_preview": msg[:400],
            "dry_run": settings.github_outreach_dry_run,
        }
        if not settings.github_outreach_dry_run:
            action["note"] = "manual: open GitHub Discussion/Issue — auto-issue not enabled (anti-spam)"
        else:
            fname = f"{out_dir}/github-{repo['full_name'].replace('/', '_')}.txt"
            with open(fname, "w", encoding="utf-8") as f:
                f.write(msg)
            action["saved"] = fname
        state.mark_github_contacted(repo["full_name"])
        actions.append(action)
    return {"ok": True, "query": scan.get("query"), "actions": actions}
