"""Weekly 'State of the AI Agent Economy' style report (anonymized hub metrics)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from config import Settings
from hub.metrics import fetch_public_snapshot
from pr.promote import SYSTEM_PROMPT, _openai_chat


def build_weekly_report(settings: Settings) -> str:
    snap = fetch_public_snapshot(settings.kya_hub_base_url)
    health = snap.get("health") or {}
    disc_n = snap.get("discovery_count")
    tiers = snap.get("tiers") or {}
    ops = snap.get("ops_summary") or {}

    lines = [
        "# State of the AI Agent Economy (Umbraxon KYA Hub)",
        f"_Week of {datetime.now(timezone.utc).strftime('%Y-%m-%d')} UTC — anonymized infrastructure snapshot_",
        "",
        "## Infrastructure health",
        f"- Hub: {settings.kya_hub_base_url}",
        f"- Server: {health.get('server', '?')}",
        f"- Database: {(health.get('db') or {}).get('status', health.get('database', '?'))}",
        f"- Alby/BTCPay: {health.get('alby', '?')} / {(health.get('btcpay') or {}).get('status', '?')}",
        "",
        "## Agent discovery (opt-in, public index)",
        f"- Agents listed in discovery feed: **{disc_n if disc_n is not None else 'n/a'}**",
        "",
        "## Registration tiers (reference)",
    ]
    tier_list = tiers if isinstance(tiers, list) else tiers.get("tiers") or []
    for t in tier_list[:5]:
        if isinstance(t, dict):
            lines.append(f"- {t.get('name', t.get('tier', '?'))}: {t.get('total_sats', t.get('price_sats', '?'))} sats")
    if ops and not ops.get("error"):
        intents = ops.get("registration_intents") or []
        if intents:
            lines.extend(["", "## Registration intents (aggregate)"])
            for row in intents[:8]:
                if isinstance(row, dict):
                    lines.append(f"- {row.get('status', '?')}: {row.get('count', '?')}")
        agents = ops.get("agents_active_by_tier") or ops.get("active_agents")
        if agents:
            lines.extend(["", "## Active agents", str(agents)[:500]])
    lines.extend([
        "",
        "## M2M onboarding",
        f"- Canonical register: `POST {settings.kya_hub_base_url}/api/v1/register`",
        f"- Public docs: {settings.kya_hub_base_url}/README_API.md",
        "",
        "_No individual agent PII. Metrics are infrastructure-level only._",
    ])
    draft = "\n".join(lines)

    if not settings.llm_api_key:
        return draft

    prompt = (
        "Rewrite this weekly infrastructure report for technical M2M developers. "
        "Keep facts exact, add 2-3 insights, no hype, max 400 words. Slovak or English.\n\n"
        + draft
    )
    try:
        return _openai_chat(settings, prompt)
    except Exception:
        return draft


def report_title() -> str:
    return f"KYA Hub weekly — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
