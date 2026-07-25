"""Solve Moltbook post verification challenge (math word problem)."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from config import Settings

# English number words used in lobster-themed Moltbook captchas.
_ONES = {
    "zero": 0,
    "oh": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
}
_TENS = {
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
_WORD_NUMS = {**_ONES, **_TENS, "hundred": 100, "thousand": 1000}


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
        body = e.read().decode("utf-8", errors="replace")[:400]
        # Idempotent: comment/post already verified by a parallel path.
        if e.code == 409 and "Already answered" in body:
            return {"ok": True, "already_answered": True, "answer": answer, "body": body}
        return {
            "ok": False,
            "http_status": e.code,
            "body": body,
            "answer": answer,
        }


def _solve_challenge(settings: Settings, challenge: str) -> Optional[str]:
    heuristic = _solve_word_math(challenge)
    if settings.llm_api_key:
        try:
            from pr.promote import _openai_chat

            prompt = (
                "Solve this obfuscated math word problem exactly. "
                "Ignore lobster/moltbook themed noise words. "
                "Reply with ONLY one number with exactly 2 decimal places (e.g. 35.00). "
                "No explanation.\n\n"
                + challenge
            )
            raw = _openai_chat(
                settings,
                prompt,
                system="You are a precise math solver. Output only a number like 12.34",
            )
            m = re.search(r"-?\d+\.\d{2}", raw.replace(",", ""))
            if m:
                return m.group(0)
        except Exception:
            pass
    if heuristic:
        return heuristic
    # last resort: bare digits in the challenge text
    nums = [int(x) for x in re.findall(r"\b(\d+)\b", challenge)]
    if len(nums) >= 2:
        return f"{float(sum(nums[:2])):.2f}"
    if len(nums) == 1:
        return f"{float(nums[0]):.2f}"
    return None


def _normalize_challenge(challenge: str) -> List[str]:
    """Strip punctuation/leetspeak separators → lowercase alpha tokens."""
    cleaned = re.sub(r"[^a-zA-Z0-9]+", " ", challenge).lower()
    return [t for t in cleaned.split() if t]


def _extract_number_values(tokens: List[str]) -> List[int]:
    """Parse number words, including split forms like 'twen'+'ty' → 20."""
    values: List[int] = []
    i = 0
    n = len(tokens)
    while i < n:
        # Prefer longest merge of adjacent alpha fragments into a known word.
        matched = False
        for span in (3, 2, 1):
            if i + span > n:
                continue
            joined = "".join(tokens[i : i + span])
            if joined in _WORD_NUMS:
                values.append(_WORD_NUMS[joined])
                i += span
                matched = True
                break
            if joined.isdigit():
                values.append(int(joined))
                i += span
                matched = True
                break
        if not matched:
            i += 1
    return values


def _compose_magnitudes(values: List[int]) -> List[int]:
    """Compose 'fifty'+'four'→54 and 'two'+'hundred'→200 into addends."""
    if not values:
        return []
    composed: List[int] = []
    i = 0
    while i < len(values):
        v = values[i]
        if v in (100, 1000) and composed:
            composed[-1] = composed[-1] * v
            i += 1
            continue
        # tens + ones (20..90 followed by 1..9)
        if (
            v >= 20
            and v <= 90
            and v % 10 == 0
            and i + 1 < len(values)
            and 1 <= values[i + 1] <= 9
        ):
            composed.append(v + values[i + 1])
            i += 2
            continue
        composed.append(v)
        i += 1
    return composed


def _solve_word_math(challenge: str) -> Optional[str]:
    """
    Heuristic for Moltbook captchas like:
    'fIfTy nEwToNs ... aDdS tWeN tY fOuR nEwToNs' → 74.00
    """
    tokens = _normalize_challenge(challenge)
    raw = _extract_number_values(tokens)
    nums = _compose_magnitudes(raw)
    if len(nums) >= 2:
        # Captchas are almost always "A + B" / "total force" style.
        return f"{float(sum(nums)):.2f}"
    if len(nums) == 1:
        return f"{float(nums[0]):.2f}"
    return None
