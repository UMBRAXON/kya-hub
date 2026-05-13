#!/usr/bin/env python3
"""
KYA Hub — Real-time Cyber-Security Command Center (Streamlit).

Data sources:
  - Tail-parse PM2 / pino log (JSON lines + heuristics).
  - Moltbook reputation API (urllib, no requests).
  - psutil for host CPU/RAM.
  - Optional PostgreSQL: registration_intents + invoices (read-only, kyahub_app).

Env:
  KYA_HUB_LOG_PATH   default /root/.pm2/logs/kya-hub-out.log
  KYA_HUB_REPO       default /root/kya-hub — used to auto-load .env for DB if vars unset
  MOLTBOOK_NODE_PUBKEY   hex pubkey for https://api.moltbook.org/v2/nodes/reputation/{pubkey}
  MOLTBOOK_RS_CACHE_SEC  default 12
  DASH_REFRESH_MS    default 900  (Streamlit rerun interval)
  DASH_DB_DISABLED   if "1" / "true" — skip PostgreSQL panels
  DASH_DB_CACHE_SEC  default 15 — cache DB snapshot between Streamlit reruns
  DB_HOST, DB_PORT, DB_NAME, DASH_DB_USER (default kyahub_app), DASH_DB_PASSWORD or KYAHUB_APP_PASSWORD
"""

from __future__ import annotations

import html
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional, Tuple

import psutil
import streamlit as st

try:
    import psycopg2
    import psycopg2.extras
except ImportError:  # pragma: no cover
    psycopg2 = None  # type: ignore

try:
    import pandas as pd
except ImportError:  # pragma: no cover
    pd = None  # type: ignore

# ---------------------------------------------------------------------------
# Theme — Cyber-Security Command Center
# ---------------------------------------------------------------------------
BG = "#0a0a0a"
NEON_OK = "#00ff9d"
NEON_WARN = "#ff8c00"
NEON_BAD = "#ff1744"
NEON_DIM = "#1a3d2e"
TEXT_MUTED = "#6b8f7a"

CSS = f"""
<style>
  .stApp {{ background-color: {BG}; }}
  header[data-testid="stHeader"] {{ background-color: {BG}; }}
  div[data-testid="stVerticalBlock"] > div:first-child h1 {{
    color: {NEON_OK};
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    letter-spacing: 0.08em;
    text-shadow: 0 0 12px rgba(0,255,157,0.35);
  }}
  .kya-metric label {{ color: {TEXT_MUTED} !important; }}
  [data-testid="stMetricValue"] {{ color: {NEON_OK} !important; }}
  .kya-gauge-wrap {{
    display: flex; justify-content: center; padding: 1rem 0;
  }}
  .kya-gauge {{
    width: 220px; height: 220px; border-radius: 50%;
    background: conic-gradient(
      {NEON_OK} calc(var(--rs, 0) * 3.6deg),
      {NEON_DIM} 0
    );
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 40px rgba(0,255,157,0.15), inset 0 0 60px rgba(0,0,0,0.85);
  }}
  .kya-gauge-inner {{
    width: 160px; height: 160px; border-radius: 50%;
    background: {BG};
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: 'JetBrains Mono', monospace;
  }}
  .kya-gauge-val {{ font-size: 2.4rem; color: {NEON_OK}; font-weight: 700; }}
  .kya-gauge-lbl {{ font-size: 0.75rem; color: {TEXT_MUTED}; text-transform: uppercase; }}
  .kya-stream {{
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    font-size: 0.78rem;
    color: {NEON_OK};
    background: #111;
    border: 1px solid #1e3d2f;
    border-radius: 6px;
    padding: 10px;
    max-height: 280px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }}
  .kya-429 {{ color: {NEON_WARN} !important; }}
  .kya-403 {{ color: {NEON_BAD} !important; }}
</style>
"""


def _env_path(name: str, default: str) -> str:
    v = os.environ.get(name, "").strip()
    return v if v else default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)), 10)
    except ValueError:
        return default


def _load_repo_dotenv(repo: str) -> None:
    """Populate os.environ from repo/.env when keys are not already set (same idea as dotenv)."""
    path = os.path.join(repo.rstrip("/"), ".env")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                if "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except OSError:
        pass


def _db_env_disabled() -> bool:
    return os.environ.get("DASH_DB_DISABLED", "").strip().lower() in ("1", "true", "yes")


