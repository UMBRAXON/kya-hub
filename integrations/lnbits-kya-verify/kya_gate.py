"""LNBits / Python — KYA Hub trust gate (HTTP)."""
from __future__ import annotations

import os
from typing import Any, Dict

import urllib.error
import urllib.request


def _base() -> str:
    return os.getenv("KYA_HUB_BASE_URL", "https://www.umbraxon.xyz").rstrip("/")


def fetch_status(kya_id: str) -> Dict[str, Any]:
    url = f"{_base()}/api/v1/agents/{kya_id}/status"
    headers = {"Accept": "application/json", "User-Agent": "lnbits-kya-gate/1.0"}
    key = os.getenv("KYA_INTEGRATOR_API_KEY", "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            import json

            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"KYA Hub HTTP {e.code}: {body}") from e


def require_kya_verified(kya_id: str) -> Dict[str, Any]:
    data = fetch_status(kya_id)
    if not data.get("verified"):
        reasons = data.get("reasons") or data.get("trust_level")
        raise PermissionError(f"KYA agent not verified: {kya_id} — {reasons}")
    return data
