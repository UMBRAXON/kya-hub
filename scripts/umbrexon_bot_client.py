#!/usr/bin/env python3
"""
UMBRAXON KYA-Hub — referenčný Python klient (SDK-lite).

Cieľ: každý čestný bot dokáže zaregistrovať agenta a podpísať `action` request
bez toho, aby musel sám reverse-engineerovať pravidlá pre digesty a podpisy.
Tento skript je bytes-kompatibilný s `server.js` a `lib/manifest-schema.js`
v repozitári; self-test ho overuje proti pevným zlatým hashom (--self-test).

Pravidlá podpisovania (DÔLEŽITÉ — ÚMYSELNE NIE HMAC):

  1) /api/register/initiate
     - manifest_hash    = sha256(canonicalize(manifest))         (32 B digest)
     - manifest_signature = Ed25519_sign(privkey, manifest_hash) (64 B → 128 hex)
     - challenge_response = Ed25519_sign(privkey, raw_nonce_bytes)
       kde raw_nonce_bytes = bytes.fromhex(challenge.nonce)
     - canonicalize = JSON s rekurzívne zoradenými kľúčmi, žiadne medzery,
       Unicode literálne. V Pythone:
         json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

  2) /api/agent/<kya_id>/action
     - body = OrderedDict s PEVNÝM poradím kľúčov (server.js, riadok ~2339):
         action_type, target, context, evidence_hash, nonce, timestamp
     - canonical_body = json.dumps(body, separators=(',', ':'), ensure_ascii=False)
       (POZNÁMKA: tu NIE je sort_keys — server stringifikuje v insertion-order!)
     - signature = Ed25519_sign(privkey, sha256(canonical_body))

  3) /api/pow/challenge
     - server vráti `challenge` (32 B hex) a `difficulty` (počet leading zero bits).
     - klient hľadá `nonce` (ľubovoľný hex reťazec) taký, že:
         sha256(f"{challenge}:{nonce}").digest má aspoň `difficulty` leading 0 bits
     - počas hľadania klient počíta `iterations` a posiela ich serveru
       (server ich len logguje pre telemetriu, p50/p95/p99 na dashboarde).

Závislosti:
  - PyNaCl (`pip install pynacl`)   — Ed25519 podpis/overenie
  - stdlib only pre HTTP (urllib.request, urllib.error)

CLI použitie (príklady):
  python3 umbrexon_bot_client.py self-test
  python3 umbrexon_bot_client.py keygen --out /etc/umbraxon/bot.key
  python3 umbrexon_bot_client.py register \\
      --base-url https://hub.umbraxon.xyz \\
      --privkey-file /etc/umbraxon/bot.key \\
      --name MYBOT-PROD --version 1.0.0 \\
      --capability btc_payments --capability kyc_check \\
      --tier BASIC
  # Voliteľné polia manifestu (non-custodial — hub nedrží prostriedky):
  #   --payment-hint lightning_address:bot@wallet.example \\
  #   --discovery-opt-in \\
  #   --webhook 'https://your.app/hooks/kya|agent.registered,reputation.changed'
  python3 umbrexon_bot_client.py delegation-pass \\
      --base-url https://hub.umbraxon.xyz \\
      --privkey-file bot.key --kya-id UMBRA-ABCDEF \\
      --ttl-seconds 300 \\
      --caveat payment.max_satoshi:5000 \\
      --l402-json '{"max_msat":5000000}'
  python3 umbrexon_bot_client.py solve-pow --base-url https://hub.umbraxon.xyz \\
      --purpose pay
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import uuid
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Dependency: PyNaCl for Ed25519. Fail fast with a helpful message if missing.
# ---------------------------------------------------------------------------
try:
    import nacl.signing
    import nacl.encoding
    import nacl.exceptions
    HAVE_NACL = True
except ImportError:  # pragma: no cover
    HAVE_NACL = False


# ===========================================================================
# Crypto: Ed25519 keys
# ===========================================================================
def _require_nacl() -> None:
    if not HAVE_NACL:
        raise RuntimeError(
            "PyNaCl nie je nainštalovaný. Spusti: pip install pynacl\n"
            "Bez neho nedokážeš podpisovať manifesty / challenge nonce / action body."
        )


def generate_seed() -> bytes:
    """Generuje 32 B Ed25519 seed. Zhodné s `crypto.generateKeyPairSync('ed25519')` v Node."""
    return secrets.token_bytes(32)


def derive_pubkey_hex(seed: bytes) -> str:
    """Zo 32 B seedu odvodí 32 B Ed25519 verejný kľúč v lower-case hex (64 znakov)."""
    _require_nacl()
    if len(seed) != 32:
        raise ValueError(f"seed musí mať 32 B, dostal som {len(seed)} B")
    sk = nacl.signing.SigningKey(seed)
    return sk.verify_key.encode(encoder=nacl.encoding.HexEncoder).decode("ascii").lower()


def sign_ed25519(seed: bytes, msg: bytes) -> str:
    """Vráti 64 B Ed25519 signature ako 128-znakový lower-case hex (kompatibilné s server.js)."""
    _require_nacl()
    if len(seed) != 32:
        raise ValueError(f"seed musí mať 32 B, dostal som {len(seed)} B")
    sk = nacl.signing.SigningKey(seed)
    sig = sk.sign(msg).signature  # 64 B
    return sig.hex()


def verify_ed25519(pubkey_hex: str, msg: bytes, sig_hex: str) -> bool:
    _require_nacl()
    try:
        vk = nacl.signing.VerifyKey(bytes.fromhex(pubkey_hex))
        vk.verify(msg, bytes.fromhex(sig_hex))
        return True
    except (nacl.exceptions.BadSignatureError, ValueError):
        return False


def load_seed(privkey_file: Optional[str], privkey_hex_env: Optional[str]) -> bytes:
    """Načíta 32 B seed buď zo súboru (raw 32 B alebo hex), alebo z env premennej v hex."""
    if privkey_file:
        with open(privkey_file, "rb") as f:
            raw = f.read().strip()
        # Súbor smie obsahovať 32 raw bajtov ALEBO 64 hex znakov (s/bez whitespace).
        if len(raw) == 32:
            return raw
        try:
            txt = raw.decode("ascii").strip()
        except UnicodeDecodeError:
            raise ValueError(f"{privkey_file}: neznámy formát (nie 32 B raw ani hex)")
        if len(txt) == 64 and all(c in "0123456789abcdefABCDEF" for c in txt):
            return bytes.fromhex(txt)
        raise ValueError(f"{privkey_file}: očakávam 32 B raw alebo 64-znakový hex seed")
    if privkey_hex_env:
        env_val = os.environ.get(privkey_hex_env, "").strip()
        if not env_val:
            raise ValueError(f"env {privkey_hex_env} je prázdne")
        return bytes.fromhex(env_val)
    raise ValueError("musí byť zadané --privkey-file alebo --privkey-env")


def save_seed(seed: bytes, out_path: str) -> None:
    """Uloží 32 B seed do súboru ako 64 hex znakov + newline (chmod 0600)."""
    if len(seed) != 32:
        raise ValueError("seed musí mať 32 B")
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, (seed.hex() + "\n").encode("ascii"))
    finally:
        os.close(fd)


# ===========================================================================
# Canonical JSON + manifest hash (matches lib/manifest-schema.js)
# ===========================================================================
def canonicalize_manifest(obj: Any) -> str:
    """JSON.stringify s rekurzívne sortovanými kľúčmi, bez medzier, Unicode literálne.

    Zhodné s `lib/manifest-schema.js#canonicalize` keď manifest obsahuje len
    objekty, polia, reťazce, čísla, bool a null (čo je presne tvar schémy v1.0).
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def manifest_hash(manifest: Dict[str, Any]) -> str:
    """sha256(canonicalize(manifest)) → 64-znakový lower-case hex."""
    return hashlib.sha256(canonicalize_manifest(manifest).encode("utf-8")).hexdigest()


