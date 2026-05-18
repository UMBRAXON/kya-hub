"""One-shot Moltbook post — Platform Integrator API launch."""
from __future__ import annotations

from typing import Any, Dict

from config import Settings
from pr.crosspost import crosspost
from pr.themes import THEMES


def run_platform_post(settings: Settings) -> Dict[str, Any]:
    theme = next(t for t in THEMES if t.id == "platform_integrator")
    hub = settings.kya_hub_base_url.rstrip("/")
    kya_id = settings.kya_id or "UMBRA-??????"
    body = theme.template.format(hub=hub, kya_id=kya_id)
    title = theme.title
    if settings.pr_hub_url_required and hub not in body:
        body = f"{body}\n\n{hub}/#platform"
    result = crosspost(
        settings,
        body,
        title=title,
        platforms=["moltbook"],
        dry_run=settings.pr_dry_run,
    )
    return {"theme_id": theme.id, "title": title, "body_preview": body[:500], "publish": result}