def _snapshot_db_pure() -> Dict[str, Any]:
    """Read-only snapshot: registration_intents + invoices + pow_challenges.

    Returns dict with ok/err and rows. The PoW section feeds the
    "PoW solve effort" panel — distribution (p50/p95/p99) of real solve
    time and iterations for legit clients. Use it to decide whether
    POW_DEFAULT_DIFFICULTY needs tuning instead of guessing from rumours.
    """
    out: Dict[str, Any] = {
        "ok": False,
        "err": "",
        "intents_total": 0,
        "intents_24h": 0,
        "intents_7d": 0,
        "intents_by_status": [],
        "intents_recent": [],
        "invoices_total": 0,
        "invoices_7d": 0,
        "invoices_sum_sats": 0,
        "invoices_recent": [],
        "pow_window_hours": 24,
        "pow_by_purpose": [],
        "pow_overall": None,
        "pow_difficulty_hist": [],
        "pow_err": "",
    }
    if psycopg2 is None:
        out["err"] = "psycopg2 not installed (pip install -r monitoring/requirements-monitoring.txt)"
        return out
    if _db_env_disabled():
        out["err"] = "DASH_DB_DISABLED"
        return out

    pwd = (os.environ.get("DASH_DB_PASSWORD") or os.environ.get("KYAHUB_APP_PASSWORD") or "").strip()
    user = (os.environ.get("DASH_DB_USER") or "kyahub_app").strip()
    if not pwd:
        out["err"] = "Missing DASH_DB_PASSWORD or KYAHUB_APP_PASSWORD (after loading KYA_HUB_REPO/.env)"
        return out

    try:
        conn = psycopg2.connect(
            host=os.environ.get("DB_HOST", "127.0.0.1"),
            port=int(os.environ.get("DB_PORT", "5432"), 10),
            dbname=os.environ.get("DB_NAME", "kyahub"),
            user=user,
            password=pwd,
            connect_timeout=5,
        )
    except Exception as e:
        out["err"] = str(e)[:500]
        return out

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT COUNT(*)::int AS c FROM registration_intents")
            out["intents_total"] = int(cur.fetchone()["c"])

            cur.execute(
                """SELECT COUNT(*)::int AS c FROM registration_intents
                   WHERE created_at > NOW() - INTERVAL '24 hours'"""
            )
            out["intents_24h"] = int(cur.fetchone()["c"])

            cur.execute(
                """SELECT COUNT(*)::int AS c FROM registration_intents
                   WHERE created_at > NOW() - INTERVAL '7 days'"""
            )
            out["intents_7d"] = int(cur.fetchone()["c"])

            cur.execute(
                """SELECT status, COUNT(*)::int AS c
                   FROM registration_intents
                   GROUP BY status ORDER BY c DESC"""
            )
            out["intents_by_status"] = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """SELECT registration_id, agent_name, tier_requested, status,
                          invoice_id, created_at, expires_at
                   FROM registration_intents
                   ORDER BY created_at DESC NULLS LAST
                   LIMIT 30"""
            )
            rows = [dict(r) for r in cur.fetchall()]
            for r in rows:
                for k, v in list(r.items()):
                    if hasattr(v, "isoformat"):
                        r[k] = v.isoformat()
            out["intents_recent"] = rows

        # invoices table (added in migration 015 — may not exist on very old DBs)
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT COUNT(*)::int AS c FROM invoices")
                out["invoices_total"] = int(cur.fetchone()["c"])

                cur.execute(
                    """SELECT COUNT(*)::int AS c FROM invoices
                       WHERE issued_at > NOW() - INTERVAL '7 days'"""
                )
                out["invoices_7d"] = int(cur.fetchone()["c"])

                cur.execute("SELECT COALESCE(SUM(paid_amount_sats), 0)::bigint AS s FROM invoices")
                out["invoices_sum_sats"] = int(cur.fetchone()["s"])

                cur.execute(
                    """SELECT invoice_number, kya_id, tier, paid_amount_sats,
                              payment_method, issued_at, payment_hash
                       FROM invoices
                       ORDER BY issued_at DESC NULLS LAST
                       LIMIT 25"""
                )
                inv_rows = [dict(r) for r in cur.fetchall()]
                for r in inv_rows:
                    for k, v in list(r.items()):
                        if hasattr(v, "isoformat"):
                            r[k] = v.isoformat()
                    ph = r.get("payment_hash")
                    if isinstance(ph, str) and len(ph) > 20:
                        r["payment_hash"] = ph[:12] + "…" + ph[-8:]
                out["invoices_recent"] = inv_rows
        except Exception as e:
            err = str(e)
            if "invoices" in err.lower() or "does not exist" in err.lower() or getattr(e, "pgcode", None) == "42P01":
                out["invoices_err"] = "Tabuľka `invoices` nie je k dispozícii (staršia DB alebo migrácia 015)."
            else:
                out["invoices_err"] = err[:300]

        # --------------------------------------------------------------
        # pow_challenges — solve-effort distribúcia za posledné 24h.
        # Pýtame sa percentile_cont(0.50/0.95/0.99) z iterácií aj zo
        # server-side solve_ms (= solved_at - created_at). Nás zaujíma
        # primárne p95_ms — to je číslo, ktoré rozhoduje o tom, či sa
        # majú meniť POW_DEFAULT_DIFFICULTY / POW_REGISTER_DIFFICULTY.
        # --------------------------------------------------------------
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                pow_window_hours = max(1, _env_int("DASH_POW_WINDOW_HOURS", 24))
                out["pow_window_hours"] = pow_window_hours

                cur.execute(
                    f"""SELECT
                            purpose,
                            COUNT(*) FILTER (WHERE solved_at IS NOT NULL)::int AS solved,
                            COUNT(*) FILTER (WHERE solved_at IS NULL
                                              AND expires_at > NOW())::int      AS pending,
                            COUNT(*) FILTER (WHERE solved_at IS NULL
                                              AND expires_at <= NOW())::int     AS expired_unsolved,
                            percentile_cont(0.50) WITHIN GROUP (ORDER BY solution_iterations)
                                FILTER (WHERE solved_at IS NOT NULL AND solution_iterations IS NOT NULL)
                                AS p50_iter,
                            percentile_cont(0.95) WITHIN GROUP (ORDER BY solution_iterations)
                                FILTER (WHERE solved_at IS NOT NULL AND solution_iterations IS NOT NULL)
                                AS p95_iter,
                            percentile_cont(0.99) WITHIN GROUP (ORDER BY solution_iterations)
                                FILTER (WHERE solved_at IS NOT NULL AND solution_iterations IS NOT NULL)
                                AS p99_iter,
                            percentile_cont(0.50) WITHIN GROUP (
                                ORDER BY EXTRACT(EPOCH FROM (solved_at - created_at)) * 1000.0
                            ) FILTER (WHERE solved_at IS NOT NULL) AS p50_ms,
                            percentile_cont(0.95) WITHIN GROUP (
                                ORDER BY EXTRACT(EPOCH FROM (solved_at - created_at)) * 1000.0
                            ) FILTER (WHERE solved_at IS NOT NULL) AS p95_ms,
                            percentile_cont(0.99) WITHIN GROUP (
                                ORDER BY EXTRACT(EPOCH FROM (solved_at - created_at)) * 1000.0
                            ) FILTER (WHERE solved_at IS NOT NULL) AS p99_ms,
                            MIN(difficulty) AS min_difficulty,
                            MAX(difficulty) AS max_difficulty,
                            AVG(difficulty)::numeric(6,2) AS avg_difficulty
                        FROM pow_challenges
                        WHERE created_at > NOW() - INTERVAL '{pow_window_hours} hours'
                        GROUP BY purpose
                        ORDER BY solved DESC, purpose"""
                )
                rows = [dict(r) for r in cur.fetchall()]
                for r in rows:
                    for k, v in list(r.items()):
                        if hasattr(v, "isoformat"):
                            r[k] = v.isoformat()
                        elif v is not None and hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                            try:
                                r[k] = float(v)
                            except Exception:
                                pass
                out["pow_by_purpose"] = rows

                cur.execute(
                    f"""SELECT
                            COUNT(*) FILTER (WHERE solved_at IS NOT NULL)::int AS solved,
                            COUNT(*) FILTER (WHERE solved_at IS NULL
                                              AND expires_at > NOW())::int      AS pending,
                            COUNT(*) FILTER (WHERE solved_at IS NULL
                                              AND expires_at <= NOW())::int     AS expired_unsolved,
                            percentile_cont(0.50) WITHIN GROUP (ORDER BY solution_iterations)
                                FILTER (WHERE solved_at IS NOT NULL AND solution_iterations IS NOT NULL)
                                AS p50_iter,
                            percentile_cont(0.95) WITHIN GROUP (ORDER BY solution_iterations)
                                FILTER (WHERE solved_at IS NOT NULL AND solution_iterations IS NOT NULL)
                                AS p95_iter,
                            percentile_cont(0.99) WITHIN GROUP (ORDER BY solution_iterations)
                                FILTER (WHERE solved_at IS NOT NULL AND solution_iterations IS NOT NULL)
                                AS p99_iter,
                            percentile_cont(0.50) WITHIN GROUP (
                                ORDER BY EXTRACT(EPOCH FROM (solved_at - created_at)) * 1000.0
                            ) FILTER (WHERE solved_at IS NOT NULL) AS p50_ms,
                            percentile_cont(0.95) WITHIN GROUP (
                                ORDER BY EXTRACT(EPOCH FROM (solved_at - created_at)) * 1000.0
                            ) FILTER (WHERE solved_at IS NOT NULL) AS p95_ms,
                            percentile_cont(0.99) WITHIN GROUP (
                                ORDER BY EXTRACT(EPOCH FROM (solved_at - created_at)) * 1000.0
                            ) FILTER (WHERE solved_at IS NOT NULL) AS p99_ms,
                            MAX(EXTRACT(EPOCH FROM (solved_at - created_at)) * 1000.0)
                                FILTER (WHERE solved_at IS NOT NULL) AS max_ms,
                            MIN(difficulty) AS min_difficulty,
                            MAX(difficulty) AS max_difficulty
                        FROM pow_challenges
                        WHERE created_at > NOW() - INTERVAL '{pow_window_hours} hours'"""
                )
                overall = cur.fetchone()
                if overall:
                    o = dict(overall)
                    for k, v in list(o.items()):
                        if v is not None and hasattr(v, "__float__") and not isinstance(v, (int, float, bool)):
                            try:
                                o[k] = float(v)
                            except Exception:
                                pass
                    out["pow_overall"] = o

                cur.execute(
                    f"""SELECT
                            difficulty,
                            COUNT(*) FILTER (WHERE solved_at IS NOT NULL)::int AS solved,
                            COUNT(*)::int AS total
                        FROM pow_challenges
                        WHERE created_at > NOW() - INTERVAL '{pow_window_hours} hours'
                        GROUP BY difficulty
                        ORDER BY difficulty"""
                )
                out["pow_difficulty_hist"] = [dict(r) for r in cur.fetchall()]
        except Exception as e:
            err = str(e)
            if (
                "pow_challenges" in err.lower()
                or "does not exist" in err.lower()
                or getattr(e, "pgcode", None) == "42P01"
            ):
                out["pow_err"] = (
                    "Tabuľka `pow_challenges` nie je k dispozícii (staršia DB alebo migrácia 004)."
                )
            else:
                out["pow_err"] = err[:300]

        out["ok"] = True
        out["err"] = ""
    except Exception as e:
        out["ok"] = False
        out["err"] = str(e)[:500]
    finally:
        conn.close()

    return out


