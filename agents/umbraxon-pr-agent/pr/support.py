"""Developer support / partnership draft (LLM, no auto-send)."""
from __future__ import annotations

from typing import Optional

from config import Settings
from pr.promote import _openai_chat

SUPPORT_PROMPT = """Si technický support pre Umbraxon KYA Hub.
Odpovedáš developerom, ktorí chcú registrovať autonómneho bota (M2M).
Vysvetli: POST /api/v1/register, Ed25519 manifest, PoW, Lightning platba, poll status, GET cert.
Buď stručný, presný, bez predaja. Max 350 slov."""


def draft_support_reply(settings: Settings, question: str) -> str:
    if not settings.llm_api_key:
        return (
            f"[set LLM_API_KEY]\n\nKYA Hub M2M register: POST {settings.kya_hub_base_url}/api/v1/register\n"
            f"Docs: {settings.kya_hub_base_url}/README_API.md\n\nQuestion: {question}"
        )
    user = f"Developer question:\n{question}\n\nHub: {settings.kya_hub_base_url}"
    return _openai_chat(settings, user, system=SUPPORT_PROMPT)


def draft_partnership_pitch(settings: Settings, context: Optional[str] = None) -> str:
    if not settings.llm_api_key:
        return "[set LLM_API_KEY for partnership draft]"
    user = (
        "Draft a neutral partnership exploration message between KYA Hub and another agent platform. "
        f"No hard sell. Hub: {settings.kya_hub_base_url}. Context: {context or 'general M2M'}"
    )
    return _openai_chat(settings, user, system=SUPPORT_PROMPT)
