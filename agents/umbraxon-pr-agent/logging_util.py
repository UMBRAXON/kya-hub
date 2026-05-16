"""Structured JSONL logging for production traceability."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


class TraceLogger:
    def __init__(self, log_path: Path, trace_id: str) -> None:
        self.log_path = log_path
        self.trace_id = trace_id
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, event: str, level: str = "info", **fields: Any) -> None:
        row: Dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "event": event,
            "trace_id": self.trace_id,
            **fields,
        }
        line = json.dumps(row, ensure_ascii=False)
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        print(line, file=sys.stderr)

    def info(self, event: str, **fields: Any) -> None:
        self.log(event, "info", **fields)

    def error(self, event: str, **fields: Any) -> None:
        self.log(event, "error", **fields)


def new_trace_logger(log_dir: str, prefix: str = "pr-agent") -> TraceLogger:
    trace_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = Path(log_dir) / f"{prefix}-{trace_id}.jsonl"
    return TraceLogger(path, trace_id=trace_id)
