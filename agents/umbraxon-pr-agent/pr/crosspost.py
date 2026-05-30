"""Cross-platform publish with spam guard and per-run limits."""
from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from config import Settings
from connectors.moltbook import MoltbookConnector
from pr.connectors_registry import connectors_for_platform
from pr.spam_guard import content_hash, may_post_now, validate_content
from pr.state import record_post

# Moltbook policy: English only (Mastodon queue may use SK).
_SK_DIACRITICS = set("áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ")


def _moltbook_text_is_english(text: str) -> bool:
    return not any(c in _SK_DIACRITICS for c in text)


def crosspost(
    settings: Settings,
    text: str,
    *,
    title: Optional[str] = None,
    platforms: Optional[List[str]] = None,
    dry_run: Optional[bool] = None,
) -> Dict[str, Any]:
    """Publish to configured platforms (respects PR_MAX_POSTS_PER_RUN)."""
    dry = settings.pr_dry_run if dry_run is None else dry_run
    ok, reasons = validate_content(text, settings)
    if not ok:
        return {"ok": False, "blocked": True, "reasons": reasons}

    targets = platforms or list(settings.pr_publish_platforms)
    results: Dict[str, Any] = {}
    published = 0
    max_p = settings.pr_max_posts_per_run
    h = content_hash(text)

    for name in targets:
        if published >= max_p:
            results[name] = {"ok": False, "skipped": True, "reason": "PR_MAX_POSTS_PER_RUN"}
            continue
        conn = connectors_for_platform(settings, name)
        if not conn:
            results[name] = {"ok": False, "skipped": True, "reason": "not configured"}
            continue
        plat_allowed, plat_reason = may_post_now(settings, platform=name)
        if not plat_allowed and not dry:
            results[name] = {"ok": False, "skipped": True, "reason": plat_reason}
            continue
        if dry:
            results[name] = {"ok": True, "dry_run": True}
            published += 1
            continue
        if name == "moltbook":
            if not _moltbook_text_is_english(text) and os.getenv("MOLTBOOK_ALLOW_NON_ENGLISH") != "1":
                results[name] = {
                    "ok": False,
                    "blocked": True,
                    "reason": "moltbook_english_only",
                }
                continue
        if name == "moltbook" and isinstance(conn, MoltbookConnector):
            st = conn.claim_status()
            status = str(st.get("status") or "").lower()
            if status == "pending_claim":
                results[name] = {"ok": False, "skipped": True, "reason": "moltbook pending_claim"}
                continue
            if not conn.authenticate():
                results[name] = {"ok": False, "error": "moltbook api unavailable"}
                continue
        meta = {"title": title or "Umbraxon KYA Hub"}
        try:
            if not conn.authenticate():
                results[name] = {"ok": False, "skipped": True, "reason": "auth failed"}
                continue
            if name == "moltbook" and isinstance(conn, MoltbookConnector):
                r = conn.publish(text, meta, title=title)
            else:
                r = conn.publish(text, meta)
            results[name] = r
            ok_pub = (
                r.get("success") is True
                or r.get("ok") is True
                or (isinstance(r.get("post"), dict) and r.get("post", {}).get("id"))
            )
            if ok_pub and not r.get("skipped"):
                record_post(name, h, title=title)
                published += 1
        except Exception as e:
            results[name] = {"ok": False, "error": str(e)}

    return {
        "ok": published > 0 or dry,
        "dry_run": dry,
        "published_count": published,
        "content_hash": h,
        "platforms": results,
    }
