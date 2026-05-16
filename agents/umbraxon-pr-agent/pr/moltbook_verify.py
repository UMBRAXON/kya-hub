"""Solve Moltbook post verification challenge (math word problem)."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from config import Settings


def verify_post(
    settings: Settings,
    verification: Dict[str, Any],
    *,
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    code = verification.get("verification_code") or ""
    challenge = verification.get("challenge_text") or ""
    if not code or not challenge:
        return {"ok": False, "reason": "no verification payload"}

    answer = _solve_challenge(settings, challenge)
    if not answer:
        return {"ok": False, "reason": "could not solve challenge"}

    key = (api_key or settings.moltbook_api_key).strip()
    url = f"{settings.moltbook_base_url}/api/v1/verify"
    payload = json.dumps({"verification_code": code, "answer": answer}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": "umbraxon-pr-agent/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return {"ok": True, "response": json.loads(resp.read().decode("utf-8")), "answer": answer}
    except urllib.error.HTTPError as e:
        return {
            "ok": False,
            "http_status": e.code,
            "body": e.read().decode("utf-8", errors="replace")[:400],
            "answer": answer,
        }


def _solve_challenge(settings: Settings, challenge: str) -> Optional[str]:
    if settings.llm_api_key:
        try:
            from pr.promote import _openai_chat

            prompt = (
                "Solve this obfuscated math word problem. Reply with ONLY one number "
                "with exactly 2 decimal places (e.g. 35.00). No explanation.\n\n"
                + challenge
            )
            raw = _openai_chat(settings, prompt, system="You output only numbers.")
            m = re.search(r"-?\d+\.\d{2}", raw.replace(",", ""))
            if m:
                return m.group(0)
        except Exception:
            pass
    # fallback: extract numbers and sum (weak heuristic for claw-themed puzzles)
    nums = [int(x) for x in re.findall(r"\b(\d+)\b", challenge)]
    if len(nums) >= 2:
        return f"{float(sum(nums[:2])):.2f}"
    if len(nums) == 1:
        return f"{float(nums[0]):.2f}"
    return None
