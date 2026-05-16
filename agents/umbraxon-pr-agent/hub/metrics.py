"""Public (+ optional admin) hub metrics for PR reports."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

_USER_AGENT = "umbraxon-pr-agent/1.0 (KYA Hub M2M)"


def _get(url: str, headers: Optional[Dict[str, str]] = None, timeout: float = 15.0) -> Dict[str, Any]:
    h = {"Accept": "application/json", "User-Agent": _USER_AGENT}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def fetch_public_snapshot(base_url: str) -> Dict[str, Any]:
    base = base_url.rstrip("/")
    out: Dict[str, Any] = {"hub": base, "sources": {}}
    try:
        out["health"] = _get(f"{base}/api/health")
        out["sources"]["health"] = "ok"
    except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        out["health"] = {"error": str(e)}
        out["sources"]["health"] = "fail"
    try:
        tiers = _get(f"{base}/api/tiers")
        out["tiers"] = tiers
        out["sources"]["tiers"] = "ok"
    except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        out["tiers"] = {"error": str(e)}
        out["sources"]["tiers"] = "fail"
    try:
        disc = _get(f"{base}/api/discovery/v1/agents.json?limit=200")
        agents = disc.get("agents") if isinstance(disc, dict) else None
        out["discovery_count"] = len(agents) if isinstance(agents, list) else None
        out["discovery_sample"] = (agents or [])[:5]
        out["sources"]["discovery"] = "ok"
    except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        out["discovery_count"] = None
        out["sources"]["discovery"] = str(e)
    admin_key = os.getenv("KYA_ADMIN_API_KEY") or os.getenv("ADMIN_API_KEY") or ""
    if admin_key.strip():
        try:
            out["ops_summary"] = _get(
                f"{base}/api/admin/ops-summary",
                headers={"X-Admin-Key": admin_key.strip()},
            )
            out["sources"]["ops_summary"] = "ok"
        except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as e:
            out["ops_summary"] = {"error": str(e)}
            out["sources"]["ops_summary"] = "fail"
    return out
