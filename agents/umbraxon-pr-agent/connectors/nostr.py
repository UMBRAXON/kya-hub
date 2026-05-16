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

    def _private_key(self):
        from pynostr.key import PrivateKey

        sec = self.private_key
        if sec.startswith("nsec1"):
            return PrivateKey.from_nsec(sec)
        return PrivateKey(bytes.fromhex(sec.replace("0x", "")))

    def _publish_message_to_relays(self, message: str) -> Dict[str, Any]:
        from websocket import create_connection

        published: List[str] = []
        errors: List[str] = []
        for relay in self.relays[:5]:
            try:
                ws = create_connection(relay, timeout=12)
                ws.send(message)
                ws.settimeout(4)
                try:
                    ws.recv()
                except Exception:
                    pass
                ws.close()
                published.append(relay)
            except Exception as ex:
                errors.append(f"{relay}: {ex}")
        if not published:
            return {"ok": False, "error": "; ".join(errors) or "no relay accepted event"}
        return {"ok": True, "relays": published, "errors": errors or None}

    def publish_profile(self, fields: Dict[str, Any]) -> Dict[str, Any]:
        if not self.authenticate():
            return {"ok": False, "skipped": True, "reason": "NOSTR_PRIVATE_KEY or NOSTR_RELAYS missing"}
        try:
            from pynostr.metadata import Metadata
        except ImportError:
            return {"ok": False, "skipped": True, "reason": "pip install pynostr"}
        try:
            pk = self._private_key()
            m = Metadata()
            m.name = fields.get("name") or fields.get("display_name")
            m.display_name = fields.get("display_name") or fields.get("name")
            m.about = fields.get("about")
            m.website = fields.get("website")
            m.picture = fields.get("picture")
            m.sign(pk.hex())
            out = self._publish_message_to_relays(m.to_message())
            if out.get("ok"):
                out["event_id"] = m.id
                out["kind"] = 0
            return out
        except ImportError:
            return {
                "ok": False,
                "skipped": True,
                "reason": "pip install websocket-client",
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def publish(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.authenticate():
            return {"ok": False, "skipped": True, "reason": "NOSTR_PRIVATE_KEY or NOSTR_RELAYS missing"}
        try:
            from pynostr.key import PrivateKey
            from pynostr.event import Event
        except ImportError:
            return {
                "ok": False,
                "skipped": True,
                "reason": "pip install pynostr (see agents/umbraxon-pr-agent/requirements.txt)",
            }
        try:
            pk = self._private_key()
            event = Event(content=text[:10000])
            event.sign(pk.hex())
            out = self._publish_message_to_relays(event.to_message())
            if out.get("ok"):
                out["event_id"] = event.id
            return out
        except ImportError:
            return {
                "ok": False,
                "skipped": True,
                "reason": "pip install websocket-client (see requirements.txt)",
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}
