"""Persistent PR agent state (post cadence, GitHub leads, heartbeat)."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_DEFAULT_DIR = Path(__file__).resolve().parents[1] / "memory"


def state_path(name: str = "pr-state.json") -> Path:
    d = Path(os.getenv("PR_STATE_DIR", str(_DEFAULT_DIR)))
    d.mkdir(parents=True, exist_ok=True)
    return d / name


def load_state() -> Dict[str, Any]:
    p = state_path()
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(data: Dict[str, Any]) -> None:
    p = state_path()
    p.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.chmod(p, 0o600)


def record_post(platform: str, content_hash: str, *, title: Optional[str] = None) -> None:
    st = load_state()
    posts: List[Dict[str, Any]] = st.get("posts") or []
    posts.append({
        "ts": time.time(),
        "platform": platform,
        "content_hash": content_hash,
        "title": title,
    })
    st["posts"] = posts[-200:]
    st["last_post_ts"] = time.time()
    save_state(st)


def hours_since_last_post() -> Optional[float]:
    st = load_state()
    ts = st.get("last_post_ts")
    if not ts:
        return None
    return (time.time() - float(ts)) / 3600.0


def github_contacted() -> set:
    st = load_state()
    return set(st.get("github_contacted") or [])


def mark_github_contacted(repo_full_name: str) -> None:
    st = load_state()
    contacted = list(github_contacted() | {repo_full_name})
    st["github_contacted"] = contacted[-500:]
    save_state(st)


def get_set(key: str, default: Any = None) -> Any:
    return load_state().get(key, default)


def put(key: str, value: Any) -> None:
    st = load_state()
    st[key] = value
    save_state(st)


def replied_comment_ids() -> set:
    st = load_state()
    return set(st.get("moltbook_replied_comments") or [])


def replied_post_ids() -> set:
    st = load_state()
    return set(st.get("moltbook_replied_posts") or [])


def mark_comment_replied(
    comment_id: str,
    *,
    post_id: str,
    parent_id: str | None = None,
) -> None:
    st = load_state()
    ids = list(replied_comment_ids() | {comment_id})
    st["moltbook_replied_comments"] = ids[-2000:]
    posts = list(replied_post_ids() | {post_id})
    st["moltbook_replied_posts"] = posts[-500:]
    comments: List[Dict[str, Any]] = st.get("moltbook_comments") or []
    comments.append({
        "ts": time.time(),
        "comment_id": comment_id,
        "post_id": post_id,
        "parent_id": parent_id,
    })
    st["moltbook_comments"] = comments[-300:]
    st["last_comment_ts"] = time.time()
    save_state(st)


def hours_since_last_comment() -> Optional[float]:
    st = load_state()
    ts = st.get("last_comment_ts")
    if not ts:
        return None
    return (time.time() - float(ts)) / 3600.0
