"""Build enabled social connectors from settings."""
from __future__ import annotations

from typing import List

from config import Settings
from connectors.base import SocialConnector
from connectors.discord_webhook import DiscordWebhookConnector
from connectors.moltbook import MoltbookConnector
from connectors.nostr import NostrConnector
from connectors.telegram_bot import TelegramConnector
from connectors.x_twitter import XTwitterConnector


def connectors_for_platform(settings: Settings, platform: str) -> SocialConnector | None:
    p = platform.lower().strip()
    if p == "moltbook":
        if not settings.moltbook_api_key:
            return None
        return MoltbookConnector(settings.moltbook_base_url, settings.moltbook_api_key)
    if p == "nostr":
        if not settings.nostr_private_key:
            return None
        return NostrConnector(settings.nostr_private_key, list(settings.nostr_relays))
    if p in ("x", "twitter"):
        return XTwitterConnector(
            settings.x_api_key,
            settings.x_api_secret,
            settings.x_access_token,
            settings.x_access_token_secret,
        )
    if p == "discord":
        if not settings.discord_webhook_url:
            return None
        return DiscordWebhookConnector(settings.discord_webhook_url)
    if p == "telegram":
        if not settings.telegram_bot_token:
            return None
        return TelegramConnector(
            settings.telegram_bot_token,
            settings.telegram_notify_chat_id,
            settings.telegram_monitor_keywords,
            settings.telegram_auto_reply,
            settings.kya_hub_base_url,
        )
    return None


def enabled_connectors(settings: Settings) -> List[tuple[str, SocialConnector]]:
    out: List[tuple[str, SocialConnector]] = []
    for name in settings.pr_publish_platforms:
        c = connectors_for_platform(settings, name)
        if c and c.authenticate():
            out.append((name, c))
    return out
