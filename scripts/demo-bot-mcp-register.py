#!/usr/bin/env python3
"""
Simulate a bot arriving: MCP read-only checks, then full KYA registration via
the canonical Python client (PoW + Ed25519 + POST /api/register/initiate).

Correlate with hub logs using the printed unique agent_name, e.g.:
  pm2 logs kya-hub --lines 400 | grep -E 'register/initiate|DEMO-'

Env:
  KYA_HUB_BASE_URL   Default hub if --base-url omitted.

Requires: Node (MCP), Python 3 + PyNaCl (umbrexon_bot_client).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _log(msg: str) -> None:
    print(f"[{_ts()}] [demo-bot] {msg}", flush=True)


class McpStdioClient:
    """Minimal JSON-RPC over newline stdio to mcp/src/index.js."""

    def __init__(self, repo_root: Path, base_url: str) -> None:
        self._repo_root = repo_root
        self._base_url = base_url
        self._proc: Optional[subprocess.Popen[str]] = None
        self._next_id = 1

    def start(self) -> None:
        mcp_dir = self._repo_root / "mcp"
        entry = mcp_dir / "src" / "index.js"
        if not entry.is_file():
            raise FileNotFoundError(f"MCP entry missing: {entry}")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("node not found in PATH (required for MCP phase)")
        env = {**os.environ, "KYA_HUB_BASE_URL": self._base_url}
        self._proc = subprocess.Popen(
            [node, str(entry)],
            cwd=str(mcp_dir),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert self._proc.stdin and self._proc.stdout

    def _send(self, obj: Dict[str, Any]) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write(json.dumps(obj, separators=(",", ":")) + "\n")
        self._proc.stdin.flush()

    def _wait_id(self, want_id: int, timeout_sec: float = 45.0) -> Dict[str, Any]:
        assert self._proc and self._proc.stdout
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            line = self._proc.stdout.readline()
            if not line:
                err = ""
                if self._proc.stderr:
                    err = self._proc.stderr.read()[:4000]
                raise RuntimeError(f"MCP stdout closed (stderr={err!r})")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == want_id:
                return msg
        raise TimeoutError(f"MCP: no response for id={want_id} within {timeout_sec}s")

    def initialize(self) -> None:
        i = self._next_id
        self._next_id += 1
        self._send(
            {
                "jsonrpc": "2.0",
                "id": i,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "demo-bot-mcp-register", "version": "1"},
                },
            }
        )
        r = self._wait_id(i)
        if r.get("error"):
            raise RuntimeError(f"MCP initialize error: {r['error']}")
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def call_tool(self, name: str, arguments: Dict[str, Any], timeout_sec: float = 60.0) -> Dict[str, Any]:
        i = self._next_id
        self._next_id += 1
        self._send(
            {
                "jsonrpc": "2.0",
                "id": i,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        )
        r = self._wait_id(i, timeout_sec=timeout_sec)
        if r.get("error"):
            raise RuntimeError(f"MCP tools/call error: {r['error']}")
        res = r.get("result") or {}
        if res.get("isError"):
            text = (res.get("content") or [{}])[0].get("text", "")
            raise RuntimeError(f"MCP tool {name} failed: {text}")
        return res

    def close(self) -> None:
        if self._proc:
            try:
                if self._proc.stdin:
                    self._proc.stdin.close()
            except BrokenPipeError:
                pass
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None


def _run_keygen(repo: Path, key_path: Path) -> str:
    cli = repo / "scripts" / "umbrexon_bot_client.py"
    p = subprocess.run(
        [sys.executable, str(cli), "keygen", "--out", str(key_path)],
        cwd=str(repo),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if p.returncode != 0:
        raise RuntimeError(f"keygen failed rc={p.returncode} stderr={p.stderr}")
    m = re.search(r"public_key_hex=([0-9a-fA-F]{64})", p.stdout)
    if not m:
        raise RuntimeError(f"keygen: could not parse public_key_hex from stdout:\n{p.stdout}")
    return m.group(1).lower()


def _run_register(
    repo: Path,
    base_url: str,
    key_path: Path,
    name: str,
    tier: str,
    dry_run: bool,
    pow_max: float,
) -> int:
    cli = repo / "scripts" / "umbrexon_bot_client.py"
    cmd: List[str] = [
        sys.executable,
        str(cli),
        "register",
        "--base-url",
        base_url,
        "--privkey-file",
        str(key_path),
        "--name",
        name,
        "--version",
        "1.0.0",
        "--tier",
        tier,
        "--capability",
        "btc_payments",
        "--pow-max-seconds",
        str(pow_max),
    ]
    if dry_run:
        cmd.append("--dry-run")
    _log("starting Python register (PoW + signatures + POST or dry-run prepare)…")
    p = subprocess.run(cmd, cwd=str(repo), timeout=max(180.0, pow_max + 90.0))
    return int(p.returncode)


def _require_nacl_or_exit() -> None:
    try:
        import nacl  # noqa: F401
    except ImportError:
        print(
            "[demo-bot] PyNaCl missing. Install: sudo apt install python3-nacl\n"
            "          or: python3 -m venv .venv && .venv/bin/pip install pynacl",
            file=sys.stderr,
        )
        sys.exit(2)


def main() -> int:
    _require_nacl_or_exit()
    repo = _repo_root()
    ap = argparse.ArgumentParser(
        description="Demo: MCP hub checks, then umbrexon_bot_client register (real bot simulation).",
    )
    ap.add_argument(
        "--base-url",
        default=os.environ.get("KYA_HUB_BASE_URL", "https://umbraxon.xyz"),
        help="Hub origin (no trailing slash).",
    )
    ap.add_argument("--tier", choices=["BASIC", "ELITE"], default="BASIC")
    ap.add_argument(
        "--name-prefix",
        default="DEMO",
        help="Agent name prefix; full name is PREFIX-XXXXXXXX (unique).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Register stops before POST /api/register/initiate (still hits PoW/challenge HTTP).",
    )
    ap.add_argument("--skip-mcp", action="store_true", help="Only run register phase (skip MCP stdio).")
    ap.add_argument("--pow-max-seconds", type=float, default=120.0)
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    suffix = f"{int(time.time()) % 100000000:08x}"
    agent_name = f"{args.name_prefix}-{suffix}"
    _log(f"correlation: agent_name={agent_name!r} tier={args.tier} dry_run={args.dry_run}")
    _log("grep hub logs: register/initiate OR this agent_name")

    key_path = Path(tempfile.gettempdir()) / f"kya-demo-{suffix}.key"
    try:
        _log(f"phase keygen → {key_path}")
        pub = _run_keygen(repo, key_path)

        if not args.skip_mcp:
            _log("phase MCP: stdio server")
            mcp = McpStdioClient(repo, base)
            mcp.start()
            try:
                mcp.initialize()
                _log("MCP tools/call kya_health")
                h = mcp.call_tool("kya_health", {})
                txt = (h.get("content") or [{}])[0].get("text", "")
                _log(f"MCP kya_health response_len={len(txt)}")
                _log("MCP tools/call kya_registration_quote")
                q = mcp.call_tool(
                    "kya_registration_quote",
                    {"tier": args.tier, "pubkey": pub},
                    timeout_sec=45.0,
                )
                qtxt = (q.get("content") or [{}])[0].get("text", "")
                _log(f"MCP kya_registration_quote response_len={len(qtxt)}")
                try:
                    quote = json.loads(qtxt)
                    _log(f"quote top-level keys={list(quote.keys())[:15]}")
                except json.JSONDecodeError:
                    _log("quote body not JSON (see register client output for details)")
            finally:
                mcp.close()
        else:
            _log("skip MCP (--skip-mcp)")

        rc = _run_register(
            repo,
            base,
            key_path,
            agent_name,
            args.tier,
            args.dry_run,
            args.pow_max_seconds,
        )
        _log(f"register subprocess exit_code={rc}")
        return rc
    finally:
        try:
            key_path.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
