"""Base connector for external platforms (X, Nostr, GitHub, …)."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional


class SocialConnector(ABC):
    name: str = "base"

    @abstractmethod
    def authenticate(self) -> bool:
        """Validate credentials; return True if ready."""

    @abstractmethod
    def publish(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Publish content; return platform-specific result."""
