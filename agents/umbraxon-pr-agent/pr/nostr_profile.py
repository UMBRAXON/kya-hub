"""Publish Nostr kind-0 profile (bio) for the PR ambassador key."""
from __future__ import annotations

from typing import Any, Dict

from config import Settings
from pr.connectors_registry import connectors_for_platform


def default_profile_fields(settings: Settings) -> Dict[str, str]:
    hub = settings.kya_hub_base_url.rstrip("/")
    kya = (settings.kya_id or "UMBRA-000467").strip()
    faq_platform = (
        f"{hub}/docs/FAQ-FOR-BOT-DEVELOPERS.md"
        "#i-platform-integrator-plug-in--third-party-systems"
    )
    return {
        "name": "Umbraxon KYA Hub",
        "display_name": "Umbraxon KYA Hub",
        "about": (
            "Know Your Agent — M2M identity, Lightning registration, reputation. "
            "Plug-in API: verify KYA agents in your product before the gate runs. "
            "Intro video: https://www.youtube.com/watch?v=Z6Fb2LFBPtY · "
            f"FAQ §I: {faq_platform} · "
            f"Portal: {hub}/#platform · "
            f"GitHub: https://github.com/UMBRAXON/kya-hub · "
            f"Agent {kya}."
        ),
        "website": f"{hub}/#platform",
        "picture": f"{hub}/favicon.ico",
    }


def publish_nostr_profile(
    settings: Settings,
    *,
    fields: Dict[str, str] | None = None,
    dry_run: bool | None = None,
) -> Dict[str, Any]:
    dry = settings.pr_dry_run if dry_run is None else dry_run
    conn = connectors_for_platform(settings, "nostr")
    if not conn:
        return {"ok": False, "skipped": True, "reason": "nostr not configured"}
    meta = {**default_profile_fields(settings), **(fields or {})}
    if dry:
        return {"ok": True, "dry_run": True, "profile": meta}
    publish = getattr(conn, "publish_profile", None)
    if not callable(publish):
        return {"ok": False, "error": "connector missing publish_profile"}
    return publish(meta)
