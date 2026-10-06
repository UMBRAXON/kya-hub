"""One-shot Moltbook post for a named theme (audit launch, operator override)."""
from __future__ import annotations

from typing import Any, Dict, Optional

from config import Settings
from pr.crosspost import crosspost
from pr.themes import build_themed_post


def run_themed_post(
    settings: Settings,
    theme_id: str,
    *,
    skip_cadence: bool = False,
) -> Dict[str, Any]:
    title, body, resolved_id = build_themed_post(settings, theme_id)
    result = crosspost(
        settings,
        body,
        title=title,
        platforms=["moltbook"],
        dry_run=settings.pr_dry_run,
        skip_cadence=skip_cadence,
        utm_content=resolved_id,
    )
    return {
        "theme_id": resolved_id,
        "title": title,
        "body_preview": body[:500],
        "publish": result,
        "skip_cadence": skip_cadence,
    }
