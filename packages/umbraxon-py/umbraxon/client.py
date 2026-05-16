"""HTTP clients for KYA Hub — agent ops and integrator read API."""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from umbraxon._ubc import load_umbrexon_bot_client


class UmbraxonClient:
    """Agent-facing client (registration, actions). Wraps scripts/umbrexon_bot_client.HubClient."""

    def __init__(self, base_url: str, **kwargs: Any) -> None:
        ubc = load_umbrexon_bot_client()
        self._hub = ubc.HubClient(base_url, **kwargs)

    @property
    def hub(self):
        return self._hub

    def register_v1(self, **kwargs: Any) -> Dict[str, Any]:
        ubc = load_umbrexon_bot_client()
        return ubc.do_register_v1(self._hub, **kwargs)


class UmbraxonIntegratorClient:
    """Integrator read API + optional LSAT day-pass purchase."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        lsat_token: Optional[str] = None,
        *,
        timeout: float = 20.0,
        user_agent: str = "umbraxon-sdk/0.1.0",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._bearer = api_key or lsat_token
        self.timeout = timeout
        self.user_agent = user_agent

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = None
        headers = {
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if self._bearer:
            headers["Authorization"] = f"Bearer {self._bearer}"
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = raw
            return {
                "status": resp.status,
                "json": parsed,
            }

    def get_agent(self, kya_id: str) -> Dict[str, Any]:
        r = self._request("GET", f"/api/v1/agents/{urllib.parse.quote(kya_id, safe='')}")
        if r["status"] != 200:
            raise RuntimeError(f"get_agent failed: HTTP {r['status']} {r['json']}")
        return r["json"]

    def get_agent_status(self, kya_id: str) -> Dict[str, Any]:
        r = self._request(
            "GET",
            f"/api/v1/agents/{urllib.parse.quote(kya_id, safe='')}/status",
        )
        if r["status"] != 200:
            raise RuntimeError(f"get_agent_status failed: HTTP {r['status']} {r['json']}")
        return r["json"]

    def is_verified(self, kya_id: str) -> bool:
        body = self.get_agent_status(kya_id)
        trust = body.get("trust") or {}
        return bool(trust.get("verified"))

    def create_lsat_invoice(self) -> Dict[str, Any]:
        r = self._request("POST", "/api/v1/integrator/lsat/invoice", body={})
        if r["status"] not in (200, 201):
            raise RuntimeError(f"create_lsat_invoice failed: HTTP {r['status']} {r['json']}")
        return r["json"]

    def lsat_status(self, access_id: str) -> Dict[str, Any]:
        q = urllib.parse.urlencode({"access_id": access_id})
        r = self._request("GET", f"/api/v1/integrator/lsat/status?{q}")
        if r["status"] != 200:
            raise RuntimeError(f"lsat_status failed: HTTP {r['status']} {r['json']}")
        return r["json"]

    def redeem_lsat(self, access_id: str) -> Dict[str, Any]:
        r = self._request("POST", "/api/v1/integrator/lsat/redeem", body={"access_id": access_id})
        if r["status"] != 200:
            raise RuntimeError(f"redeem_lsat failed: HTTP {r['status']} {r['json']}")
        token = r["json"].get("lsat_token")
        if token:
            self._bearer = token
        return r["json"]
