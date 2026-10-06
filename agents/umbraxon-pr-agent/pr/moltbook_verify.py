"""Solve Moltbook post verification challenge (math word problem)."""
from __future__ import annotations

import difflib
import json
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

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

# Common leetspeak / stutter aliases after collapse.
_ALIASES = {
    "fife": "five",
    "fiv": "five",
    "tweny": "twenty",
    "twenti": "twenty",
    "therty": "thirty",
    "thrty": "thirty",
    "fourty": "forty",
    "forteen": "fourteen",
    "fiveteen": "fifteen",
    "eigt": "eight",
    "nin": "nine",
}


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

    answers = _candidate_answers(settings, challenge)
    if not answers:
        return {"ok": False, "reason": "could not solve challenge"}

    key = (api_key or settings.moltbook_api_key).strip()
    url = f"{settings.moltbook_base_url}/api/v1/verify"
    last: Dict[str, Any] = {"ok": False, "reason": "all answers rejected"}

    for answer in answers:
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
                return {
                    "ok": True,
                    "response": json.loads(resp.read().decode("utf-8")),
                    "answer": answer,
                    "tried": answers,
                }
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:400]
            # Idempotent: comment/post already verified by a parallel path.
            if e.code == 409 and "Already answered" in body:
                return {
                    "ok": True,
                    "already_answered": True,
                    "answer": answer,
                    "body": body,
                    "tried": answers,
                }
            last = {
                "ok": False,
                "http_status": e.code,
                "body": body,
                "answer": answer,
                "tried": answers,
            }
            # Wrong answer → try next candidate; other errors stop.
            if e.code == 400 and "Incorrect" in body:
                continue
            return last
    return last


def _candidate_answers(settings: Settings, challenge: str) -> List[str]:
    """Ordered unique answers: heuristic first (reliable on lobster math), then LLM."""
    ordered: List[str] = []
    heuristic, n_addends = _solve_word_math_detail(challenge)
    if heuristic and n_addends >= 2:
        ordered.append(heuristic)

    llm = _solve_via_llm(settings, challenge)
    if llm and llm not in ordered:
        ordered.append(llm)

    # Weak heuristic (1 number) only after LLM.
    if heuristic and heuristic not in ordered:
        ordered.append(heuristic)

    # Digits fallback.
    nums = [int(x) for x in re.findall(r"\b(\d+)\b", challenge)]
    if len(nums) >= 2:
        dig = f"{float(sum(nums[:2])):.2f}"
        if dig not in ordered:
            ordered.append(dig)
    elif len(nums) == 1:
        dig = f"{float(nums[0]):.2f}"
        if dig not in ordered:
            ordered.append(dig)
    return ordered


def _solve_challenge(settings: Settings, challenge: str) -> Optional[str]:
    cands = _candidate_answers(settings, challenge)
    return cands[0] if cands else None


def _solve_via_llm(settings: Settings, challenge: str) -> Optional[str]:
    if not settings.llm_api_key:
        return None
    try:
        from pr.promote import _openai_chat

        prompt = (
            "Solve this obfuscated math word problem exactly. "
            "Ignore lobster/moltbook themed noise words and punctuation spam. "
            "Typical form: two forces/newtons added together (A + B). "
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
        return None
    return None


def _collapse_repeats(token: str) -> str:
    """fiivee→five, tweenty→twenty (stuttered leetspeak)."""
    out: List[str] = []
    for ch in token:
        if not out or out[-1] != ch:
            out.append(ch)
    return "".join(out)


def _normalize_challenge(challenge: str) -> List[str]:
    """Strip punctuation/leetspeak separators → lowercase alpha tokens."""
    cleaned = re.sub(r"[^a-zA-Z0-9]+", " ", challenge).lower()
    return [t for t in cleaned.split() if t]


def _resolve_number_token(token: str, *, allow_fuzzy: bool = True) -> Optional[int]:
    """Map one token to a number, with collapse + alias + optional fuzzy match."""
    if token.isdigit():
        return int(token)
    if token in _WORD_NUMS:
        return _WORD_NUMS[token]

    collapsed = _collapse_repeats(token)
    if collapsed in _WORD_NUMS:
        return _WORD_NUMS[collapsed]
    if collapsed in _ALIASES:
        return _WORD_NUMS[_ALIASES[collapsed]]
    if token in _ALIASES:
        return _WORD_NUMS[_ALIASES[token]]

    # Fuzzy only on short single tokens — never on joined spans like "thirtyfife".
    if not allow_fuzzy or len(collapsed) < 3 or len(collapsed) > 12:
        return None
    # Block common English that fuzzy-collides (the≈three).
    if collapsed in {
        "the",
        "and",
        "for",
        "to",
        "of",
        "is",
        "it",
        "in",
        "on",
        "as",
        "or",
        "an",
        "a",
        "um",
        "uh",
        "uhh",
        "total",
        "force",
        "claw",
        "plus",
        "with",
        "like",
        "many",
        "how",
        "what",
        "has",
        "water",
        "pressure",
        "applies",
        "another",
        "swims",
        "newton",
        "newtons",
        "noton",
        "notons",
        "nooton",
        "nootons",
    }:
        return None

    matches = difflib.get_close_matches(
        collapsed, list(_WORD_NUMS.keys()), n=1, cutoff=0.84
    )
    if not matches:
        return None
    # Same first letter — blocks the→three, oftwenty junk joins when fuzzy on.
    if matches[0][0] != collapsed[0]:
        return None
    return _WORD_NUMS[matches[0]]


def _extract_number_values(tokens: List[str]) -> List[int]:
    """Parse number words, including split forms like 'twen'+'ty' → 20."""
    values: List[int] = []
    i = 0
    n = len(tokens)
    while i < n:
        matched = False
        for span in (3, 2, 1):
            if i + span > n:
                continue
            joined = "".join(tokens[i : i + span])
            # Multi-token joins: exact / collapse / alias only (no fuzzy).
            # Otherwise "thirty"+"fife" → "thirtyfife" ≈ thirty and skips five.
            resolved = _resolve_number_token(joined, allow_fuzzy=(span == 1))
            if resolved is not None:
                values.append(resolved)
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


def _solve_word_math_detail(challenge: str) -> Tuple[Optional[str], int]:
    tokens = _normalize_challenge(challenge)
    raw = _extract_number_values(tokens)
    nums = _compose_magnitudes(raw)
    if len(nums) >= 2:
        # Captchas are almost always "A + B" / "total force" style.
        return f"{float(sum(nums)):.2f}", len(nums)
    if len(nums) == 1:
        return f"{float(nums[0]):.2f}", 1
    return None, 0


def _solve_word_math(challenge: str) -> Optional[str]:
    """
    Heuristic for Moltbook captchas like:
    'fIfTy nEwToNs ... aDdS tWeN tY fOuR nEwToNs' → 74.00
    """
    ans, _ = _solve_word_math_detail(challenge)
    return ans