def _get_db_snapshot_cached(st_session_state: Any, repo: str) -> Dict[str, Any]:
    ttl = max(3, _env_int("DASH_DB_CACHE_SEC", 15))
    now = time.time()
    cache = st_session_state.setdefault("_dash_db_cache", {"t": 0.0, "data": None})
    if cache["data"] is not None and (now - cache["t"]) < ttl:
        return cache["data"]
    _load_repo_dotenv(repo)
    cache["data"] = _snapshot_db_pure()
    cache["t"] = now
    return cache["data"]


PM2_PREFIX_RE = re.compile(
    r"^\d+\|[^\|]+\|\s*"
)  # e.g. 0|kya-hub  |
TS_PREFIX_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\:]*:\s*"
)

# HTTP status from structured logs / proxies
HTTP_STATUS_JSON = re.compile(r'"http_status"\s*:\s*(\d{3})\b')
HTTP_CLF = re.compile(r'"\s+(200|400|403|429)\s+')  # Apache-style trailing status

# Transaction-like IDs
RE_INVOICE = re.compile(r'"invoiceId"\s*:\s*"([^"]+)"', re.I)
RE_DELIVERY = re.compile(r'"deliveryId"\s*:\s*"([^"]+)"', re.I)
RE_KYA_ID = re.compile(r'"kya_id"\s*:\s*"([^"]+)"', re.I)
RE_REG_ID = re.compile(r'"registrationId"\s*:\s*"([^"]+)"', re.I)
RE_PAYMENT_HASH = re.compile(r'"payment_hash"\s*:\s*"([0-9a-fA-F]{64})"', re.I)
RE_HEX64 = re.compile(r"\b([0-9a-fA-F]{64})\b")

