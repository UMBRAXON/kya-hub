"""Environment-backed configuration for Umbraxon PR agent."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

_ENV_LOADED = False


def _ensure_env() -> None:
    global _ENV_LOADED
    if _ENV_LOADED:
        return
    root = Path(__file__).resolve().parent
    load_dotenv(root / ".env", override=False)
    _ENV_LOADED = True


def _bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() in ("1", "true", "yes")


def _csv(name: str, default: str = "") -> tuple[str, ...]:
    raw = os.getenv(name, default)
    return tuple(x.strip() for x in raw.split(",") if x.strip())


def _read_secret_file(path: str) -> str:
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = Path(__file__).resolve().parent / p
    if not p.is_file():
        return ""
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return line
    return ""


def _llm_api_key() -> str:
    direct = os.getenv("LLM_API_KEY", "").strip()
    if direct:
        return direct
    file_path = os.getenv("LLM_API_KEY_FILE", "").strip()
    if file_path:
        return _read_secret_file(file_path)
    return os.getenv("OPENAI_API_KEY", "").strip()


def _nostr_private_key() -> str:
    direct = os.getenv("NOSTR_PRIVATE_KEY", os.getenv("NOSTR_nsec", "")).strip()
    if direct:
        return direct
    file_path = os.getenv("NOSTR_PRIVATE_KEY_FILE", "").strip()
    if file_path:
        return _read_secret_file(file_path)
    return ""


@dataclass(frozen=True)
class Settings:
    kya_hub_base_url: str
    kya_agent_name: str
    kya_agent_version: str
    kya_tier: str
    kya_privkey_file: str
    kya_lightning_node_id: str
    kya_capabilities: tuple[str, ...]

    llm_provider: str
    llm_api_key: str
    llm_model: str
    llm_base_url: str | None

    moltbook_api_key: str
    moltbook_base_url: str

    pr_dry_run: bool
    pr_max_posts_per_run: int
    pr_min_hours_between_posts: float
    pr_min_content_chars: int
    pr_max_links_per_post: int
    pr_hub_url_required: bool
    pr_publish_platforms: tuple[str, ...]

    auto_pay_registration: bool
    nwc_pay_uri_file: str

    kya_id: str
    kya_cert_file: str
    kya_registration_id: str
    kya_register_wait: bool
    kya_admin_api_key: str

    # Phase B — cross-post
    nostr_private_key: str
    nostr_relays: tuple[str, ...]
    nostr_min_hours_between_posts: float
    x_api_key: str
    x_api_secret: str
    x_access_token: str
    x_access_token_secret: str
    discord_webhook_url: str
    telegram_bot_token: str
    telegram_notify_chat_id: str
    telegram_monitor_keywords: tuple[str, ...]
    telegram_auto_reply: bool

    # Phase D — GitHub leads
    github_token: str
    github_search_query: str
    github_max_leads_per_run: int
    github_outreach_dry_run: bool

    # Phase C — reports
    report_auto_publish: bool

    # Moltbook engagement (comments / feed)
    moltbook_auto_reply: bool
    moltbook_reply_language: str
    pr_post_language: str
    moltbook_max_replies_per_run: int
    moltbook_min_hours_between_comments: float
    moltbook_feed_scan_limit: int
    moltbook_reply_on_own_posts: bool
    moltbook_reply_on_feed: bool
    moltbook_feed_keywords: tuple[str, ...]
    moltbook_min_comment_chars: int
    moltbook_agent_name: str


def load_settings() -> Settings:
    _ensure_env()
    caps = os.getenv("KYA_CAPABILITIES", "pr_marketing,m2m_outreach,hub_promotion")
    platforms = _csv("PR_PUBLISH_PLATFORMS", "moltbook")
    if not platforms:
        platforms = ("moltbook",)
    return Settings(
        kya_hub_base_url=os.getenv("KYA_HUB_BASE_URL", "https://www.umbraxon.xyz").rstrip("/"),
        kya_agent_name=os.getenv("KYA_AGENT_NAME", "UMBRAXON-PR-AMBASSADOR"),
        kya_agent_version=os.getenv("KYA_AGENT_VERSION", "1.0.0"),
        kya_tier=os.getenv("KYA_TIER", "BASIC").upper(),
        kya_privkey_file=os.getenv("KYA_PRIVKEY_FILE", "./secrets/bot.key"),
        kya_lightning_node_id=os.getenv("KYA_LIGHTNING_NODE_ID", ""),
        kya_capabilities=tuple(c.strip() for c in caps.split(",") if c.strip()),
        llm_provider=os.getenv("LLM_PROVIDER", "openai"),
        llm_api_key=_llm_api_key(),
        llm_model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        llm_base_url=os.getenv("LLM_BASE_URL") or None,
        moltbook_api_key=os.getenv("MOLTBOOK_API_KEY", ""),
        moltbook_base_url=os.getenv("MOLTBOOK_BASE_URL", "https://www.moltbook.com").rstrip("/"),
        pr_dry_run=_bool("PR_DRY_RUN", "true"),
        pr_max_posts_per_run=int(os.getenv("PR_MAX_POSTS_PER_RUN", "1")),
        pr_min_hours_between_posts=float(os.getenv("PR_MIN_HOURS_BETWEEN_POSTS", "24")),
        pr_min_content_chars=int(os.getenv("PR_MIN_CONTENT_CHARS", "80")),
        pr_max_links_per_post=int(os.getenv("PR_MAX_LINKS_PER_POST", "3")),
        pr_hub_url_required=_bool("PR_HUB_URL_REQUIRED", "true"),
        pr_publish_platforms=platforms,
        auto_pay_registration=_bool("AUTO_PAY_REGISTRATION", "false"),
        nwc_pay_uri_file=os.getenv("NWC_PAY_URI_FILE", ""),
        kya_id=os.getenv("KYA_ID", ""),
        kya_cert_file=os.getenv("KYA_CERT_FILE", "./secrets/certificate.json"),
        kya_registration_id=os.getenv("KYA_REGISTRATION_ID", ""),
        kya_register_wait=_bool("KYA_REGISTER_WAIT", "true"),
        kya_admin_api_key=os.getenv("KYA_ADMIN_API_KEY", os.getenv("ADMIN_API_KEY", "")),
        nostr_private_key=_nostr_private_key(),
        nostr_relays=_csv(
            "NOSTR_RELAYS",
            "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band",
        ),
        nostr_min_hours_between_posts=float(
            os.getenv("NOSTR_MIN_HOURS_BETWEEN_POSTS", "48")
        ),
        x_api_key=os.getenv("X_API_KEY", os.getenv("TWITTER_API_KEY", "")),
        x_api_secret=os.getenv("X_API_SECRET", os.getenv("TWITTER_API_SECRET", "")),
        x_access_token=os.getenv("X_ACCESS_TOKEN", os.getenv("TWITTER_ACCESS_TOKEN", "")),
        x_access_token_secret=os.getenv(
            "X_ACCESS_TOKEN_SECRET", os.getenv("TWITTER_ACCESS_TOKEN_SECRET", "")
        ),
        discord_webhook_url=os.getenv("DISCORD_WEBHOOK_URL", ""),
        telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", os.getenv("PR_TELEGRAM_BOT_TOKEN", "")),
        telegram_notify_chat_id=os.getenv("TELEGRAM_NOTIFY_CHAT_ID", ""),
        telegram_monitor_keywords=_csv(
            "TELEGRAM_MONITOR_KEYWORDS",
            "agent identity,m2m payments,lightning agent,kya hub",
        ),
        telegram_auto_reply=_bool("TELEGRAM_AUTO_REPLY", "false"),
        github_token=os.getenv("GITHUB_TOKEN", ""),
        github_search_query=os.getenv(
            "GITHUB_SEARCH_QUERY",
            "ai agent autonomous language:python stars:>5",
        ),
        github_max_leads_per_run=int(os.getenv("GITHUB_MAX_LEADS_PER_RUN", "3")),
        github_outreach_dry_run=_bool("GITHUB_OUTREACH_DRY_RUN", "true"),
        report_auto_publish=_bool("REPORT_AUTO_PUBLISH", "false"),
        moltbook_auto_reply=_bool("MOLTBOOK_AUTO_REPLY", "false"),
        moltbook_reply_language=os.getenv("MOLTBOOK_REPLY_LANGUAGE", "en").strip().lower(),
        pr_post_language=os.getenv("PR_POST_LANGUAGE", "en").strip().lower(),
        moltbook_max_replies_per_run=int(os.getenv("MOLTBOOK_MAX_REPLIES_PER_RUN", "3")),
        moltbook_min_hours_between_comments=float(
            os.getenv("MOLTBOOK_MIN_HOURS_BETWEEN_COMMENTS", "2")
        ),
        moltbook_feed_scan_limit=int(os.getenv("MOLTBOOK_FEED_SCAN_LIMIT", "25")),
        moltbook_reply_on_own_posts=_bool("MOLTBOOK_REPLY_ON_OWN_POSTS", "true"),
        moltbook_reply_on_feed=_bool("MOLTBOOK_REPLY_ON_FEED", "true"),
        moltbook_feed_keywords=_csv(
            "MOLTBOOK_FEED_KEYWORDS",
            "agent identity,m2m,autonomous agent,lightning agent,kya,agent registry,"
            "machine-to-machine,ed25519,nwc,wallet connect,agent hub",
        ),
        moltbook_min_comment_chars=int(os.getenv("MOLTBOOK_MIN_COMMENT_CHARS", "40")),
        moltbook_agent_name=os.getenv("MOLTBOOK_AGENT_NAME", "umbraxon-pr-ambassador"),
    )
