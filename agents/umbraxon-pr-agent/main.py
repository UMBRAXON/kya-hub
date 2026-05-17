#!/usr/bin/env python3
"""Umbraxon PR & Marketing Agent — M2M registration + optional Moltbook publish."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO_SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
if str(_REPO_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_REPO_SCRIPTS))

import umbrexon_bot_client as ubc  # noqa: E402

from config import load_settings
from connectors.moltbook import MoltbookConnector
from hub.api_docs import fetch_hub_api_docs
from hub.register import fetch_and_save_certificate, register_v1, wait_until_registered
from logging_util import new_trace_logger
from pr.crosspost import crosspost
from pr.heartbeat import moltbook_heartbeat
from pr.promote import promote_hub
from pr.daily_post import run_daily_post
from pr.platform_post import run_platform_post
from pr.nostr_post import run_nostr_post
from pr.nostr_profile import publish_nostr_profile
from pr.run_cycle import run_cycle
from pr.moltbook_engage import run_moltbook_engage
from pr.support import draft_partnership_pitch, draft_support_reply
from reports.weekly import build_weekly_report, report_title
from leads.github import process_leads


def cmd_docs(_: argparse.Namespace) -> int:
    s = load_settings()
    print(fetch_hub_api_docs(s.kya_hub_base_url))
    return 0


def cmd_register(args: argparse.Namespace) -> int:
    s = load_settings()
    log_dir = getattr(args, "log_dir", None) or "logs"
    log = new_trace_logger(log_dir, prefix="pr-register")
    log.info("session_start", agent=s.kya_agent_name, hub=s.kya_hub_base_url, tier=s.kya_tier)

    seed = ubc.load_seed(s.kya_privkey_file, None)
    if args.keygen:
        seed = ubc.generate_seed()
        ubc.save_seed(seed, s.kya_privkey_file)
        log.info("keygen", path=s.kya_privkey_file, pubkey=ubc.derive_pubkey_hex(seed))

    init = register_v1(s, seed, log=log)
    print(json.dumps(init, indent=2, ensure_ascii=False))

    # Hub vystaví cert automaticky po platbe; bot musí poll + GET /api/cert a uložiť lokálne.
    do_wait = not args.no_wait and (args.wait_complete or s.kya_register_wait)
    reg_id = init.get("registration_id")

    if do_wait and reg_id:
        log.info("awaiting_payment_and_cert", registration_id=reg_id)
        if init.get("payment_request"):
            print("\n--- BOLT11 (pay BASIC tier) ---\n", init["payment_request"], "\n", file=sys.stderr)
        done = wait_until_registered(
            s, reg_id, log=log, timeout_sec=args.wait_timeout
        )
        print(json.dumps(done, indent=2, ensure_ascii=False))
        if done.get("cert_file"):
            print(f"\nCert saved: {done['cert_file']}\n", file=sys.stderr)
    elif reg_id:
        print(
            f"\nNext: pay invoice, then run\n"
            f"  python3 main.py fetch-cert --kya-id <KYA_ID>\n"
            f"  # or re-run: python3 main.py register  (poll + cert, KYA_REGISTER_WAIT=true)\n"
            f"  curl -fsS '{s.kya_hub_base_url}{init.get('status_poll_url', '')}'\n"
            f"Log file: {log.log_path}\n",
            file=sys.stderr,
        )
    return 0


def cmd_fetch_cert(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-cert")
    kya_id = (args.kya_id or s.kya_id or "").strip()
    if not kya_id and s.kya_registration_id.strip():
        import umbrexon_bot_client as ubc

        client = ubc.HubClient(s.kya_hub_base_url)
        st = ubc.fetch_registration_status(client, s.kya_registration_id.strip())
        kya_id = (st.get("kya_id") or "").strip()
    if not kya_id:
        raise SystemExit("KYA_ID required (arg --kya-id, env KYA_ID, or KYA_REGISTRATION_ID + completed reg)")

    out = fetch_and_save_certificate(
        s, kya_id, log=log, out_path=args.out or None
    )
    print(json.dumps({k: out[k] for k in ("kya_id", "cert_file", "serial", "agent_name", "tier")}, indent=2))
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    s = load_settings()
    cert_path = Path(s.kya_cert_file)
    if not cert_path.is_absolute():
        cert_path = Path(__file__).resolve().parent / cert_path
    cert_ok = cert_path.is_file()
    serial = kya_from_cert = None
    if cert_ok:
        try:
            data = json.loads(cert_path.read_text(encoding="utf-8"))
            serial = data.get("serial")
            subj = (data.get("certificate") or {}).get("credentialSubject") or {}
            kya_from_cert = subj.get("kya_id")
        except (OSError, json.JSONDecodeError):
            cert_ok = False
    mb = MoltbookConnector(s.moltbook_base_url, s.moltbook_api_key)
    mb_ok = mb.authenticate() if s.moltbook_api_key else False
    out = {
        "agent_name": s.kya_agent_name,
        "kya_id": s.kya_id or kya_from_cert,
        "registration_id": s.kya_registration_id,
        "hub": s.kya_hub_base_url,
        "tier": s.kya_tier,
        "certificate_file": str(cert_path),
        "certificate_present": cert_ok,
        "cert_serial": serial,
        "pr_dry_run": s.pr_dry_run,
        "llm_configured": bool(s.llm_api_key),
        "moltbook_api_key_set": bool(s.moltbook_api_key),
        "moltbook_authenticated": mb_ok,
        "ready_to_publish": cert_ok and bool(s.moltbook_api_key) and mb_ok and not s.pr_dry_run,
        "publish_platforms": list(s.pr_publish_platforms),
        "pr_min_hours_between_posts": s.pr_min_hours_between_posts,
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


def cmd_moltbook_register(args: argparse.Namespace) -> int:
    """Follow https://www.moltbook.com/skill.md — POST /api/v1/agents/register."""
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-moltbook-reg")
    mb = MoltbookConnector(s.moltbook_base_url, "")
    desc = (
        f"Official Umbraxon KYA Hub PR agent. KYA ID {s.kya_id or 'pending'}. "
        "M2M identity, Lightning registration, reputation & discovery."
    )
    resp = mb.register(s.kya_agent_name, desc)
    agent = resp.get("agent") or {}
    api_key = agent.get("api_key")
    if not api_key:
        print(json.dumps(resp, indent=2), file=sys.stderr)
        return 1
    log.info("moltbook_registered", profile=agent.get("profile_url"), status=resp.get("status"))
    claim_path = Path(__file__).resolve().parents[2] / "logs/pr-agent/MOLTBOOK-CLAIM.txt"
    claim_path.parent.mkdir(parents=True, exist_ok=True)
    claim_path.write_text(
        f"claim_url: {agent.get('claim_url')}\n"
        f"verification_code: {agent.get('verification_code')}\n"
        f"profile: {agent.get('profile_url')}\n"
        f"api_key: (set MOLTBOOK_API_KEY in .env — shown once in register JSON)\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "success": resp.get("success"),
        "claim_url": agent.get("claim_url"),
        "verification_code": agent.get("verification_code"),
        "profile_url": agent.get("profile_url"),
        "status": resp.get("status"),
        "tweet_template": resp.get("tweet_template"),
        "hint": "Save api_key to .env MOLTBOOK_API_KEY then: python3 main.py moltbook",
    }, indent=2))
    return 0


