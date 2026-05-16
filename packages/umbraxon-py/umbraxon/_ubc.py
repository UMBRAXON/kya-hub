"""Load reference hub client from repo scripts/ (editable install from monorepo root)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Optional

_cached: Optional[ModuleType] = None


def load_umbrexon_bot_client() -> ModuleType:
    global _cached
    if _cached is not None:
        return _cached

    here = Path(__file__).resolve()
    # packages/umbraxon-py/umbraxon/_ubc.py -> repo root
    root = here.parents[3]
    script = root / "scripts" / "umbrexon_bot_client.py"
    if not script.is_file():
        raise ImportError(
            f"umbrexon_bot_client.py not found at {script}. "
            "Install from kya-hub repo root: pip install -e packages/umbraxon-py"
        )
    spec = importlib.util.spec_from_file_location("umbrexon_bot_client", script)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {script}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["umbrexon_bot_client"] = mod
    spec.loader.exec_module(mod)
    _cached = mod
    return mod
