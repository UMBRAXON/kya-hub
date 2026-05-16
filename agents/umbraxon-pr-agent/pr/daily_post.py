"""Daily Moltbook post — themed content + publish."""
from __future__ import annotations

from typing import Any, Dict

from config import Settings
from pr.crosspost import crosspost
from pr.themes import build_daily_post


def run_daily_post(settings: Settings) -> Dict[str, Any]:
    title, body, theme_id = build_daily_post(settings)
    if settings.pr_hub_url_required and settings.kya_hub_base_url not in body:
        body = f"{body}\n\n{settings.kya_hub_base_url}/README_API.md"
    result = crosspost(
        settings,
        body,
        title=title,
        platforms=["moltbook"],
        dry_run=settings.pr_dry_run,
    )
    return {
        "theme_id": theme_id,
        "title": title,
        "body_preview": body[:400],
        "publish": result,
    }
