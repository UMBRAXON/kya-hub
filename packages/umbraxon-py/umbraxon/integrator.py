"""Convenience helpers for plug-in gate checks."""

from __future__ import annotations

from typing import Any, Dict, Optional

from umbraxon.client import UmbraxonIntegratorClient


def verify_agent(
    base_url: str,
    kya_id: str,
    *,
    api_key: Optional[str] = None,
    lsat_token: Optional[str] = None,
) -> Dict[str, Any]:
    """Full integrator view for *kya_id* (same as GET /api/v1/agents/:id)."""
    client = UmbraxonIntegratorClient(base_url, api_key=api_key, lsat_token=lsat_token)
    return client.get_agent(kya_id)


def agent_status(
    base_url: str,
    kya_id: str,
    *,
    api_key: Optional[str] = None,
    lsat_token: Optional[str] = None,
) -> bool:
    """Return True when hub reports trust.verified for the agent."""
    client = UmbraxonIntegratorClient(base_url, api_key=api_key, lsat_token=lsat_token)
    return client.is_verified(kya_id)
