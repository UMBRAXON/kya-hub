"""Nostr notes — optional pynostr; graceful skip if not installed."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from connectors.base import SocialConnector


class NostrConnector(SocialConnector):
    name = "nostr"

    def __init__(self, private_key: str, relays: List[str]) -> None:
        self.private_key = private_key.strip()
        self.relays = [r.strip() for r in relays if r.strip()]

    def authenticate(self) -> bool:
        return bool(self.private_key and self.relays)

    def publish(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.authenticate():
            return {"ok": False, "skipped": True, "reason": "NOSTR_PRIVATE_KEY or NOSTR_RELAYS missing"}
        try:
            from pynostr.key import PrivateKey
            from pynostr.event import Event
            from pynostr.relay_manager import RelayManager
        except ImportError:
            return {
                "ok": False,
                "skipped": True,
                "reason": "pip install pynostr (see agents/umbraxon-pr-agent/requirements.txt)",
            }
        try:
            sec = self.private_key
            if sec.startswith("nsec1"):
                pk = PrivateKey.from_nsec(sec)
            else:
                pk = PrivateKey(bytes.fromhex(sec.replace("0x", "")))
            event = Event(content=text[:10000], public_key=pk.public_key.hex())
            pk.sign_event(event)
            rm = RelayManager()
            for relay in self.relays[:5]:
                rm.add_relay(relay)
            rm.publish_event(event)
            rm.close_connections()
            return {"ok": True, "event_id": event.id, "relays": self.relays[:5]}
        except Exception as e:
            return {"ok": False, "error": str(e)}
