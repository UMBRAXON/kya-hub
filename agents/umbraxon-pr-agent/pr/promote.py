"""PR copy generation via configured LLM."""
from __future__ import annotations

from typing import Any, Dict, Optional

from config import Settings
from hub.api_docs import fetch_hub_api_docs, summarize_for_prompt

def system_prompt_for_posts(settings: Settings, *, force_lang: str | None = None) -> str:
    lang = (force_lang or getattr(settings, "pr_post_language", "en") or "en").lower()
    if lang == "sk":
        lang_line = "Píš po slovensky."
    elif lang == "en":
        lang_line = "Write in English (primary audience: international M2M developers)."
    else:
        lang_line = "Write in English unless the brief explicitly requests another language."
    return f"""You are the official technical PR ambassador for Umbraxon KYA Hub.
Share infrastructure updates, metrics, and real project value for the M2M agent economy.
Never spam; provide technical insight, not hype.
{lang_line}
No "to the moon", no repeated CTAs. Max 280 words."""


def system_prompt_for_moltbook(settings: Settings) -> str:
    """Moltbook is English-only (international dev/agent audience)."""
    return system_prompt_for_posts(settings, force_lang="en")


SYSTEM_PROMPT = """Si oficiálny technický PR ambasádor pre Umbraxon KYA Hub."""


def promote_hub(
    settings: Settings,
    *,
    audience: str = "m2m_developers",
    extra_context: Optional[str] = None,
) -> str:
    """Generate one technical outreach post using hub API docs + live metrics hint."""
    docs = summarize_for_prompt(fetch_hub_api_docs(settings.kya_hub_base_url))
    user_parts = [
        f"Audience: {audience}",
        f"Hub base URL: {settings.kya_hub_base_url}",
        "API documentation excerpt:",
        docs,
    ]
    if extra_context:
        user_parts.append(f"Extra context:\n{extra_context}")
    user_parts.append(
        "Write a single post announcing KYA Hub value for autonomous agents "
        "(identity, Lightning registration, reputation, discovery feed)."
    )
    user_message = "\n\n".join(user_parts)

    if not settings.llm_api_key:
        return (
            "Umbraxon KYA Hub — portable identity for autonomous M2M agents.\n\n"
            f"Register: POST {settings.kya_hub_base_url}/api/v1/register\n"
            "Ed25519 manifest, Lightning payment (BASIC tier), reputation & public discovery.\n"
            f"Docs: {settings.kya_hub_base_url}/README_API.md"
        )

    if settings.llm_provider == "openai":
        return _openai_chat(settings, user_message, system=system_prompt_for_posts(settings))
    raise ValueError(f"Unsupported LLM_PROVIDER: {settings.llm_provider}")


def _openai_chat(
    settings: Settings,
    user_message: str,
    *,
    system: Optional[str] = None,
) -> str:
    from openai import OpenAI

    kwargs: Dict[str, Any] = {"api_key": settings.llm_api_key}
    if settings.llm_base_url:
        kwargs["base_url"] = settings.llm_base_url
    client = OpenAI(**kwargs)
    resp = client.chat.completions.create(
        model=settings.llm_model,
        messages=[
            {"role": "system", "content": system or SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        max_tokens=500,
        temperature=0.6,
    )
    return (resp.choices[0].message.content or "").strip()