# Challenge entropy: nonce in JSON (hub may redact in some builds — still try)
RE_NONCE_JSON = re.compile(r'"nonce"\s*:\s*"([0-9a-fA-F]{16,})"', re.I)

# Handshake / inbound pressure heuristics (nostr, webhooks, auth flow)
HANDSHAKE_HINTS = (
    "webhook received",
    "webhook/btcpay",
    "webhook/alby",
    "auth/challenge",
    "register/initiate",
    "subscribing to relays",
    "subscribed",
    "handshake",
    "CONNECTED",
    "upgrade",
)


def _strip_log_prefix(line: str) -> str:
    s = line.rstrip("\n\r")
    s = PM2_PREFIX_RE.sub("", s)
    s = TS_PREFIX_RE.sub("", s)
    return s.strip()


def _try_parse_json_obj(line: str) -> Optional[Dict[str, Any]]:
    s = _strip_log_prefix(line)
    if not s or s[0] != "{":
        return None
    try:
        o = json.loads(s)
        return o if isinstance(o, dict) else None
    except json.JSONDecodeError:
        return None


def shannon_bits_per_byte(sample_bytes: bytes) -> float:
    if not sample_bytes:
        return 0.0
    n = len(sample_bytes)
    counts = Counter(sample_bytes)
    h = 0.0
    for c in counts.values():
        p = c / n
        h -= p * math.log2(p)
    return h


def hex_to_bytes(h: str) -> bytes:
    h = h.strip()
    if len(h) % 2:
        h = h[:-1]  # drop orphan nibble
    try:
        return bytes.fromhex(h)
    except ValueError:
        return b""


