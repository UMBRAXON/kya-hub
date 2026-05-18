"""Cross-post YouTube KYA Hub intro video to Moltbook + Nostr."""
from __future__ import annotations

from typing import Any, Dict

from config import Settings
from pr.crosspost import crosspost

PROMO_VIDEO_URL = "https://www.youtube.com/watch?v=Z6Fb2LFBPtY"


def build_promo_video_body(settings: Settings) -> str:
    hub = settings.kya_hub_base_url.rstrip("/")
    return f"""90-second intro for developers — **Know Your Agent** (KYA Hub)

Watch: {PROMO_VIDEO_URL}

Fake AI agents are cheap to clone. KYA Hub is a public trust layer: cryptographic identity, Lightning skin-in-the-game, verifiable certificates — built for machines, not signup forms.

Everything else: {hub}/#intro-video (video embed, plug-in API, docs, GitHub)."""


def run_promo_video_post(settings: Settings) -> Dict[str, Any]:
    body = build_promo_video_body(settings)
    title = "Know Your Agent — 90s intro (UMBRAXON KYA Hub)"
    result = crosspost(
        settings,
        body,
        title=title,
        platforms=["moltbook", "nostr"],
        dry_run=settings.pr_dry_run,
    )
    return {"title": title, "body_preview": body[:500], "video": PROMO_VIDEO_URL, "publish": result}
