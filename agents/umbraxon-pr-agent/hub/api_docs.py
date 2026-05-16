"""Load KYA Hub API documentation for LLM / operator context."""
from __future__ import annotations

import urllib.request
from pathlib import Path
from typing import Optional

_REPO_README = Path(__file__).resolve().parents[3] / "README_API.md"
_USER_AGENT = "umbraxon-pr-agent/1.0 (KYA Hub M2M)"


def fetch_hub_api_docs(base_url: str, timeout: float = 15.0) -> str:
    """Prefer live README_API.md, fallback OpenAPI, then local repo copy."""
    base = base_url.rstrip("/")
    headers = {
        "Accept": "text/plain, application/yaml, */*",
        "User-Agent": _USER_AGENT,
    }
    for path in ("/README_API.md", "/openapi/openapi.yaml"):
        try:
            req = urllib.request.Request(f"{base}{path}", headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except OSError:
            continue
    if _REPO_README.is_file():
        return _REPO_README.read_text(encoding="utf-8")
    raise RuntimeError(f"Could not load API docs from {base} (and no {_REPO_README})")


def summarize_for_prompt(full_text: str, max_chars: int = 12000) -> str:
    if len(full_text) <= max_chars:
        return full_text
    return full_text[: max_chars - 80] + "\n\n[... truncated for LLM context ...]\n"