@dataclass
class LogAccumulator:
    http_counts: Counter = field(default_factory=lambda: Counter({200: 0, 400: 0, 403: 0, 429: 0}))
    txn_ids: Deque[str] = field(default_factory=lambda: deque(maxlen=400))
    handshake_stream: Deque[str] = field(default_factory=lambda: deque(maxlen=80))
    entropy_series: Deque[Tuple[float, float]] = field(default_factory=lambda: deque(maxlen=120))
    payment_settled: int = 0
    payment_expired: int = 0
    _last_entropy_ts: float = 0.0
    _inode: Optional[int] = None
    _offset: int = 0

    def reset_file_state(self) -> None:
        self._inode = None
        self._offset = 0

    def _ingest_line(self, raw: str) -> None:
        line = raw.rstrip("\n\r")
        if not line:
            return
        low = line.lower()

        # --- HTTP statuses (tracked set only) ---
        for m in HTTP_STATUS_JSON.finditer(line):
            code = int(m.group(1))
            if code in self.http_counts:
                self.http_counts[code] += 1
        m_clf = HTTP_CLF.search(line)
        if m_clf:
            code = int(m_clf.group(1))
            if code in self.http_counts:
                self.http_counts[code] += 1

        obj = _try_parse_json_obj(line)
        if obj is not None:
            hs = obj.get("http_status")
            if isinstance(hs, int) and hs in self.http_counts:
                self.http_counts[hs] += 1
            # Successful hub responses often omit http_status in stdout; treat
            # BTCPay webhook ACK path as HTTP 200 signal for the dashboard.
            msg = str(obj.get("msg") or "").lower()
            route = str(obj.get("route") or "").lower()
            if "webhook" in route and msg in (
                "webhook received",
                "duplicate webhook, skipping",
            ):
                self.http_counts[200] += 1

        # --- BTCPay pipeline (only when line looks like BTCPay webhook log) ---
        is_btcpay_webhook_log = "webhook/btcpay" in low or '"route":"webhook/btcpay"' in line.replace(" ", "")
        et_raw = None
        if is_btcpay_webhook_log:
            if obj is not None:
                et_raw = obj.get("eventType") or obj.get("event_type")
                if et_raw is None and isinstance(obj.get("type"), str):
                    et_raw = obj.get("type")
            if et_raw is None:
                m_et = re.search(r'"eventType"\s*:\s*"([^"]+)"', line, re.I)
                if m_et:
                    et_raw = m_et.group(1)
            if isinstance(et_raw, str):
                u = et_raw.upper()
                if u == "INVOICESETTLED":
                    self.payment_settled += 1
                elif u == "INVOICEEXPIRED":
                    self.payment_expired += 1

        # --- Transaction IDs ---
        for rx in (RE_INVOICE, RE_DELIVERY, RE_KYA_ID, RE_REG_ID, RE_PAYMENT_HASH):
            for m in rx.finditer(line):
                self.txn_ids.append(m.group(1)[:128])
        if obj is not None:
            for key in ("invoiceId", "deliveryId", "kya_id", "registrationId", "payment_hash"):
                v = obj.get(key)
                if isinstance(v, str) and len(v) >= 8:
                    self.txn_ids.append(v[:128])

        # --- Entropy from challenge nonces ---
        for m in RE_NONCE_JSON.finditer(line):
            b = hex_to_bytes(m.group(1))
            if len(b) >= 8:
                now = time.time()
                if now - self._last_entropy_ts > 0.25:
                    h = shannon_bits_per_byte(b)
                    self.entropy_series.append((now, h))
                    self._last_entropy_ts = now

        # --- Inbound / handshake stream ---
        if any(h in low for h in HANDSHAKE_HINTS):
            display = _strip_log_prefix(line)
            if len(display) > 220:
                display = display[:217] + "..."
            self.handshake_stream.append(display)

    def tail_file(self, path: str, max_chunk: int = 512_000) -> None:
        try:
            st_os = os.stat(path)
        except OSError:
            self.reset_file_state()
            return

        inode = getattr(st_os, "st_ino", None)
        size = st_os.st_size

        if self._inode is not None and inode != self._inode:
            self.reset_file_state()
        if self._offset > size:
            self._offset = 0

        self._inode = inode

        if self._offset == 0 and size > max_chunk:
            self._offset = max(0, size - max_chunk)

        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(self._offset)
                chunk = f.read()
                self._offset = f.tell()
        except OSError:
            return

        for ln in chunk.splitlines():
            self._ingest_line(ln)


# ---------------------------------------------------------------------------
# Moltbook reputation (stdlib urllib)
# ---------------------------------------------------------------------------
def fetch_moltbook_rs(pubkey: str, cache_sec: float) -> Tuple[Optional[float], str]:
    pubkey = pubkey.strip()
    if not pubkey:
        return None, "Set MOLTBOOK_NODE_PUBKEY"

    now = time.time()
    cache = st.session_state.setdefault("_molt_cache", {"t": 0.0, "rs": None, "err": ""})
    if cache["rs"] is not None and now - cache["t"] < cache_sec:
        return cache["rs"], cache.get("err") or "cached"

    url = f"https://api.moltbook.org/v2/nodes/reputation/{pubkey}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "kya-hub-dashboard/1"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        data = json.loads(body)
        rs = None
        if isinstance(data, dict):
            if isinstance(data.get("data"), dict):
                data = data["data"]
            rep = data.get("reputation")
            if isinstance(rep, dict):
                for key in ("score", "reputation_score", "value"):
                    v = rep.get(key)
                    if isinstance(v, (int, float)):
                        rs = float(v)
                        break
            if rs is None:
                for key in ("reputation_score", "score", "reputation", "rs", "value"):
                    v = data.get(key)
                    if isinstance(v, (int, float)):
                        rs = float(v)
                        break
                    if isinstance(v, str):
                        try:
                            rs = float(v.strip())
                            break
                        except ValueError:
                            pass
        if rs is None and isinstance(data, (int, float)):
            rs = float(data)
        cache["t"] = now
        cache["rs"] = rs
        cache["err"] = "" if rs is not None else f"Unexpected JSON: {body[:200]}"
        return rs, cache["err"]
    except urllib.error.HTTPError as e:
        cache["t"] = now
        cache["rs"] = None
        cache["err"] = f"HTTP {e.code}"
        return None, cache["err"]
    except Exception as e:
        cache["t"] = now
        cache["rs"] = None
        cache["err"] = str(e)[:200]
        return None, cache["err"]


def _fmt_ms(v: Any) -> str:
    """Render milliseconds as ms / s / min, friendly for solve-time percentiles."""
    if v is None:
        return "—"
    try:
        ms = float(v)
    except (TypeError, ValueError):
        return "—"
    if ms < 1.0:
        return "<1 ms"
    if ms < 1000.0:
        return f"{ms:.0f} ms"
    secs = ms / 1000.0
    if secs < 60.0:
        return f"{secs:.2f} s"
    mins = secs / 60.0
    if mins < 60.0:
        return f"{mins:.1f} min"
    return f"{mins/60.0:.2f} h"


