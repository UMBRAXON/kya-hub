"""Moltbook feed monitor + thoughtful comment replies (anti-spam limits)."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from config import Settings
from connectors.moltbook import MoltbookConnector
from hub.api_docs import fetch_hub_api_docs, summarize_for_prompt
from pr.promote import _openai_chat
from pr.spam_guard import content_hash, validate_content
from pr import state

COMMENT_SYSTEM = """You are the official Umbraxon KYA Hub PR ambassador on Moltbook.
Write ONE short comment (2–4 sentences). Technical, helpful, never spammy.
No hype, no "to the moon". Mention hub URL at most once if relevant.
Canonical register endpoint: POST {hub}/api/v1/register
"""

_RELEVANCE = re.compile(
    r"\b(agent|m2m|machine.to.machine|autonomous|lightning|kya|registry|"
    r"ed25519|nwc|wallet.?connect|identity|bot|molty|hub)\b",
    re.I,
)


def _agent_name(settings: Settings) -> str:
    return (settings.moltbook_agent_name or "umbraxon-pr-ambassador").lower()


def _reply_language(settings: Settings, text: str) -> str:
    lang = (settings.moltbook_reply_language or "en").lower()
    if lang in ("auto", "match"):
        if re.search(r"[áäčďéíĺľňóôŕšťúýž]", text, re.I):
            return "sk"
        return "en"
    return lang if lang in ("en", "sk") else "en"


def _may_comment_now(settings: Settings) -> Tuple[bool, Optional[str]]:
    if settings.pr_dry_run:
        return False, "pr_dry_run"
    if not settings.moltbook_auto_reply:
        return False, "moltbook_auto_reply_disabled"
    if not settings.moltbook_api_key:
        return False, "missing_moltbook_api_key"
    hours = state.hours_since_last_comment()
    if hours is not None and hours < settings.moltbook_min_hours_between_comments:
        return False, f"comment_cadence: {hours:.1f}h ago (min {settings.moltbook_min_hours_between_comments}h)"
    return True, None


def _validate_comment(text: str, settings: Settings) -> Tuple[bool, List[str]]:
    return validate_content(
        text,
        settings,
        min_chars=settings.moltbook_min_comment_chars,
        require_hub_url=True,
    )


def _is_relevant(text: str, settings: Settings) -> bool:
    low = (text or "").lower()
    if _RELEVANCE.search(low):
        return True
    for kw in settings.moltbook_feed_keywords:
        if kw.lower() in low:
            return True
    return False


def _already_replied_to_thread(comments: List[Dict[str, Any]], agent: str) -> bool:
    for c in comments:
        author = ((c.get("author") or {}).get("name") or "").lower()
        if author == agent:
            return True
        for r in c.get("replies") or []:
            if ((r.get("author") or {}).get("name") or "").lower() == agent:
                return True
    return False


def _generate_reply(
    settings: Settings,
    *,
    post_title: str,
    post_content: str,
    comment_content: str,
    context: str,
) -> str:
    lang = _reply_language(settings, f"{post_title}\n{post_content}\n{comment_content}")
    lang_instruction = "Write in English." if lang == "en" else "Píš po slovensky."
    docs = ""
    if settings.llm_api_key:
        docs = summarize_for_prompt(fetch_hub_api_docs(settings.kya_hub_base_url), max_chars=3000)
    user = (
        f"{lang_instruction}\n"
        f"Context: {context}\n\n"
        f"Post title: {post_title}\n"
        f"Post body:\n{(post_content or '')[:2000]}\n\n"
        f"Comment to respond to:\n{(comment_content or '')[:1500]}\n\n"
        f"Hub facts:\n{docs}\n\n"
        "Write only the comment body."
    )
    system = COMMENT_SYSTEM.format(hub=settings.kya_hub_base_url)
    if settings.llm_api_key:
        try:
            return _openai_chat(settings, user, system=system).strip()
        except Exception:
            pass
    if lang == "sk":
        return (
            f"Ďakujeme za záujem. KYA Hub: M2M registrácia cez "
            f"POST {settings.kya_hub_base_url}/api/v1/register — "
            f"Ed25519, Lightning, discovery. Docs: {settings.kya_hub_base_url}/README_API.md"
        )
    return (
        f"Thanks for the interest. KYA Hub offers M2M registration via "
        f"POST {settings.kya_hub_base_url}/api/v1/register (Ed25519 + Lightning). "
        f"Docs: {settings.kya_hub_base_url}/README_API.md"
    )


def _post_reply(
    mb: MoltbookConnector,
    settings: Settings,
    post_id: str,
    parent_id: Optional[str],
    body: str,
    *,
    dry_run: bool,
) -> Dict[str, Any]:
    ok, reasons = _validate_comment(body, settings)
    if not ok:
        return {"ok": False, "blocked": True, "reasons": reasons}
    if dry_run:
        return {"ok": True, "dry_run": True, "preview": body[:400]}
    out = mb.create_comment(post_id, body, parent_id=parent_id or None)
    if out.get("success") or out.get("comment"):
        comment = out.get("comment") or {}
        cid = comment.get("id") or ""
        ver = comment.get("verification")
        vstat = comment.get("verification_status") or comment.get("verificationStatus")
        if ver and vstat == "pending":
            from pr.moltbook_verify import verify_post

            out["verification_result"] = verify_post(settings, ver)
        if cid:
            state.mark_comment_replied(cid, post_id=post_id, parent_id=parent_id)
        try:
            mb.mark_post_notifications_read(post_id)
        except OSError:
            pass
        return {"ok": True, "comment_id": cid, "response": out}
    return {"ok": False, "error": out}


def engage_own_posts(
    settings: Settings,
    mb: MoltbookConnector,
    *,
    budget: int,
    dry_run: bool,
) -> List[Dict[str, Any]]:
    if not settings.moltbook_reply_on_own_posts or budget <= 0:
        return []
    actions: List[Dict[str, Any]] = []
    agent = _agent_name(settings)
    home = mb.get_home()
    for item in home.get("activity_on_your_posts") or []:
        if budget <= 0:
            break
        post_id = item.get("post_id") or ""
        if not post_id:
            continue
        data = mb.list_comments(post_id)
        comments = data.get("comments") or []
        if _already_replied_to_thread(comments, agent):
            continue
        for c in comments:
            if budget <= 0:
                break
            cid = c.get("id") or ""
            author = ((c.get("author") or {}).get("name") or "").lower()
            if not cid or author == agent:
                continue
            if cid in state.replied_comment_ids():
                continue
            if c.get("is_deleted"):
                continue
            body = _generate_reply(
                settings,
                post_title=item.get("post_title") or "",
                post_content="",
                comment_content=c.get("content") or "",
                context="Reply to a comment on your own Moltbook post.",
            )
            result = _post_reply(
                mb, settings, post_id, cid, body, dry_run=dry_run
            )
            actions.append({
                "type": "reply_on_own_post",
                "post_id": post_id,
                "parent_comment_id": cid,
                "author": author,
                "result": result,
            })
            if result.get("ok"):
                budget -= 1
            break
    return actions


def engage_feed(
    settings: Settings,
    mb: MoltbookConnector,
    *,
    budget: int,
    dry_run: bool,
) -> List[Dict[str, Any]]:
    if not settings.moltbook_reply_on_feed or budget <= 0:
        return []
    actions: List[Dict[str, Any]] = []
    agent = _agent_name(settings)
    feed = mb.get_feed(limit=settings.moltbook_feed_scan_limit)
    for post in feed.get("posts") or []:
        if budget <= 0:
            break
        post_id = post.get("id") or ""
        author = ((post.get("author") or {}).get("name") or "").lower()
        title = post.get("title") or ""
        content = post.get("content") or ""
        if not post_id or author == agent:
            continue
        if post_id in state.replied_post_ids():
            continue
        if not _is_relevant(f"{title}\n{content}", settings):
            continue
        data = mb.list_comments(post_id, limit=10)
        if _already_replied_to_thread(data.get("comments") or [], agent):
            continue
        body = _generate_reply(
            settings,
            post_title=title,
            post_content=content,
            comment_content="",
            context="Thoughtful top-level comment on a relevant feed post (not your post).",
        )
        result = _post_reply(mb, settings, post_id, None, body, dry_run=dry_run)
        actions.append({
            "type": "feed_comment",
            "post_id": post_id,
            "author": author,
            "title": title[:80],
            "result": result,
        })
        if result.get("ok"):
            budget -= 1
    return actions


def run_moltbook_engage(settings: Settings) -> Dict[str, Any]:
    allowed, reason = _may_comment_now(settings)
    if not allowed:
        return {"ok": False, "skipped": True, "reason": reason}
    mb = MoltbookConnector(settings.moltbook_base_url, settings.moltbook_api_key)
    if not mb.authenticate():
        return {"ok": False, "error": "moltbook_auth_failed"}
    dry_run = settings.pr_dry_run
    budget = settings.moltbook_max_replies_per_run
    own = engage_own_posts(settings, mb, budget=budget, dry_run=dry_run)
    budget -= sum(1 for a in own if (a.get("result") or {}).get("ok"))
    feed = engage_feed(settings, mb, budget=max(0, budget), dry_run=dry_run)
    posted = sum(
        1 for a in own + feed if (a.get("result") or {}).get("ok") and not (a.get("result") or {}).get("dry_run")
    )
    return {
        "ok": True,
        "dry_run": dry_run,
        "posted": posted,
        "own_post_replies": own,
        "feed_comments": feed,
    }