def _sort_json_obj(obj: Any) -> Any:
    """Rekurzívne zoradené kľúče — zhodné s lib/certs.js sortObjectKeys."""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, list):
        return [_sort_json_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _sort_json_obj(obj[k]) for k in sorted(obj.keys())}
    raise TypeError(f"Unsupported JSON type: {type(obj)}")


def canonicalize_sorted_obj(obj: Dict[str, Any]) -> str:
    """Rovnaký tvar ako certs.canonicalize() pre delegation l402_claims."""
    return json.dumps(_sort_json_obj(obj), separators=(",", ":"), ensure_ascii=False)


def clamp_delegation_ttl(sec: Any) -> int:
    try:
        n = int(sec)
    except (TypeError, ValueError):
        return 300
    return min(3600, max(60, n))


def delegation_request_digest(
    kya_id: str,
    ttl_seconds: int,
    caveats: List[str],
    l402_claims: Dict[str, Any],
    nonce: str,
    timestamp: str,
) -> bytes:
    """Musí byť byte-identické s lib/delegation-pass.js#agentRequestDigest."""
    caveats_canon = json.dumps([str(c)[:256] for c in caveats], separators=(",", ":"), ensure_ascii=False)
    if l402_claims:
        l402_canon = canonicalize_sorted_obj(l402_claims)
    else:
        l402_canon = "{}"
    msg = (
        f"{kya_id}|delegation_pass_request|{ttl_seconds}|"
        f"{caveats_canon}|{l402_canon}|{nonce}|{timestamp}"
    )
    return hashlib.sha256(msg.encode("utf-8")).digest()


# ===========================================================================
# Action body — DIFFERENT serialization rule than manifest (fixed key order).
# ===========================================================================
ACTION_KEY_ORDER: Tuple[str, ...] = (
    "action_type",
    "target",
    "context",
    "evidence_hash",
    "nonce",
    "timestamp",
)


def action_canonical_body(
    action_type: str,
    target: Optional[str],
    context: Optional[Dict[str, Any]],
    evidence_hash: Optional[str],
    nonce: str,
    timestamp: str,
) -> str:
    """Vyrobí presne taký JSON string, aký server.js spraví cez JSON.stringify({...}).

    Pozor: server NEpoužíva sort_keys, len insertion-order pevných 6 kľúčov.
    """
    body = OrderedDict()
    body["action_type"] = action_type
    body["target"] = target if target is not None else None
    body["context"] = context if context is not None else None
    body["evidence_hash"] = evidence_hash if evidence_hash is not None else None
    body["nonce"] = nonce
    body["timestamp"] = timestamp
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False)


def action_digest(
    action_type: str,
    target: Optional[str],
    context: Optional[Dict[str, Any]],
    evidence_hash: Optional[str],
    nonce: str,
    timestamp: str,
) -> bytes:
    body = action_canonical_body(action_type, target, context, evidence_hash, nonce, timestamp)
    return hashlib.sha256(body.encode("utf-8")).digest()


# ===========================================================================
# Signing helpers (the three rules)
# ===========================================================================
def sign_manifest(seed: bytes, manifest: Dict[str, Any]) -> Tuple[str, str]:
    """Vráti (manifest_hash_hex, signature_hex). Podpisuje sa 32 B digest, nie raw JSON."""
    m_hash_hex = manifest_hash(manifest)
    return m_hash_hex, sign_ed25519(seed, bytes.fromhex(m_hash_hex))


def sign_challenge_nonce(seed: bytes, nonce_hex: str) -> str:
    """Podpisujú sa SUROVÉ bajty nonce-u (server: hubkeys.verify(Buffer.from(nonce, 'hex'), ...))."""
    return sign_ed25519(seed, bytes.fromhex(nonce_hex))


def sign_action_body(
    seed: bytes,
    action_type: str,
    target: Optional[str],
    context: Optional[Dict[str, Any]],
    evidence_hash: Optional[str],
    nonce: str,
    timestamp: str,
) -> Tuple[str, str]:
    """Vráti (canonical_body_str, signature_hex). Podpisuje sa sha256(canonical_body)."""
    body = action_canonical_body(action_type, target, context, evidence_hash, nonce, timestamp)
    digest = hashlib.sha256(body.encode("utf-8")).digest()
    return body, sign_ed25519(seed, digest)


