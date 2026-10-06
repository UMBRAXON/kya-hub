"""Umbraxon-only tracked links for PR agent (never NaKus)."""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from config import Settings

_HUB_URL_RE_CACHE: dict[str, re.Pattern[str]] = {}


def hub_host(settings: Settings) -> str:
    return (urlparse(settings.kya_hub_base_url).netloc or "").lower()


def hub_url(
    settings: Settings,
    path: str = "",
    *,
    medium: str = "moltbook",
    content: Optional[str] = None,
) -> str:
    """Build https://www.umbraxon.xyz/... with UTM (Umbraxon / KYA only)."""
    base = settings.kya_hub_base_url.rstrip("/")
    if path:
        if not path.startswith("/"):
            path = "/" + path
        url = f"{base}{path}"
    else:
        url = base
    return with_utm(url, settings, medium=medium, content=content)


def with_utm(
    url: str,
    settings: Settings,
    *,
    medium: str = "moltbook",
    content: Optional[str] = None,
) -> str:
    """Attach utm_* to an Umbraxon URL; leave foreign URLs unchanged."""
    raw = (url or "").strip()
    if not raw:
        return raw
    host = hub_host(settings)
    if host and host not in raw.lower():
        return raw
    parsed = urlparse(raw)
    q = dict(parse_qsl(parsed.query, keep_blank_values=True))
    q.setdefault("utm_source", settings.pr_utm_source)
    q.setdefault("utm_medium", medium or settings.pr_utm_medium)
    q.setdefault("utm_campaign", settings.pr_utm_campaign)
    if content:
        q["utm_content"] = re.sub(r"[^a-zA-Z0-9_-]+", "-", content)[:64]
    return urlunparse(parsed._replace(query=urlencode(q)))


def apply_hub_utm(
    text: str,
    settings: Settings,
    *,
    medium: str = "moltbook",
    content: Optional[str] = None,
) -> str:
    """Rewrite every Umbraxon hub URL in text to include UTM params."""
    hub = settings.kya_hub_base_url.rstrip("/")
    if not hub or not text:
        return text
    if hub not in _HUB_URL_RE_CACHE:
        _HUB_URL_RE_CACHE[hub] = re.compile(
            re.escape(hub) + r"(?:/[^\s\]\)\>\"']*)?",
            re.I,
        )
    pattern = _HUB_URL_RE_CACHE[hub]

    def _sub(m: re.Match[str]) -> str:
        return with_utm(m.group(0).rstrip(".,;:"), settings, medium=medium, content=content)

    return pattern.sub(_sub, text)


def ensure_hub_cta(
    text: str,
    settings: Settings,
    *,
    medium: str = "moltbook",
    content: Optional[str] = None,
    path: str = "/README_API.md",
) -> str:
    """If hub URL missing, append one tracked docs CTA (Umbraxon only)."""
    body = (text or "").rstrip()
    host = hub_host(settings)
    if host and host in body.lower():
        return apply_hub_utm(body, settings, medium=medium, content=content)
    cta = hub_url(settings, path, medium=medium, content=content or "cta")
    return apply_hub_utm(f"{body}\n\nDocs: {cta}", settings, medium=medium, content=content)
