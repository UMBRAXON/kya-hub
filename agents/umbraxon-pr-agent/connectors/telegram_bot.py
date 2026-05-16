"""Telegram: notify channel + optional keyword monitor (reply disabled by default)."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from connectors.base import SocialConnector


class TelegramConnector(SocialConnector):
    name = "telegram"

    def __init__(
        self,
        bot_token: str,
        notify_chat_id: str = "",
        keywords: Tuple[str, ...] = (),
        auto_reply: bool = False,
        hub_url: str = "",
    ) -> None:
        self.bot_token = bot_token.strip()
        self.notify_chat_id = notify_chat_id.strip()
        self.keywords = tuple(k.lower() for k in keywords if k)
        self.auto_reply = auto_reply
        self.hub_url = hub_url.rstrip("/")

    def authenticate(self) -> bool:
        if not self.bot_token:
            return False
        try:
            self._api("getMe", {})
            return True
        except OSError:
            return False

    def publish(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.notify_chat_id:
            return {"ok": False, "skipped": True, "reason": "TELEGRAM_NOTIFY_CHAT_ID missing"}
        return self._api(
            "sendMessage",
            {"chat_id": self.notify_chat_id, "text": text[:4000], "disable_web_page_preview": False},
        )

    def scan_keywords(self, limit: int = 20) -> Dict[str, Any]:
        """Read recent updates; optional auto-reply (off by default)."""
        if not self.keywords:
            return {"ok": True, "matches": [], "hint": "no TELEGRAM_MONITOR_KEYWORDS"}
        offset = 0
        try:
            st_file = __import__("pr.state", fromlist=["load_state"]).load_state()
            offset = int(st_file.get("telegram_update_offset") or 0)
        except Exception:
            pass
        data = self._api("getUpdates", {"offset": offset, "limit": limit, "timeout": 0})
        matches: List[Dict[str, Any]] = []
        max_id = offset
        for upd in data.get("result") or []:
            uid = upd.get("update_id", 0)
            max_id = max(max_id, int(uid) + 1)
            msg = upd.get("message") or upd.get("channel_post") or {}
            text = (msg.get("text") or "").lower()
            if not text:
                continue
            hit = [k for k in self.keywords if k in text]
            if not hit:
                continue
            chat = msg.get("chat") or {}
            matches.append({
                "update_id": uid,
                "chat_id": chat.get("id"),
                "keywords": hit,
                "excerpt": text[:200],
            })
            if self.auto_reply and chat.get("id"):
                reply = (
                    f"Umbraxon KYA Hub — M2M agent identity & Lightning registration: "
                    f"{self.hub_url} — docs: {self.hub_url}/README_API.md"
                )
                self._api("sendMessage", {"chat_id": chat["id"], "text": reply[:4000]})
        if max_id > offset:
            __import__("pr.state", fromlist=["put"]).put("telegram_update_offset", max_id)
        return {"ok": True, "matches": matches, "auto_reply": self.auto_reply}

    def _api(self, method: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"https://api.telegram.org/bot{self.bot_token}/{method}"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "umbraxon-pr-agent/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                out = json.loads(resp.read().decode("utf-8"))
                if not out.get("ok"):
                    return {"ok": False, "error": out}
                return {"ok": True, **out}
        except urllib.error.HTTPError as e:
            return {"ok": False, "http_status": e.code, "body": e.read().decode("utf-8", errors="replace")[:300]}
