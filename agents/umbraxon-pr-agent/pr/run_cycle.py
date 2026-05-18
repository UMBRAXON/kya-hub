"""Full PR cycle: heartbeat → daily themed post → optional GitHub leads."""
from __future__ import annotations

from typing import Any, Dict

from config import Settings
from connectors.telegram_bot import TelegramConnector
from leads.github import process_leads
from pr.daily_post import run_daily_post
from pr.heartbeat import moltbook_heartbeat
from pr.kya_heartbeat import kya_hub_heartbeat
from pr.moltbook_engage import run_moltbook_engage


def run_cycle(
    settings: Settings,
    *,
    audience: str = "m2m_developers",
    force_weekly: bool = False,
    skip_github: bool = True,
    publish: bool = True,
) -> Dict[str, Any]:
    del audience, force_weekly  # daily themes replace generic promote / monday report
    result: Dict[str, Any] = {"steps": {}}

    result["steps"]["kya_hub_heartbeat"] = kya_hub_heartbeat(settings)
    result["steps"]["moltbook_heartbeat"] = moltbook_heartbeat(settings)
    result["steps"]["moltbook_engage"] = run_moltbook_engage(settings)

    if settings.telegram_bot_token:
        tg = TelegramConnector(
            settings.telegram_bot_token,
            settings.telegram_notify_chat_id,
            settings.telegram_monitor_keywords,
            settings.telegram_auto_reply,
            settings.kya_hub_base_url,
        )
        if tg.authenticate():
            result["steps"]["telegram_scan"] = tg.scan_keywords()

    if publish:
        result["steps"]["daily_post"] = run_daily_post(settings)

    if not skip_github:
        result["steps"]["github_leads"] = process_leads(settings)

    return result
