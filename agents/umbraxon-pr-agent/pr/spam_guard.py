"""Anti-spam checks before publishing PR content."""
from __future__ import annotations

import hashlib
import re
from typing import List, Optional, Tuple

from config import Settings
from pr.state import load_state, hours_since_last_post as _hours_since

_BANNED_PHRASES = (
    "to the moon",
    "100x",
    "guaranteed returns",
    "click here now",
    "limited time only",
    "act now",
    "free money",
)

_LINK_RE = re.compile(r"https?://", re.I)


def content_hash(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()[:16]


def validate_content(
    text: str,
    settings: Settings,
    *,
    min_chars: Optional[int] = None,
    require_hub_url: Optional[bool] = None,
) -> Tuple[bool, List[str]]:
    reasons: List[str] = []
    t = (text or "").strip()
    min_c = int(min_chars if min_chars is not None else getattr(settings, "pr_min_content_chars", 80))
    if len(t) < min_c:
        reasons.append(f"too_short (min {min_c} chars)")
    if len(t) > 40000:
        reasons.append("too_long")
    links = len(_LINK_RE.findall(t))
    if links > settings.pr_max_links_per_post:
        reasons.append(f"too_many_links ({links}>{settings.pr_max_links_per_post})")
    low = t.lower()
    for phrase in _BANNED_PHRASES:
        if phrase in low:
            reasons.append(f"banned_phrase:{phrase}")
    hub_required = settings.pr_hub_url_required if require_hub_url is None else require_hub_url
    if hub_required and settings.kya_hub_base_url not in t:
        reasons.append("missing_hub_url")
    recent = load_state().get("posts") or []
    h = content_hash(t)
    for p in recent[-20:]:
        if p.get("content_hash") == h:
            reasons.append("duplicate_content")
            break
    return (len(reasons) == 0, reasons)


def may_post_now(settings: Settings, *, platform: Optional[str] = None) -> Tuple[bool, Optional[str]]:
    from pr.state import hours_since_last_post_for_platform

    plat = (platform or "").strip().lower()
    if plat == "nostr":
        hours = hours_since_last_post_for_platform("nostr")
        min_h = settings.nostr_min_hours_between_posts
    else:
        hours = _hours_since()
        min_h = settings.pr_min_hours_between_posts
    if hours is None:
        return True, None
    if hours < min_h:
        label = plat or "global"
        return False, f"cadence ({label}): last post {hours:.1f}h ago (min {min_h}h)"
    return True, None
