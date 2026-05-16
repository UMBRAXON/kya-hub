"""Moltbook API bridge — identity token + optional post stub."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

from connectors.base import SocialConnector


class MoltbookConnector(SocialConnector):
    name = "moltbook"

    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key.strip()

    def authenticate(self) -> bool:
        if not self.api_key:
            return False
        try:
            self._request("GET", "/api/v1/agents/me", None)
            return True
        except OSError:
            return False

    def create_identity_token(self) -> str:
        data = self._request("POST", "/api/v1/agents/me/identity-token", {})
        return str(data.get("token") or data.get("identity_token") or "")

    def register(
        self,
        name: str,
        description: str,
    ) -> Dict[str, Any]:
        """POST /api/v1/agents/register — returns api_key + claim_url (save immediately)."""
        return self._request(
            "POST",
            "/api/v1/agents/register",
            {"name": name, "description": description[:2000]},
            auth=False,
        )

    def claim_status(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/agents/status", None)

    def setup_owner_email(self, email: str) -> Dict[str, Any]:
        """POST /api/v1/agents/me/setup-owner-email — link owner inbox for claim/notifications."""
        return self._request(
            "POST",
            "/api/v1/agents/me/setup-owner-email",
            {"email": email.strip()},
        )

    def get_home(self) -> Dict[str, Any]:
        return self._request("GET", "/api/v1/home", None)

    def get_feed(self, *, limit: int = 25, sort: str = "hot") -> Dict[str, Any]:
        q = f"/api/v1/feed?sort={sort}&limit={max(1, min(limit, 50))}"
        return self._request("GET", q, None)

    def get_post(self, post_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/api/v1/posts/{post_id}", None)

    def list_comments(
        self,
        post_id: str,
        *,
        sort: str = "new",
        limit: int = 30,
    ) -> Dict[str, Any]:
        q = f"/api/v1/posts/{post_id}/comments?sort={sort}&limit={max(1, min(limit, 50))}"
        return self._request("GET", q, None)

    def create_comment(
        self,
        post_id: str,
        content: str,
        *,
        parent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"content": (content or "").strip()[:8000]}
        if parent_id:
            payload["parent_id"] = parent_id
        try:
            return self._request("POST", f"/api/v1/posts/{post_id}/comments", payload)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:500]
            return {"ok": False, "http_status": e.code, "body": err_body}

    def mark_post_notifications_read(self, post_id: str) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"/api/v1/notifications/read-by-post/{post_id}",
            {},
        )

    def publish(
        self,
        text: str,
        metadata: Optional[Dict[str, Any]] = None,
        *,
        title: Optional[str] = None,
        submolt_name: str = "general",
    ) -> Dict[str, Any]:
        """Post to Moltbook (skill.md: submolt_name + title required)."""
        if not self.api_key:
            return {"ok": False, "error": "MOLTBOOK_API_KEY missing"}
        body = (text or "").strip()
        post_title = (title or body.split("\n", 1)[0][:300] or "KYA Hub update").strip()
        payload: Dict[str, Any] = {
            "submolt_name": submolt_name,
            "title": post_title[:300],
            "content": body[:40000],
            "type": "text",
        }
        try:
            out = self._request("POST", "/api/v1/posts", payload)
            post = out.get("post") or out
            ver = post.get("verification") if isinstance(post, dict) else None
            vstat = post.get("verification_status") or post.get("verificationStatus")
            if ver and vstat == "pending":
                from pr.moltbook_verify import verify_post
                from config import load_settings

                vr = verify_post(load_settings(), ver, api_key=self.api_key)
                out["verification_result"] = vr
            return out
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:500]
            return {"ok": False, "http_status": e.code, "body": err_body}

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]],
        *,
        auth: bool = True,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = None
        headers = {
            "Accept": "application/json",
            "User-Agent": "umbraxon-pr-agent/1.0",
        }
        if auth:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
