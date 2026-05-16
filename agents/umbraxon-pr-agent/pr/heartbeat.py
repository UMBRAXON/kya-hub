"""Moltbook heartbeat — skill.md periodic check."""
from __future__ import annotations

import time
import urllib.request
from typing import Any, Dict

from config import Settings
from connectors.moltbook import MoltbookConnector
from pr import state


def moltbook_heartbeat(settings: Settings) -> Dict[str, Any]:
    out: Dict[str, Any] = {"ts": time.time()}
    try:
        req = urllib.request.Request(
            "https://www.moltbook.com/heartbeat.md",
            headers={"User-Agent": "umbraxon-pr-agent/1.0"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            out["heartbeat_md_bytes"] = len(resp.read())
    except OSError as e:
        out["heartbeat_md_error"] = str(e)
    if settings.moltbook_api_key:
        mb = MoltbookConnector(settings.moltbook_base_url, settings.moltbook_api_key)
        if mb.authenticate():
            out["claim_status"] = mb.claim_status()
        else:
            out["api"] = "unavailable_or_error"
    state.put("lastMoltbookCheck", time.time())
    return out