def _fmt_int(v: Any) -> str:
    if v is None:
        return "—"
    try:
        return f"{int(round(float(v))):,}"
    except (TypeError, ValueError):
        return "—"


def _pow_verdict(p95_ms: Optional[float]) -> Tuple[str, str]:
    """Return (color, label) verdict for the P95 solve time."""
    if p95_ms is None:
        return TEXT_MUTED, "no data — žiadne vyriešené challenge-y v okne"
    if p95_ms < 5_000:
        return NEON_OK, f"OK — p95 {_fmt_ms(p95_ms)} < 5 s (žiadny zásah do obtiažnosti netreba)"
    if p95_ms < 30_000:
        return NEON_OK, f"OK-okraj — p95 {_fmt_ms(p95_ms)} < 30 s (sleduj, ale neznižuj)"
    if p95_ms < 60_000:
        return NEON_WARN, f"WATCH — p95 {_fmt_ms(p95_ms)} medzi 30–60 s (zváž REGISTER_DIFFICULTY −2 bity)"
    if p95_ms < 5 * 60_000:
        return NEON_WARN, f"HIGH — p95 {_fmt_ms(p95_ms)} > 60 s (kandidát na −2 až −4 bity)"
    return NEON_BAD, f"TOO HIGH — p95 {_fmt_ms(p95_ms)} (znížiť obtiažnosť alebo skontrolovať klienta)"


def _render_pow_solve_effort_panel(db: Dict[str, Any]) -> None:
    """Render the PoW solve effort percentiles panel.

    Source of truth: pow_challenges (created_at, solved_at, solution_iterations,
    difficulty, purpose). This is the data that should drive any decision to
    tune POW_DEFAULT_DIFFICULTY / POW_REGISTER_DIFFICULTY — NOT the entropy
    panel above and NOT external rumours.
    """
    st.subheader("PoW solve effort — distribúcia reálneho času riešenia (decision support)")

    if not db.get("ok"):
        err = (db.get("err") or "").strip()
        if err == "DASH_DB_DISABLED":
            st.caption("DB panel je vypnutý (`DASH_DB_DISABLED=1`).")
        else:
            st.caption(f"PoW telemetria nedostupná: {err or 'DB nie je k dispozícii.'}")
        return

    pow_err = (db.get("pow_err") or "").strip()
    if pow_err:
        st.caption(f"PoW telemetria: {pow_err}")
        return

    window_h = int(db.get("pow_window_hours") or 24)
    overall = db.get("pow_overall") or {}
    by_purpose: List[Dict[str, Any]] = db.get("pow_by_purpose") or []
    hist: List[Dict[str, Any]] = db.get("pow_difficulty_hist") or []

    solved = int(overall.get("solved") or 0)
    pending = int(overall.get("pending") or 0)
    expired = int(overall.get("expired_unsolved") or 0)

    if solved == 0:
        st.info(
            f"Za posledných {window_h} h nebol vyriešený žiadny PoW challenge. "
            f"(pending={pending}, expired-unsolved={expired}) — žiadna distribúcia na zobrazenie."
        )
        return

    p95_ms = overall.get("p95_ms")
    verdict_color, verdict_text = _pow_verdict(p95_ms if isinstance(p95_ms, (int, float)) else None)
    st.markdown(
        f'<div style="color:{verdict_color}; font-family:JetBrains Mono, monospace; '
        f'font-size:0.92rem; margin: 0 0 0.6rem 0;">verdict: {html.escape(verdict_text)}</div>',
        unsafe_allow_html=True,
    )

    a, b, c, d = st.columns(4)
    with a:
        st.metric(f"Solved / {window_h}h", f"{solved:,}")
    with b:
        st.metric("Pending", f"{pending:,}")
    with c:
        st.metric("Expired unsolved", f"{expired:,}")
    with d:
        difficulty_span = "—"
        mn = overall.get("min_difficulty")
        mx = overall.get("max_difficulty")
        if mn is not None and mx is not None:
            difficulty_span = f"{int(mn)}–{int(mx)} bits" if mn != mx else f"{int(mn)} bits"
        st.metric("Difficulty span", difficulty_span)

    e, f, g = st.columns(3)
    with e:
        st.metric("p50 solve time", _fmt_ms(overall.get("p50_ms")))
        st.caption(f"p50 iter: {_fmt_int(overall.get('p50_iter'))}")
    with f:
        st.metric("p95 solve time", _fmt_ms(overall.get("p95_ms")))
        st.caption(f"p95 iter: {_fmt_int(overall.get('p95_iter'))}")
    with g:
        st.metric("p99 solve time", _fmt_ms(overall.get("p99_ms")))
        st.caption(f"p99 iter: {_fmt_int(overall.get('p99_iter'))} · max: {_fmt_ms(overall.get('max_ms'))}")

    if by_purpose:
        st.caption("Per-purpose breakdown (rovnaké okno)")
        rows = []
        for r in by_purpose:
            rows.append(
                {
                    "purpose": r.get("purpose"),
                    "solved": r.get("solved") or 0,
                    "pending": r.get("pending") or 0,
                    "expired_unsolved": r.get("expired_unsolved") or 0,
                    "avg_difficulty": r.get("avg_difficulty"),
                    "p50_ms": _fmt_ms(r.get("p50_ms")),
                    "p95_ms": _fmt_ms(r.get("p95_ms")),
                    "p99_ms": _fmt_ms(r.get("p99_ms")),
                    "p50_iter": _fmt_int(r.get("p50_iter")),
                    "p95_iter": _fmt_int(r.get("p95_iter")),
                    "p99_iter": _fmt_int(r.get("p99_iter")),
                }
            )
        if pd is not None:
            st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)
        else:
            st.json(rows)

    if hist and pd is not None:
        st.caption("Difficulty histogram (počet challenge-ov za okno)")
        df = pd.DataFrame(hist).set_index("difficulty")[["solved", "total"]]
        st.bar_chart(df, height=180)

    st.caption(
        "Zdroj: pow_challenges. solve_ms = solved_at − created_at (server wall-clock medzi "
        "vystavením a prijatím riešenia, vrátane latencie siete). Iterations sú self-reported "
        "klientom (`pow.iterations`) — orientačné. Okno cez `DASH_POW_WINDOW_HOURS` (default 24)."
    )