def cmd_moltbook(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-moltbook")
    if not s.moltbook_api_key:
        print(
            "MOLTBOOK_API_KEY nie je v .env.\n"
            "1) Na https://www.moltbook.com vytvor/registruj agenta (developers / claim flow).\n"
            "2) Skopíruj API kľúč (moltbook_...) do agents/umbraxon-pr-agent/.env\n"
            "3) Spusti znova: python3 main.py moltbook",
            file=sys.stderr,
        )
        return 2
    mb = MoltbookConnector(s.moltbook_base_url, s.moltbook_api_key)
    if not mb.authenticate():
        log.error("moltbook_auth_failed", base=s.moltbook_base_url)
        print("Moltbook auth FAILED — skontroluj MOLTBOOK_API_KEY a claim status.", file=sys.stderr)
        return 1
    log.info("moltbook_auth_ok")
    print(json.dumps({"ok": True, "base_url": s.moltbook_base_url}, indent=2))
    if args.identity_token:
        tok = mb.create_identity_token()
        print(json.dumps({"identity_token": tok, "hint": "1h TTL; pre overenie na hub použi X-Moltbook-Identity"}, indent=2))
    st = mb.claim_status()
    print(json.dumps({"claim_status": st}, indent=2))
    return 0


def cmd_promote(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-promote")
    text = promote_hub(s, audience=args.audience)
    if s.pr_hub_url_required and s.kya_hub_base_url not in text:
        text = f"{text}\n\n{ s.kya_hub_base_url }/README_API.md"
    log.info("promote_generated", chars=len(text))
    print(text)
    if args.publish:
        plat = [p.strip() for p in (args.platforms or "").split(",") if p.strip()] or None
        out = crosspost(
            s, text, title="Umbraxon KYA Hub — M2M agents", platforms=plat, dry_run=s.pr_dry_run
        )
        log.info("crosspost", result=out)
        print(json.dumps(out, indent=2, ensure_ascii=False), file=sys.stderr)
        if s.pr_dry_run:
            print("[PR_DRY_RUN=true — publish simulated]", file=sys.stderr)
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-report")
    text = build_weekly_report(s)
    log.info("weekly_report", chars=len(text))
    print(text)
    if args.publish:
        out = crosspost(s, text, title=report_title(), dry_run=s.pr_dry_run)
        log.info("report_publish", result=out)
        print(json.dumps(out, indent=2), file=sys.stderr)
    return 0


def cmd_github_scan(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-github")
    out = process_leads(s)
    log.info("github_scan", leads=len((out.get("actions") or [])))
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if out.get("ok") else 1


def cmd_platform_post(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-platform")
    out = run_platform_post(s)
    log.info("platform_post", publish_ok=(out.get("publish") or {}).get("ok"))
    print(json.dumps(out, indent=2, ensure_ascii=False)[:8000])
    pub = out.get("publish") or {}
    return 0 if pub.get("ok") else 1


def cmd_daily_post(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-daily")
    out = run_daily_post(s)
    log.info("daily_post", theme=out.get("theme_id"), publish_ok=(out.get("publish") or {}).get("ok"))
    print(json.dumps(out, indent=2, ensure_ascii=False)[:8000])
    pub = out.get("publish") or {}
    if pub.get("ok"):
        return 0
    reasons = pub.get("reasons") or []
    if pub.get("blocked") and any("cadence" in str(r) for r in reasons):
        return 0
    return 1


def cmd_nostr_post(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-nostr")
    out = run_nostr_post(s)
    log.info("nostr_post", theme=out.get("theme_id"), publish_ok=(out.get("publish") or {}).get("ok"))
    print(json.dumps(out, indent=2, ensure_ascii=False)[:8000])
    pub = out.get("publish") or {}
    if pub.get("ok"):
        return 0
    reasons = pub.get("reasons") or []
    if pub.get("blocked") and any("cadence" in str(r) for r in reasons):
        return 0
    return 1


def cmd_nostr_profile(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-nostr-profile")
    out = publish_nostr_profile(s, dry_run=getattr(args, "dry_run", False))
    log.info("nostr_profile", ok=out.get("ok"))
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if out.get("ok") else 1


def cmd_run_cycle(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-cycle")
    out = run_cycle(
        s,
        skip_github=not getattr(args, "with_github", False),
        publish=not args.no_publish,
    )
    log.info("run_cycle_done", steps=list(out.get("steps", {}).keys()))
    print(json.dumps(out, indent=2, ensure_ascii=False)[:12000])
    return 0


def cmd_heartbeat(_: argparse.Namespace) -> int:
    s = load_settings()
    print(json.dumps(moltbook_heartbeat(s), indent=2, default=str))
    return 0


def cmd_moltbook_engage(args: argparse.Namespace) -> int:
    s = load_settings()
    log = new_trace_logger(getattr(args, "log_dir", None) or "logs", prefix="pr-engage")
    out = run_moltbook_engage(s)
    log.info("moltbook_engage", posted=out.get("posted"), skipped=out.get("skipped"))
    print(json.dumps(out, indent=2, ensure_ascii=False)[:12000])
    return 0 if out.get("ok") else 1


def cmd_support(args: argparse.Namespace) -> int:
    s = load_settings()
    if args.partnership:
        print(draft_partnership_pitch(s, args.context))
    else:
        q = args.question or "How do I register my autonomous agent on KYA Hub?"
        print(draft_support_reply(s, q))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Umbraxon PR agent (UMBRAXON-PR-AMBASSADOR)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("docs", help="Print KYA Hub API documentation").set_defaults(func=cmd_docs)
    sub.add_parser("status", help="Operator checklist: KYA cert + Moltbook + publish readiness").set_defaults(
        func=cmd_status
    )

    sub.add_parser(
        "moltbook-register",
        help="Register new agent on Moltbook (skill.md); api_key shown once",
    ).set_defaults(func=cmd_moltbook_register)

    mb = sub.add_parser("moltbook", help="Test Moltbook API key / claim status")
    mb.add_argument("--log-dir", default="logs")
    mb.add_argument("--identity-token", action="store_true", help="POST /api/v1/agents/me/identity-token")
    mb.set_defaults(func=cmd_moltbook)

    r = sub.add_parser("register", help="POST /api/v1/register + optional wait")
    r.add_argument("--log-dir", default="logs", help="JSONL trace logs directory")
    r.add_argument("--keygen", action="store_true", help="Generate bot.key before register")
    r.add_argument(
        "--wait-complete",
        action="store_true",
        help="Poll until paid + cert issued and save locally (default: KYA_REGISTER_WAIT)",
    )
    r.add_argument(
        "--no-wait",
        action="store_true",
        help="Stop after invoice; do not poll or download cert",
    )
    r.add_argument("--wait-timeout", type=float, default=900.0)
    r.set_defaults(func=cmd_register)

    c = sub.add_parser("fetch-cert", help="Download KYA cert from hub and save locally")
    c.add_argument("--log-dir", default="logs", help="JSONL trace logs directory")
    c.add_argument("--kya-id", default=None, help="KYA ID (default: KYA_ID env)")
    c.add_argument("--out", default=None, help="Output path (default: KYA_CERT_FILE)")
    c.set_defaults(func=cmd_fetch_cert)

    pr = sub.add_parser("promote", help="Generate PR post + optional cross-post")
    pr.add_argument("--log-dir", default="logs", help="JSONL trace logs directory")
    pr.add_argument("--audience", default="m2m_developers")
    pr.add_argument("--publish", action="store_true")
    pr.add_argument("--platforms", default="", help="Comma list override PR_PUBLISH_PLATFORMS")
    pr.set_defaults(func=cmd_promote)

    rp = sub.add_parser("report", help="Weekly hub metrics report (Phase C)")
    rp.add_argument("--log-dir", default="logs")
    rp.add_argument("--publish", action="store_true")
    rp.set_defaults(func=cmd_report)

    gh = sub.add_parser("github-scan", help="Scan GitHub for AI-agent repos (Phase D)")
    gh.add_argument("--log-dir", default="logs")
    gh.set_defaults(func=cmd_github_scan)

    pp = sub.add_parser(
        "platform-post",
        help="One-shot Moltbook post — Platform Integrator API (plug-in layer)",
    )
    pp.add_argument("--log-dir", default="logs")
    pp.set_defaults(func=cmd_platform_post)

    dp = sub.add_parser("daily-post", help="Themed daily Moltbook post (cron)")
    dp.add_argument("--log-dir", default="logs")
    dp.set_defaults(func=cmd_daily_post)

    np = sub.add_parser("nostr-post", help="Themed Nostr note (Mon/Wed/Fri cron)")
    np.add_argument("--log-dir", default="logs")
    np.set_defaults(func=cmd_nostr_post)

    nprof = sub.add_parser("nostr-profile", help="Publish kind-0 profile metadata to relays")
    nprof.add_argument("--log-dir", default="logs")
    nprof.add_argument("--dry-run", action="store_true")
    nprof.set_defaults(func=cmd_nostr_profile)

    cy = sub.add_parser("run-cycle", help="Heartbeat + daily post (+ optional GitHub leads)")
    cy.add_argument("--log-dir", default="logs")
    cy.add_argument("--with-github", action="store_true", help="Include github-scan leads")
    cy.add_argument("--no-publish", action="store_true")
    cy.set_defaults(func=cmd_run_cycle)

    sub.add_parser("heartbeat", help="Moltbook heartbeat + claim status").set_defaults(func=cmd_heartbeat)

    eng = sub.add_parser("moltbook-engage", help="Reply on own posts + relevant feed (LLM)")
    eng.add_argument("--log-dir", default="logs")
    eng.set_defaults(func=cmd_moltbook_engage)

    sup = sub.add_parser("support", help="Draft dev support or partnership reply (LLM)")
    sup.add_argument("--question", default="")
    sup.add_argument("--partnership", action="store_true")
    sup.add_argument("--context", default="")
    sup.set_defaults(func=cmd_support)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