# ===========================================================================
# Proof-of-Work solver (matches lib/pow.js)
# ===========================================================================
def has_leading_zero_bits(digest: bytes, bits: int) -> bool:
    """Zhodné s lib/pow.js#hasLeadingZeroBits — kontrola po bajtoch + posledný byte cez masku."""
    remaining = bits
    for i, byte in enumerate(digest):
        if remaining <= 0:
            return True
        if remaining >= 8:
            if byte != 0:
                return False
            remaining -= 8
        else:
            mask = (0xff << (8 - remaining)) & 0xff
            if (byte & mask) != 0:
                return False
            remaining = 0
    return True


def solve_pow(
    challenge: str,
    difficulty: int,
    max_seconds: float = 60.0,
    max_iterations: int = 0,
) -> Dict[str, Any]:
    """Hľadá `nonce` (8 B hex) taký, že sha256(f"{challenge}:{nonce}") má aspoň `difficulty` 0 bits.

    `max_seconds` <= 0 znamená bez časového limitu.
    `max_iterations` <= 0 znamená bez limitu počtu iterácií.
    """
    start = time.monotonic()
    iterations = 0
    prefix = (challenge + ":").encode("ascii")
    while True:
        nonce_bytes = secrets.token_bytes(8)
        nonce_hex = nonce_bytes.hex()
        digest = hashlib.sha256(prefix + nonce_hex.encode("ascii")).digest()
        iterations += 1
        if has_leading_zero_bits(digest, difficulty):
            return {
                "nonce": nonce_hex,
                "iterations": iterations,
                "elapsed_sec": time.monotonic() - start,
                "hash": digest.hex(),
            }
        if max_iterations > 0 and iterations >= max_iterations:
            raise RuntimeError(f"PoW nevyriešený za {iterations} iterácií")
        if max_seconds > 0 and (iterations & 0x3ff) == 0:
            if time.monotonic() - start > max_seconds:
                raise RuntimeError(
                    f"PoW nevyriešený za {max_seconds:.1f}s (difficulty={difficulty}, iter={iterations})"
                )


