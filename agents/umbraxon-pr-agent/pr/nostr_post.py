"""Themed Nostr notes — Mon/Wed/Fri cadence (separate from daily Moltbook)."""
from __future__ import annotations

from typing import Any, Dict

from config import Settings
from pr.crosspost import crosspost
from pr.themes import build_nostr_post


def run_nostr_post(settings: Settings) -> Dict[str, Any]:
    title, body, theme_id = build_nostr_post(settings)
    hub = settings.kya_hub_base_url.rstrip("/")
    if settings.pr_hub_url_required and hub not in body:
        suffix = f"{hub}/#platform" if theme_id == "platform_integrator" else f"{hub}/bots/"
        body = f"{body}\n\n{suffix}"
    result = crosspost(
        settings,
        body,
        title=title,
        platforms=["nostr"],
        dry_run=settings.pr_dry_run,
    )
    return {
        "theme_id": theme_id,
        "title": title,
        "body_preview": body[:400],
        "publish": result,
    }
