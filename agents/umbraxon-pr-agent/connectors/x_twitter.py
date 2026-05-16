"""X (Twitter) API v2 — OAuth 1.0a user context tweet."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from connectors.base import SocialConnector


class XTwitterConnector(SocialConnector):
    name = "x"

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        access_token: str,
        access_token_secret: str,
    ) -> None:
        self.api_key = api_key.strip()
        self.api_secret = api_secret.strip()
        self.access_token = access_token.strip()
        self.access_token_secret = access_token_secret.strip()

    def authenticate(self) -> bool:
        return all([self.api_key, self.api_secret, self.access_token, self.access_token_secret])

    def publish(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.authenticate():
            return {"ok": False, "skipped": True, "reason": "X API credentials incomplete"}
        tweet = text[:280]
        url = "https://api.twitter.com/2/tweets"
        body = json.dumps({"text": tweet}).encode("utf-8")
        auth = self._oauth_header("POST", url)
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Authorization": auth,
                "Content-Type": "application/json",
                "User-Agent": "umbraxon-pr-agent/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                return {"ok": True, "response": json.loads(resp.read().decode("utf-8"))}
        except urllib.error.HTTPError as e:
            return {"ok": False, "http_status": e.code, "body": e.read().decode("utf-8", errors="replace")[:400]}

    def _oauth_header(self, method: str, url: str) -> str:
        oauth = {
            "oauth_consumer_key": self.api_key,
            "oauth_nonce": secrets.token_hex(16),
            "oauth_signature_method": "HMAC-SHA1",
            "oauth_timestamp": str(int(time.time())),
            "oauth_token": self.access_token,
            "oauth_version": "1.0",
        }
        base = "&".join(
            urllib.parse.quote(k, safe="") + "=" + urllib.parse.quote(v, safe="")
            for k, v in sorted(oauth.items())
        )
        sig_base = "&".join([
            method.upper(),
            urllib.parse.quote(url, safe=""),
            urllib.parse.quote(base, safe=""),
        ])
        key = f"{urllib.parse.quote(self.api_secret, safe='')}&{urllib.parse.quote(self.access_token_secret, safe='')}"
        sig = base64.b64encode(
            hmac.new(key.encode(), sig_base.encode(), hashlib.sha1).digest()
        ).decode()
        oauth["oauth_signature"] = sig
        header = "OAuth " + ", ".join(
            f'{urllib.parse.quote(k, safe="")}="{urllib.parse.quote(v, safe="")}"'
            for k, v in sorted(oauth.items())
        )
        return header