def gauge_html(rs: float, rs_max: float = 10.0) -> str:
    pct = max(0.0, min(100.0, (rs / rs_max) * 100.0))
    return f"""
<div class="kya-gauge-wrap">
  <div class="kya-gauge" style="--rs: {pct:.1f};">
    <div class="kya-gauge-inner">
      <span class="kya-gauge-val">{rs:.2f}</span>
      <span class="kya-gauge-lbl">Reputation (0–{rs_max:g})</span>
    </div>
  </div>
</div>
"""


def main() -> None:
    st.set_page_config(
        page_title="KYA Hub — Command Center",
        page_icon="◉",
        layout="wide",
        initial_sidebar_state="collapsed",
    )
    st.markdown(CSS, unsafe_allow_html=True)

    refresh_ms = max(400, _env_int("DASH_REFRESH_MS", 900))
    log_path = _env_path("KYA_HUB_LOG_PATH", "/root/.pm2/logs/kya-hub-out.log")
    repo = _env_path("KYA_HUB_REPO", "/root/kya-hub")
    molt_pubkey = os.environ.get("MOLTBOOK_NODE_PUBKEY", "").strip()
    molt_cache = _env_float("MOLTBOOK_RS_CACHE_SEC", 12.0)
    rs_max = _env_float("MOLTBOOK_RS_MAX", 10.0)

    if "acc" not in st.session_state:
        st.session_state.acc = LogAccumulator()

    acc: LogAccumulator = st.session_state.acc
    acc.tail_file(log_path)

    st.title("KYA HUB — REAL-TIME OPS")

    c1, c2, c3, c4 = st.columns(4)
    cpu = psutil.cpu_percent(interval=None)
    vm = psutil.virtual_memory()
    with c1:
        st.metric("CPU %", f"{cpu:.1f}")
    with c2:
        st.metric("RAM %", f"{vm.percent:.1f}")
    with c3:
        st.metric("RAM used GB", f"{vm.used / (1024**3):.2f}")
    with c4:
        st.metric("Log tail", os.path.basename(log_path))

    rs_val, rs_err = fetch_moltbook_rs(molt_pubkey, molt_cache)
    if rs_val is None:
        rs_display = 8.7  # placeholder when API unset / failing (per product brief)
        rs_note = f"(demo fallback — {rs_err})"
    else:
        rs_display = rs_val
        rs_note = rs_err or "live"

    left, right = st.columns([1, 1.2])

    with left:
        st.subheader("Reputation gauge")
        st.markdown(gauge_html(rs_display, rs_max=rs_max), unsafe_allow_html=True)
        st.caption(f"Moltbook: {rs_note}")

    with right:
        st.subheader("Entropy health (Shannon bits/byte, challenge nonces)")
        if acc.entropy_series:
            vals = [v for _, v in acc.entropy_series]
            st.line_chart(vals, height=240)
            h_max = math.log2(256)
            last_h = vals[-1] if vals else 0
            ratio = last_h / h_max if h_max else 0
            st.caption(f"Uniform-byte max ≈ {h_max:.3f} bits/byte. Last sample: {last_h:.3f} ({ratio*100:.0f}% of max).")
            st.caption("Pozn.: meria náhodnosť `nonce` bytov, NIE obtiažnosť PoW. Súvisiace, ale rôzne signály.")
        else:
            st.info("No `nonce` fields observed in recent log window (hub may not log nonces at info).")

    # ------------------------------------------------------------------
    # PoW solve-effort panel (decision support pre POW_*_DIFFICULTY)
    # ------------------------------------------------------------------
    db_for_pow = _get_db_snapshot_cached(st.session_state, repo)
    _render_pow_solve_effort_panel(db_for_pow)

    st.divider()

    h1, h2, h3 = st.columns(3)
    with h1:
        st.subheader("HTTP status mix (from log)")
        st.write(
            f'<span style="color:{NEON_OK}">200: {acc.http_counts[200]}</span> &nbsp;|&nbsp; '
            f'<span style="color:{NEON_OK}">400: {acc.http_counts[400]}</span> &nbsp;|&nbsp; '
            f'<span class="kya-403">403: {acc.http_counts[403]}</span> &nbsp;|&nbsp; '
            f'<span class="kya-429">429: {acc.http_counts[429]}</span>',
            unsafe_allow_html=True,
        )
        st.caption("Counts increment when logs include `http_status` or CLF status tokens.")
    with h2:
        st.subheader("Payment pipeline (BTCPay webhooks)")
        total = acc.payment_settled + acc.payment_expired
        if total:
            st.progress(acc.payment_settled / total if total else 0)
            st.caption(f"Settled {acc.payment_settled} / Expired {acc.payment_expired}")
        else:
            st.write(f"Settled: **{acc.payment_settled}** · Expired: **{acc.payment_expired}**")
        st.caption("Parsed from `eventType` / invoice event strings in log lines.")
    with h3:
        st.subheader("Telemetry")
        st.json({"cpu_percent": cpu, "ram_percent": vm.percent, "log_path": log_path})

    st.divider()
    st.subheader("Registrácie a vygenerované faktúry (PostgreSQL)")
    db = _get_db_snapshot_cached(st.session_state, repo)
    if not db.get("ok"):
        if (db.get("err") or "").strip() == "DASH_DB_DISABLED":
            st.caption("DB panel je vypnutý (`DASH_DB_DISABLED=1`).")
        else:
            st.warning(db.get("err") or "Nepodarilo sa načítať dáta z databázy.")
        st.caption(
            "Na pripojenie sa použije `KYA_HUB_REPO/.env` (ak premenné nie sú v prostredí): "
            "`DB_HOST`, `DB_PORT`, `DB_NAME`, `KYAHUB_APP_PASSWORD` alebo `DASH_DB_PASSWORD`, "
            "voliteľne `DASH_DB_USER` (default `kyahub_app`)."
        )
    else:
        m1, m2, m3, m4 = st.columns(4)
        with m1:
            st.metric("Intenty celkom", db.get("intents_total", 0))
        with m2:
            st.metric("Intenty 24 h", db.get("intents_24h", 0))
        with m3:
            st.metric("Intenty 7 d", db.get("intents_7d", 0))
        with m4:
            st.metric("Faktúry celkom", db.get("invoices_total", 0))
        m5, m6 = st.columns(2)
        with m5:
            st.metric("Faktúry 7 d (issued)", db.get("invoices_7d", 0))
        with m6:
            sats = db.get("invoices_sum_sats") or 0
            st.metric("Suma zaplatených (všetky faktúry)", f"{int(sats):,} sats")

        ibs = db.get("intents_by_status") or []
        if ibs and pd is not None:
            st.caption("Intenty podľa stavu (všetky časy)")
            st.bar_chart(pd.DataFrame(ibs).set_index("status")["c"], height=min(280, 40 + 36 * len(ibs)))

        c_left, c_right = st.columns(2)
        with c_left:
            st.markdown(f"**Posledné intenty** ({len(db.get('intents_recent') or [])} riadkov)")
            if db.get("intents_recent") and pd is not None:
                st.dataframe(
                    pd.DataFrame(db["intents_recent"]),
                    use_container_width=True,
                    hide_index=True,
                )
            elif db.get("intents_recent"):
                st.json(db["intents_recent"])
            else:
                st.caption("Žiadne záznamy v `registration_intents`.")
        with c_right:
            st.markdown("**Posledné PDF faktúry** (`invoices`)")
            if db.get("invoices_err"):
                st.info(db["invoices_err"])
            elif db.get("invoices_recent") and pd is not None:
                st.dataframe(
                    pd.DataFrame(db["invoices_recent"]),
                    use_container_width=True,
                    hide_index=True,
                )
            elif db.get("invoices_recent"):
                st.json(db["invoices_recent"])
            else:
                st.caption("Žiadne riadky v `invoices` (PDF faktúry po platbe / backfill).")
        st.caption(
            f"DB cache: {max(3, _env_int('DASH_DB_CACHE_SEC', 15))} s · "
            "Vypni panel: `DASH_DB_DISABLED=1`."
        )

    st.subheader("Inbound pressure — handshake stream")
    if acc.handshake_stream:
        body = "\n".join(html.escape(s) for s in reversed(list(acc.handshake_stream)))
        st.markdown(f'<div class="kya-stream">{body}</div>', unsafe_allow_html=True)
    else:
        st.caption("No handshake-like lines yet (webhooks, auth routes, relay strings).")

    with st.expander("Recent transaction-like IDs"):
        uniq: List[str] = []
        seen = set()
        for tid in reversed(list(acc.txn_ids)):
            if tid not in seen:
                seen.add(tid)
                uniq.append(tid)
            if len(uniq) >= 40:
                break
        st.code("\n".join(uniq) if uniq else "(none in window)")

    st.caption(
        f"Refresh ≈ {refresh_ms} ms · KYA_HUB_LOG_PATH={log_path} · KYA_HUB_REPO={repo} · "
        "Install: pip install -r monitoring/requirements-monitoring.txt"
    )

    time.sleep(max(0.35, refresh_ms / 1000.0))
    st.rerun()


if __name__ == "__main__":
    main()