# ===========================================================================
# HTTP helpers — urllib + 429 backoff with Retry-After
# ===========================================================================
class HubClient:
    def __init__(
        self,
        base_url: str,
        connect_timeout: float = 5.0,
        read_timeout: float = 20.0,
        max_429_retries: int = 4,
        backoff_base_sec: float = 1.0,
        backoff_cap_sec: float = 30.0,
        admin_key: Optional[str] = None,
        user_agent: str = "umbrexon-bot-client/1.0",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        # urllib uses one combined timeout; pick the larger.
        self.timeout = max(connect_timeout, read_timeout)
        self.max_429_retries = max(0, int(max_429_retries))
        self.backoff_base = max(0.1, backoff_base_sec)
        self.backoff_cap = max(self.backoff_base, backoff_cap_sec)
        self.admin_key = admin_key
        self.user_agent = user_agent

    def _build_request(self, method: str, path: str, body: Optional[Dict[str, Any]]) -> urllib.request.Request:
        url = f"{self.base_url}{path}"
        data = None
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        if self.admin_key:
            headers["X-Admin-Key"] = self.admin_key
        return urllib.request.Request(url, data=data, method=method, headers=headers)

    def request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Vykoná HTTP request s 429 retry. Vráti dict {status, headers, json}.

        Pri 429 čítame Retry-After header (sekundy alebo HTTP-date); ak chýba,
        použije sa exponenciálny backoff s capom.
        """
        attempt = 0
        while True:
            req = self._build_request(method, path, body)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return self._read_response(resp)
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt >= self.max_429_retries:
                    return self._read_response(e)
                wait = self._compute_429_backoff(e, attempt)
                time.sleep(wait)
                attempt += 1

    def _read_response(self, resp) -> Dict[str, Any]:
        status = getattr(resp, "status", None) or getattr(resp, "code", None) or 0
        raw = resp.read()
        text = raw.decode("utf-8", errors="replace")
        headers = {k.lower(): v for k, v in (resp.headers.items() if resp.headers else [])}
        body: Any
        try:
            body = json.loads(text) if text else None
        except json.JSONDecodeError:
            body = text
        return {"status": status, "headers": headers, "json": body}

    def _compute_429_backoff(self, http_err: urllib.error.HTTPError, attempt: int) -> float:
        retry_after = http_err.headers.get("Retry-After") if http_err.headers else None
        if retry_after:
            ra = retry_after.strip()
            # Plain seconds.
            try:
                return min(self.backoff_cap, max(0.0, float(ra)))
            except ValueError:
                pass
            # HTTP-date — fall back to exponential rather than parsing RFC 7231.
        return min(self.backoff_cap, self.backoff_base * (2 ** attempt))

    # --- Convenience wrappers ------------------------------------------------
    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if params:
            path = f"{path}?{urllib.parse.urlencode(params)}"
        return self.request("GET", path, body=None)

    def post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        return self.request("POST", path, body=body)


# ===========================================================================
# High-level helpers: fetch + solve PoW, fetch challenge + sign nonce.
# ===========================================================================
def fetch_and_solve_pow(
    client: HubClient,
    purpose: str = "register",
    difficulty: Optional[int] = None,
    max_seconds: float = 60.0,
) -> Dict[str, Any]:
    params: Dict[str, Any] = {"purpose": purpose}
    if difficulty is not None:
        params["difficulty"] = int(difficulty)
    res = client.get("/api/pow/challenge", params)
    if res["status"] != 200 or not isinstance(res["json"], dict):
        raise RuntimeError(f"PoW challenge fetch failed: status={res['status']} body={res['json']}")
    ch = res["json"]
    sol = solve_pow(ch["challenge"], int(ch["difficulty"]), max_seconds=max_seconds)
    return {
        "challenge_id": ch["challenge_id"],
        "nonce": sol["nonce"],
        "iterations": sol["iterations"],
        "elapsed_sec": sol["elapsed_sec"],
        "difficulty": int(ch["difficulty"]),
        "purpose": ch.get("purpose", purpose),
    }


def fetch_auth_challenge(client: HubClient, pubkey_hex: str) -> Dict[str, Any]:
    res = client.get("/api/auth/challenge", {"pubkey": pubkey_hex})
    if res["status"] != 200 or not isinstance(res["json"], dict):
        raise RuntimeError(f"auth challenge fetch failed: status={res['status']} body={res['json']}")
    return res["json"]


# ===========================================================================
# Register flow (end-to-end)
# ===========================================================================
def build_manifest(
    name: str,
    version: str,
    pubkey_hex: str,
    capabilities: List[str],
    tier: str,
    model: Optional[str] = None,
    runtime: Optional[str] = None,
    description: Optional[str] = None,
    payment_hints: Optional[List[Dict[str, str]]] = None,
    discovery_opt_in: bool = False,
    developer_webhooks: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Postaví manifest podľa lib/manifest-schema.js. Nepridáva nič nadbytočné."""
    agent: Dict[str, Any] = {
        "name": name,
        "version": version,
        "pubkey": pubkey_hex.lower(),
        "capabilities": list(capabilities),
    }
    if model:
        agent["model"] = model
    if runtime:
        agent["runtime"] = runtime
    if description:
        agent["description"] = description
    manifest: Dict[str, Any] = {
        "protocol_version": "1.0",
        "agent": agent,
        "tier_requested": tier,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "nonce": secrets.token_hex(16),
    }
    if payment_hints:
        manifest["payment_hints"] = list(payment_hints)
    integrations: Dict[str, Any] = {}
    if discovery_opt_in:
        integrations["discovery_opt_in"] = True
    if developer_webhooks:
        integrations["developer_webhooks"] = list(developer_webhooks)
    if integrations:
        manifest["integrations"] = integrations
    return manifest


def build_manifest_v1_compact(
    name: str,
    version: str,
    pubkey_hex: str,
    capabilities: List[str],
    tier: str,
    lightning_node_id: str,
    discovery_opt_in: bool = False,
    description: Optional[str] = None,
) -> Dict[str, Any]:
    """Manifest zostavený hubom z POST /api/v1/register — musí byť identický pred podpisom."""
    agent: Dict[str, Any] = {
        "name": name,
        "version": version,
        "pubkey": pubkey_hex.lower(),
        "capabilities": list(capabilities),
    }
    if description:
        agent["description"] = description[:512]
    manifest: Dict[str, Any] = {
        "protocol_version": "1.0",
        "agent": agent,
        "tier_requested": tier,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "nonce": secrets.token_hex(16),
        "payment_hints": [
            {
                "type": "lightning_node_id",
                "value": lightning_node_id.strip(),
                "label": "m2m_registration",
            }
        ],
    }
    if discovery_opt_in:
        manifest["integrations"] = {"discovery_opt_in": True}
    return manifest


def do_register_v1(
    client: HubClient,
    seed: bytes,
    *,
    agent_name: str,
    version: str,
    capabilities: List[str],
    tier: str,
    lightning_node_id: str,
    discovery_opt_in: bool = False,
    description: Optional[str] = None,
    pow_max_seconds: float = 60.0,
    print_only: bool = False,
) -> Dict[str, Any]:
    """POST /api/v1/register — kompaktné M2M telo (hub zostaví manifest)."""
    pubkey_hex = derive_pubkey_hex(seed)
    manifest = build_manifest_v1_compact(
        agent_name, version, pubkey_hex, capabilities, tier, lightning_node_id,
        discovery_opt_in=discovery_opt_in, description=description,
    )
    m_hash_hex, m_sig = sign_manifest(seed, manifest)
    ch = fetch_auth_challenge(client, pubkey_hex)
    challenge_response = sign_challenge_nonce(seed, ch["nonce"])
    pow_solution = fetch_and_solve_pow(client, purpose="register", max_seconds=pow_max_seconds)

    body = {
        "agent_name": agent_name,
        "agent_version": version,
        "public_key": pubkey_hex,
        "lightning_node_id": lightning_node_id.strip(),
        "capabilities": list(capabilities),
        "tier": tier,
        "timestamp": manifest["timestamp"],
        "nonce": manifest["nonce"],
        "manifest_signature": m_sig,
        "challenge_id": ch["challenge_id"],
        "challenge_response": challenge_response,
        "pow": {
            "challenge_id": pow_solution["challenge_id"],
            "nonce": pow_solution["nonce"],
            "difficulty": pow_solution["difficulty"],
            "iterations": pow_solution["iterations"],
            "solve_ms": int(pow_solution["elapsed_sec"] * 1000),
        },
    }
    if discovery_opt_in:
        body["integrations"] = {"discovery_opt_in": True}
    if description:
        body["agent_description"] = description[:512]

    if print_only:
        return {"prepared_body": body, "manifest_hash": m_hash_hex, "manifest": manifest}

    res = client.post("/api/v1/register", body)
    return {
        "status": res["status"],
        "response": res["json"],
        "manifest_hash": m_hash_hex,
        "registration_id": (res.get("json") or {}).get("registration_id"),
    }


def fetch_registration_status(client: HubClient, registration_id: str) -> Dict[str, Any]:
    q = urllib.parse.urlencode({"registration_id": registration_id})
    res = client.get(f"/api/v1/register/status?{q}")
    if res["status"] != 200 or not isinstance(res["json"], dict):
        raise RuntimeError(
            f"registration status failed: status={res['status']} body={res['json']}"
        )
    return res["json"]


def poll_registration_until_done(
    client: HubClient,
    registration_id: str,
    *,
    timeout_sec: float = 900.0,
    interval_sec: float = 4.0,
    on_tick: Optional[Any] = None,
) -> Dict[str, Any]:
    """Poll /api/v1/register/status until COMPLETED or EXPIRED."""
    deadline = time.monotonic() + timeout_sec
    last: Dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = fetch_registration_status(client, registration_id)
        if on_tick:
            on_tick(last)
        st = last.get("status")
        if st == "COMPLETED" and last.get("kya_id"):
            return last
        if st == "EXPIRED":
            raise RuntimeError(f"registration expired: {registration_id}")
        time.sleep(interval_sec)
    raise TimeoutError(
        f"registration {registration_id} not completed within {timeout_sec}s; last={last}"
    )


def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def pay_bolt11_via_nwc(
    payment_request: str,
    *,
    expected_sats: Optional[int] = None,
    registration_id: Optional[str] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Zaplatí BOLT11 cez NWC (Node script + lib/alby.js). Env: NWC_PAY_URI alebo ALBY_NWC_URI."""
    if not payment_request or not str(payment_request).lower().startswith("ln"):
        raise ValueError("payment_request musí byť BOLT11 (lnbc... / lntb...)")
    root = _repo_root()
    script = os.path.join(root, "scripts", "nwc-pay-invoice.js")
    if not os.path.isfile(script):
        raise FileNotFoundError(f"missing {script}")
    cmd = ["node", script, payment_request.strip()]
    if expected_sats is not None and expected_sats > 0:
        cmd.extend(["--expected-sats", str(int(expected_sats))])
    if dry_run:
        cmd.append("--dry-run")
    env = os.environ.copy()
    if registration_id:
        env["REGISTRATION_ID"] = registration_id
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=root,
        env=env,
        timeout=120,
    )
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    try:
        body = json.loads(stdout) if stdout else {}
    except json.JSONDecodeError:
        body = {"ok": False, "error": "NWC_PAY_INVALID_JSON", "raw": stdout, "stderr": stderr}
    if proc.returncode != 0 and body.get("ok") is not False:
        body = {
            "ok": False,
            "error": "NWC_PAY_FAILED",
            "exit_code": proc.returncode,
            "stderr": stderr[-2000:] if stderr else "",
            "stdout": stdout[-2000:] if stdout else "",
        }
    return body


def fetch_cert(client: HubClient, kya_id: str) -> Dict[str, Any]:
    res = client.get(f"/api/cert/{urllib.parse.quote(kya_id, safe='')}")
    if res["status"] != 200:
        raise RuntimeError(f"cert fetch failed: status={res['status']} body={res['json']}")
    return res["json"]


def do_register(
    client: HubClient,
    seed: bytes,
    manifest: Dict[str, Any],
    pow_max_seconds: float = 60.0,
    print_only: bool = False,
) -> Dict[str, Any]:
    pubkey_hex = manifest["agent"]["pubkey"].lower()

    # 1) Manifest hash + signature
    m_hash_hex, m_sig = sign_manifest(seed, manifest)

    # 2) Auth challenge → podpis raw nonce bajtov
    ch = fetch_auth_challenge(client, pubkey_hex)
    challenge_response = sign_challenge_nonce(seed, ch["nonce"])

    # 3) PoW (ak je vyžadovaný pre purpose=register, jeho riešenie nezaškodí ani tak)
    pow_solution = fetch_and_solve_pow(client, purpose="register", max_seconds=pow_max_seconds)

    body = {
        "manifest": manifest,
        "manifest_signature": m_sig,
        "challenge_id": ch["challenge_id"],
        "challenge_response": challenge_response,
        "pow": {
            "challenge_id": pow_solution["challenge_id"],
            "nonce": pow_solution["nonce"],
            "iterations": pow_solution["iterations"],
        },
    }
    if print_only:
        return {"prepared_body": body, "manifest_hash": m_hash_hex}

    res = client.post("/api/register/initiate", body)
    return {
        "status": res["status"],
        "response": res["json"],
        "manifest_hash": m_hash_hex,
        "pow_iterations": pow_solution["iterations"],
        "pow_elapsed_sec": pow_solution["elapsed_sec"],
        "challenge_ttl_mode": ch.get("ttl_mode"),
        "challenge_ttl_sec": ch.get("ttl_sec"),
    }


def do_issue_delegation_pass(
    client: HubClient,
    seed: bytes,
    kya_id: str,
    caveats: List[str],
    l402_claims: Dict[str, Any],
    ttl_seconds: int = 300,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """POST /api/agent/{kya_id}/delegation-pass — podpis request digest (Ed25519)."""
    ttl = clamp_delegation_ttl(ttl_seconds)
    nonce = secrets.token_hex(16)
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    digest = delegation_request_digest(kya_id, ttl, caveats, l402_claims, nonce, timestamp)
    sig = sign_ed25519(seed, digest)
    body: Dict[str, Any] = {
        "caveats": caveats,
        "ttl_seconds": ttl,
        "nonce": nonce,
        "timestamp": timestamp,
        "signature": sig,
    }
    if l402_claims:
        body["l402_claims"] = l402_claims
    if dry_run:
        return {"prepared_body": body, "digest_hex": digest.hex()}
    res = client.post(f"/api/agent/{urllib.parse.quote(kya_id, safe='')}/delegation-pass", body)
    return {"status": res["status"], "response": res["json"], "request": body}


# ===========================================================================
# Self-test — bytes-exact golden vectors vs Node (test-anti-abuse.js style)
# ===========================================================================
GOLDEN_MANIFEST = {
    "protocol_version": "1.0",
    "agent": {
        "name": "PYTHON-GOLDEN",
        "version": "1.0.0",
        "pubkey": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        "capabilities": ["btc_payments", "kyc_check"],
    },
    "tier_requested": "BASIC",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "nonce": "00112233445566778899aabbccddeeff",
}
GOLDEN_MANIFEST_CANONICAL = (
    '{"agent":{"capabilities":["btc_payments","kyc_check"],'
    '"name":"PYTHON-GOLDEN",'
    '"pubkey":"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",'
    '"version":"1.0.0"},'
    '"nonce":"00112233445566778899aabbccddeeff",'
    '"protocol_version":"1.0",'
    '"tier_requested":"BASIC",'
    '"timestamp":"2026-01-01T00:00:00.000Z"}'
)
GOLDEN_MANIFEST_HASH = "eb250c5f73c5659896b1e177058c3a136042f8cd957996fcdadbb10d901bde57"

GOLDEN_ACTION_CANONICAL = (
    '{"action_type":"verify_external",'
    '"target":"UMBRA-ABC123",'
    '"context":null,'
    '"evidence_hash":null,'
    '"nonce":"cafef00dba5eba11",'
    '"timestamp":"2026-01-01T00:00:00.000Z"}'
)
GOLDEN_ACTION_SHA256 = "14e95552df66377f8a5634aa63c57b226865814cc1c72c0bcbeca01832113ba0"

# Golden: node -e "delegation-pass agentRequestDigest(...)" (lib/delegation-pass.js + certs.canonicalize)
GOLDEN_DELEGATION_DIGEST_HEX = (
    "aaebec5a0b38eaee69bd1abbe4605a865c47e888e6d955e7d8dc308e7beb85d2"
)


def _check(name: str, actual: Any, expected: Any) -> bool:
    ok = actual == expected
    marker = "OK " if ok else "FAIL"
    print(f"  [{marker}] {name}")
    if not ok:
        print(f"        expected: {expected!r}")
        print(f"        actual:   {actual!r}")
    return ok


def self_test() -> int:
    print("UMBRAXON Python client — self-test")
    all_ok = True

    # 1) Canonical manifest + hash
    canon = canonicalize_manifest(GOLDEN_MANIFEST)
    all_ok &= _check("canonical_manifest matches Node", canon, GOLDEN_MANIFEST_CANONICAL)
    all_ok &= _check("manifest_hash matches Node", manifest_hash(GOLDEN_MANIFEST), GOLDEN_MANIFEST_HASH)

    # 2) Action body canonical + sha256
    body = action_canonical_body(
        action_type="verify_external",
        target="UMBRA-ABC123",
        context=None,
        evidence_hash=None,
        nonce="cafef00dba5eba11",
        timestamp="2026-01-01T00:00:00.000Z",
    )
    all_ok &= _check("action canonical body matches Node", body, GOLDEN_ACTION_CANONICAL)
    all_ok &= _check(
        "action sha256 matches Node",
        hashlib.sha256(body.encode("utf-8")).hexdigest(),
        GOLDEN_ACTION_SHA256,
    )

    all_ok &= _check(
        "delegation_request_digest matches Node",
        delegation_request_digest(
            "UMBRA-ABCDEF",
            300,
            ["payment.max_satoshi:1000"],
            {"max_msat": 5000000},
            "abcdef0123456789abcdef0123456789",
            "2026-01-01T00:00:00.000Z",
        ).hex(),
        GOLDEN_DELEGATION_DIGEST_HEX,
    )

    # 5) PoW solver — solve a low-difficulty challenge and check the digest manually
    challenge = "00" * 32
    sol = solve_pow(challenge, difficulty=8, max_seconds=10.0)
    digest = hashlib.sha256(f"{challenge}:{sol['nonce']}".encode("ascii")).digest()
    all_ok &= _check("pow digest has >= 8 leading zero bits", has_leading_zero_bits(digest, 8), True)
    print(f"        pow nonce={sol['nonce']} iterations={sol['iterations']} hash_prefix={digest.hex()[:16]}")

    # 6) Ed25519 sign/verify roundtrip (only if PyNaCl present)
    if HAVE_NACL:
        seed = bytes(range(32))
        pub = derive_pubkey_hex(seed)
        msg = b"umbrexon self test"
        sig = sign_ed25519(seed, msg)
        all_ok &= _check("ed25519 sign+verify roundtrip", verify_ed25519(pub, msg, sig), True)
        # Tamper detection
        bad = bytearray(bytes.fromhex(sig))
        bad[0] ^= 0x01
        all_ok &= _check("ed25519 detects tampered signature", verify_ed25519(pub, msg, bad.hex()), False)
    else:
        print("  [SKIP] PyNaCl not installed — Ed25519 roundtrip skipped (pip install pynacl)")

    print("RESULT:", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


# ===========================================================================
# CLI
# ===========================================================================
def _parse_payment_hint(line: str) -> Dict[str, str]:
    if ":" not in line:
        raise ValueError("--payment-hint očakáva tvar typ:hodnota")
    typ, val = line.split(":", 1)
    typ, val = typ.strip(), val.strip()
    allowed = (
        "lightning_address",
        "lnurl_pay",
        "bolt12_offer",
        "https_pay_endpoint",
        "lightning_node_id",
    )
    if typ not in allowed:
        raise ValueError(f"typ musí byť jeden z {allowed}, dostal som {typ!r}")
    if not val:
        raise ValueError("prázdna hodnota payment-hint")
    return {"type": typ, "value": val}


def _parse_webhook_line(line: str) -> Dict[str, Any]:
    if "|" not in line:
        raise ValueError("--webhook očakáva tvar URL|event1,event2")
    url, ev = line.split("|", 1)
    events = [x.strip() for x in ev.split(",") if x.strip()]
    if not events:
        raise ValueError("aspoň jeden event v --webhook")
    return {"url": url.strip(), "events": events}


def _cmd_keygen(args: argparse.Namespace) -> int:
    _require_nacl()
    seed = generate_seed()
    pub = derive_pubkey_hex(seed)
    if args.out:
        save_seed(seed, args.out)
        print(f"private seed saved (32 B hex, chmod 0600): {args.out}")
    else:
        print(f"private_seed_hex={seed.hex()}")
    print(f"public_key_hex={pub}")
    return 0


def _cmd_register_v1(args: argparse.Namespace) -> int:
    _require_nacl()
    if not args.lightning_node_id:
        print("--lightning-node-id je povinné pre /api/v1/register", file=sys.stderr)
        return 2
    seed = load_seed(args.privkey_file, args.privkey_env)
    caps = args.capability or ["m2m_agent"]
    client = HubClient(
        base_url=args.base_url,
        connect_timeout=args.connect_timeout,
        read_timeout=args.read_timeout,
        admin_key=os.environ.get("UMBRAXON_ADMIN_KEY") or args.admin_key,
    )
    result = do_register_v1(
        client,
        seed,
        agent_name=args.name,
        version=args.version,
        capabilities=caps,
        tier=args.tier,
        lightning_node_id=args.lightning_node_id,
        discovery_opt_in=bool(args.discovery_opt_in),
        description=args.description,
        pow_max_seconds=args.pow_max_seconds,
        print_only=args.dry_run,
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if args.dry_run:
        return 0
    if result.get("status") and not (200 <= int(result["status"]) < 300):
        return 1

    reg_id = result.get("registration_id") or (result.get("response") or {}).get("registration_id")
    resp = result.get("response") or {}
    if reg_id:
        print(f"\n# Trace: registration_id={reg_id}", file=sys.stderr)
        print(f"# Poll: GET {args.base_url}/api/v1/register/status?registration_id={reg_id}", file=sys.stderr)

    bolt11 = resp.get("paymentRequest") or resp.get("payment_request")
    tier_total = (resp.get("tier") or {}).get("total")

    if args.auto_pay and bolt11:
        print("# auto-pay: NWC pay_invoice …", file=sys.stderr)
        pay_res = pay_bolt11_via_nwc(
            bolt11,
            expected_sats=int(tier_total) if tier_total else None,
            registration_id=reg_id,
            dry_run=bool(args.auto_pay_dry_run),
        )
        print(json.dumps({"auto_pay": pay_res}, indent=2), file=sys.stderr)
        if not pay_res.get("ok"):
            print("auto-pay FAILED — zaplaťte BOLT11 manuálne (nižšie)", file=sys.stderr)
            if bolt11:
                print(f"\n# Manual BOLT11 ({tier_total} sats):\n{bolt11}\n", file=sys.stderr)
            return 1 if not args.auto_pay_dry_run else 0
    elif bolt11:
        print(
            f"\n# Pay {tier_total or '?'} sats (BOLT11) — alebo použite --auto-pay:\n{bolt11}\n",
            file=sys.stderr,
        )

    if not args.wait_complete or not reg_id:
        return 0

    def _tick(st: Dict[str, Any]) -> None:
        print(
            f"[poll] status={st.get('status')} payment={st.get('payment_status')} kya_id={st.get('kya_id')}",
            file=sys.stderr,
        )

    try:
        final = poll_registration_until_done(client, reg_id, timeout_sec=args.wait_timeout, on_tick=_tick)
    except (TimeoutError, RuntimeError) as e:
        print(str(e), file=sys.stderr)
        return 1

    out: Dict[str, Any] = {"registration": final}
    if final.get("kya_id"):
        try:
            out["certificate"] = fetch_cert(client, final["kya_id"])
        except RuntimeError as e:
            out["cert_error"] = str(e)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


def _cmd_register(args: argparse.Namespace) -> int:
    _require_nacl()
    seed = load_seed(args.privkey_file, args.privkey_env)
    pub = derive_pubkey_hex(seed)
    try:
        payment_hints = [_parse_payment_hint(x) for x in (args.payment_hint or [])]
        dev_hooks = [_parse_webhook_line(x) for x in (args.webhook or [])]
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    manifest = build_manifest(
        name=args.name,
        version=args.version,
        pubkey_hex=pub,
        capabilities=args.capability,
        tier=args.tier,
        model=args.model,
        runtime=args.runtime,
        description=args.description,
        payment_hints=payment_hints or None,
        discovery_opt_in=bool(args.discovery_opt_in),
        developer_webhooks=dev_hooks or None,
    )
    client = HubClient(
        base_url=args.base_url,
        connect_timeout=args.connect_timeout,
        read_timeout=args.read_timeout,
        admin_key=os.environ.get("UMBRAXON_ADMIN_KEY") or args.admin_key,
    )
    result = do_register(client, seed, manifest, pow_max_seconds=args.pow_max_seconds, print_only=args.dry_run)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if args.dry_run:
        return 0
    return 0 if result.get("status") and 200 <= result["status"] < 300 else 1


def _cmd_delegation_pass(args: argparse.Namespace) -> int:
    _require_nacl()
    if not args.caveat:
        print("Chýba aspoň jeden --caveat", file=sys.stderr)
        return 2
    seed = load_seed(args.privkey_file, args.privkey_env)
    try:
        l402: Dict[str, Any] = json.loads(args.l402_json) if args.l402_json else {}
        if not isinstance(l402, dict):
            raise ValueError("--l402-json musí byť JSON objekt")
    except (json.JSONDecodeError, ValueError) as e:
        print(str(e), file=sys.stderr)
        return 2
    caveats = list(args.caveat)
    client = HubClient(
        base_url=args.base_url,
        connect_timeout=args.connect_timeout,
        read_timeout=args.read_timeout,
        admin_key=os.environ.get("UMBRAXON_ADMIN_KEY") or args.admin_key,
    )
    result = do_issue_delegation_pass(
        client,
        seed,
        args.kya_id.strip(),
        caveats,
        l402,
        ttl_seconds=args.ttl_seconds,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if args.dry_run:
        return 0
    st = result.get("status")
    return 0 if st is not None and 200 <= int(st) < 300 else 1


def _cmd_solve_pow(args: argparse.Namespace) -> int:
    client = HubClient(base_url=args.base_url, connect_timeout=args.connect_timeout, read_timeout=args.read_timeout)
    sol = fetch_and_solve_pow(client, purpose=args.purpose, difficulty=args.difficulty, max_seconds=args.max_seconds)
    print(json.dumps(sol, indent=2))
    return 0


def _cmd_action(args: argparse.Namespace) -> int:
    _require_nacl()
    seed = load_seed(args.privkey_file, args.privkey_env)
    context = json.loads(args.context_json) if args.context_json else None
    nonce = args.nonce or secrets.token_hex(16)
    timestamp = args.timestamp or time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    body_str, sig = sign_action_body(
        seed,
        action_type=args.action_type,
        target=args.target,
        context=context,
        evidence_hash=args.evidence_hash,
        nonce=nonce,
        timestamp=timestamp,
    )
    payload = json.loads(body_str)
    payload["signature"] = sig
    if args.dry_run:
        print(json.dumps({"canonical_body": body_str, "request_body": payload}, indent=2, ensure_ascii=False))
        return 0
    client = HubClient(
        base_url=args.base_url,
        connect_timeout=args.connect_timeout,
        read_timeout=args.read_timeout,
        admin_key=os.environ.get("UMBRAXON_ADMIN_KEY") or args.admin_key,
    )
    res = client.post(f"/api/agent/{args.kya_id}/action", payload)
    print(json.dumps({"status": res["status"], "response": res["json"]}, indent=2, ensure_ascii=False))
    return 0 if 200 <= int(res["status"]) < 300 else 1


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="UMBRAXON KYA-Hub Python referenčný klient (register, delegation-pass, action, PoW).",
    )
    sub = p.add_subparsers(dest="cmd", required=False)

    sub.add_parser("self-test", help="Spustí offline golden-vector self-test (žiadna sieť).")

    g = sub.add_parser("keygen", help="Vygeneruje nový Ed25519 keypair.")
    g.add_argument("--out", help="Cieľový súbor pre 32 B hex seed (chmod 0600). Inak vypíše na stdout.")

    r = sub.add_parser("register", help="Plný register flow: PoW + auth challenge + manifest signing + POST.")
    r.add_argument("--base-url", required=True)
    r.add_argument("--privkey-file", help="Súbor s 32 B Ed25519 seedom (raw alebo hex).")
    r.add_argument("--privkey-env", help="Env premenná s hex seedom (alternatíva k --privkey-file).")
    r.add_argument("--name", required=True)
    r.add_argument("--version", default="1.0.0")
    r.add_argument("--capability", action="append", default=[], help="Schopnosť — môže byť uvedené viackrát.")
    r.add_argument("--tier", choices=["BASIC", "ELITE"], required=True)
    r.add_argument("--model")
    r.add_argument("--runtime")
    r.add_argument("--description")
    r.add_argument("--connect-timeout", type=float, default=5.0)
    r.add_argument("--read-timeout", type=float, default=30.0)
    r.add_argument("--pow-max-seconds", type=float, default=60.0)
    r.add_argument("--admin-key", help="Voliteľný X-Admin-Key (testy/tooling). Inak env UMBRAXON_ADMIN_KEY.")
    r.add_argument("--dry-run", action="store_true", help="Nepošle request — vypíše pripravené body + manifest_hash.")
    r.add_argument(
        "--payment-hint",
        action="append",
        default=[],
        metavar="TYPE:VALUE",
        help="Verejný payment hint (opakovateľné): lightning_address, lnurl_pay, bolt12_offer, https_pay_endpoint.",
    )
    r.add_argument(
        "--discovery-opt-in",
        action="store_true",
        help="Zapne manifest.integrations.discovery_opt_in (verejný discovery feed).",
    )
    r.add_argument(
        "--webhook",
        action="append",
        default=[],
        metavar="URL|EVENTS",
        help="HTTPS developer webhook + udalosti oddelené čiarkou (opakovateľné).",
    )

    v1 = sub.add_parser(
        "register-v1",
        help="M2M POST /api/v1/register (kompaktné telo + voliteľný poll až po cert).",
    )
    v1.add_argument("--base-url", required=True)
    v1.add_argument("--privkey-file")
    v1.add_argument("--privkey-env")
    v1.add_argument("--name", required=True)
    v1.add_argument("--version", default="1.0.0")
    v1.add_argument("--capability", action="append", default=[])
    v1.add_argument("--tier", choices=["BASIC", "ELITE"], default="BASIC")
    v1.add_argument(
        "--lightning-node-id",
        required=True,
        help="66-char hex LN node pubkey alebo pubkey@host:port (manifest payment_hints).",
    )
    v1.add_argument("--description")
    v1.add_argument("--connect-timeout", type=float, default=5.0)
    v1.add_argument("--read-timeout", type=float, default=60.0)
    v1.add_argument("--pow-max-seconds", type=float, default=90.0)
    v1.add_argument("--admin-key")
    v1.add_argument("--dry-run", action="store_true")
    v1.add_argument("--discovery-opt-in", action="store_true")
    v1.add_argument(
        "--auto-pay",
        action="store_true",
        help="Po registrácii zaplať BOLT11 cez NWC (NWC_PAY_URI alebo ALBY_NWC_URI).",
    )
    v1.add_argument(
        "--auto-pay-dry-run",
        action="store_true",
        help="S --auto-pay: len skontroluj balance, neodosielaj platbu.",
    )
    v1.add_argument(
        "--wait-complete",
        action="store_true",
        help="Po vytvorení faktúry polluj /api/v1/register/status kým nie je kya_id + cert.",
    )
    v1.add_argument("--wait-timeout", type=float, default=900.0)

    sp = sub.add_parser("solve-pow", help="Stiahne PoW challenge a vyrieši ho (diagnostika).")
    sp.add_argument("--base-url", required=True)
    sp.add_argument("--purpose", default="pay", choices=["pay", "register", "challenge", "generic"])
    sp.add_argument("--difficulty", type=int, help="Override difficulty (server obvykle určí sám).")
    sp.add_argument("--max-seconds", type=float, default=60.0)
    sp.add_argument("--connect-timeout", type=float, default=5.0)
    sp.add_argument("--read-timeout", type=float, default=10.0)

    dp = sub.add_parser(
        "delegation-pass",
        help="Hub-issued KYADelegationPass (L402 claims + caveats; ne-kustodiálne).",
    )
    dp.add_argument("--base-url", required=True)
    dp.add_argument("--privkey-file")
    dp.add_argument("--privkey-env")
    dp.add_argument("--kya-id", required=True)
    dp.add_argument("--ttl-seconds", type=int, default=300)
    dp.add_argument(
        "--caveat",
        action="append",
        default=[],
        help="Caveat reťazec (opakovateľné; aspoň jeden). Napr. payment.max_satoshi:5000",
    )
    dp.add_argument("--l402-json", help="JSON objekt pre l402_claims (voliteľné).")
    dp.add_argument("--connect-timeout", type=float, default=5.0)
    dp.add_argument("--read-timeout", type=float, default=30.0)
    dp.add_argument("--admin-key", help="Voliteľný X-Admin-Key. Inak env UMBRAXON_ADMIN_KEY.")
    dp.add_argument("--dry-run", action="store_true", help="Nepošle request — vypíše digest + podpísaný payload.")

    a = sub.add_parser("action", help="Podpíše a (voliteľne) odošle action request.")
    a.add_argument("--base-url", required=True)
    a.add_argument("--kya-id", required=True)
    a.add_argument("--privkey-file")
    a.add_argument("--privkey-env")
    a.add_argument("--action-type", required=True)
    a.add_argument("--target")
    a.add_argument("--context-json", help="Voliteľný JSON s additional contextom.")
    a.add_argument("--evidence-hash")
    a.add_argument("--nonce", help="16-64 hex; defaultne sa vygeneruje.")
    a.add_argument("--timestamp", help="ISO 8601 UTC; defaultne aktuálny čas.")
    a.add_argument("--connect-timeout", type=float, default=5.0)
    a.add_argument("--read-timeout", type=float, default=20.0)
    a.add_argument("--admin-key")
    a.add_argument("--dry-run", action="store_true")

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.cmd:
        parser.print_help()
        return 0
    handlers = {
        "self-test": lambda a: self_test(),
        "keygen": _cmd_keygen,
        "register": _cmd_register,
        "register-v1": _cmd_register_v1,
        "delegation-pass": _cmd_delegation_pass,
        "solve-pow": _cmd_solve_pow,
        "action": _cmd_action,
    }
    return handlers[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
