"""Discord outbound via webhook (announcements channel)."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from connectors.base import SocialConnector


class DiscordWebhookConnector(SocialConnector):
    name = "discord"

    def __init__(self, webhook_url: str) -> None:
        self.webhook_url = webhook_url.strip()

    def authenticate(self) -> bool:
        return bool(self.webhook_url)

    def publish(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.webhook_url:
            return {"ok": False, "skipped": True, "reason": "DISCORD_WEBHOOK_URL missing"}
        title = (metadata or {}).get("title") or "Umbraxon KYA Hub"
        body = text[:1900]
        payload = {
            "username": "UMBRAXON-PR-AMBASSADOR",
            "embeds": [{"title": title[:256], "description": body, "color": 0x5B4FFF}],
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.webhook_url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "umbraxon-pr-agent/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return {"ok": True, "status": resp.status}
        except urllib.error.HTTPError as e:
            return {"ok": False, "http_status": e.code, "body": e.read().decode("utf-8", errors="replace")[:300]}
