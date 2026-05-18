"""KYA Hub heartbeat — keeps PR ambassador agent alive for reputation decay / loyalty bonus."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict

from config import Settings


def _load_seed_hex(path: str) -> bytes:
    raw = Path(path).read_text(encoding="utf-8").strip()
    if len(raw) == 64 and all(c in "0123456789abcdefABCDEF" for c in raw):
        return bytes.fromhex(raw)
    if len(raw) == 32:
        return raw.encode("latin-1") if isinstance(raw, str) else raw
    raise ValueError(f"unsupported key format in {path}")


def kya_hub_heartbeat(settings: Settings) -> Dict[str, Any]:
    if not settings.pr_kya_heartbeat:
        return {"skipped": True, "reason": "PR_KYA_HEARTBEAT not enabled"}
    kya_id = (settings.kya_id or "").strip()
    if not kya_id or not kya_id.startswith("UMBRA-"):
        return {"skipped": True, "reason": "KYA_ID missing"}
    key_path = Path(settings.kya_privkey_file)
    if not key_path.is_file():
        return {"skipped": True, "reason": f"privkey missing: {key_path}"}
    try:
        import nacl.signing
        import nacl.encoding
    except ImportError:
        return {"skipped": True, "reason": "pynacl not installed"}

    seed = _load_seed_hex(str(key_path))
    nonce = secrets.token_hex(16)
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    msg = f"{kya_id}|{nonce}|{timestamp}".encode("utf-8")
    digest = hashlib.sha256(msg).digest()
    sk = nacl.signing.SigningKey(seed)
    sig = sk.sign(digest).signature.hex()

    url = f"{settings.kya_hub_base_url}/api/agent/{kya_id}/heartbeat"
    body = json.dumps({"signature": sig, "nonce": nonce, "timestamp": timestamp}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            hub = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        return {"ok": False, "http_status": e.code, "error": err_body[:500]}

    rep_url = f"{settings.kya_hub_base_url}/api/agent/{kya_id}/reputation"
    rep_req = urllib.request.Request(rep_url, headers={"Accept": "application/json"})
    reputation: Dict[str, Any] = {}
    try:
        with urllib.request.urlopen(rep_req, timeout=20) as rrep:
            reputation = json.loads(rrep.read().decode("utf-8"))
    except Exception as e:
        reputation = {"fetch_error": str(e)}

    score = (reputation.get("reputation") or {}).get("score")
    return {
        "ok": True,
        "kya_id": kya_id,
        "hub_response": hub,
        "reputation_score": score,
        "reputation_zone": (reputation.get("reputation") or {}).get("zone"),
    }
