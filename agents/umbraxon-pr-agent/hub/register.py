"""Autonomous registration via POST /api/v1/register + status polling."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Union

_REPO_SCRIPTS = Path(__file__).resolve().parents[3] / "scripts"
if str(_REPO_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_REPO_SCRIPTS))

import umbrexon_bot_client as ubc  # noqa: E402

from config import Settings
from logging_util import TraceLogger


def register_v1(
    settings: Settings,
    seed: bytes,
    log: Optional[TraceLogger] = None,
) -> Dict[str, Any]:
    if not settings.kya_lightning_node_id.strip():
        raise ValueError("KYA_LIGHTNING_NODE_ID is required for M2M registration")

    client = ubc.HubClient(settings.kya_hub_base_url)
    if log:
        log.info("register_v1_start", agent=settings.kya_agent_name, tier=settings.kya_tier)

    result = ubc.do_register_v1(
        client,
        seed,
        agent_name=settings.kya_agent_name,
        version=settings.kya_agent_version,
        capabilities=list(settings.kya_capabilities),
        tier=settings.kya_tier,
        lightning_node_id=settings.kya_lightning_node_id.strip(),
        discovery_opt_in=True,
        description="Official Umbraxon KYA Hub PR & technical outreach agent.",
        pow_max_seconds=120.0,
    )

    status_code = result.get("status")
    resp = result.get("response") or {}
    reg_id = result.get("registration_id") or resp.get("registration_id")

    if log:
        log.info(
            "register_v1_response",
            http_status=status_code,
            registration_id=reg_id,
            invoice_id=resp.get("invoiceId"),
            amount_sats=(resp.get("tier") or {}).get("total"),
            payment_request_prefix=(resp.get("paymentRequest") or "")[:32],
        )

    if status_code is None or not (200 <= int(status_code) < 300):
        raise RuntimeError(f"register failed HTTP {status_code}: {resp}")

    auto_pay_result = None
    bolt11 = resp.get("paymentRequest") or resp.get("payment_request")
    tier_total = (resp.get("tier") or {}).get("total")
    if settings.auto_pay_registration and bolt11:
        if log:
            log.info("auto_pay_start", registration_id=reg_id, expected_sats=tier_total)
        auto_pay_result = ubc.pay_bolt11_via_nwc(
            bolt11,
            expected_sats=int(tier_total) if tier_total else None,
            registration_id=reg_id,
        )
        if log:
            log.info("auto_pay_done", result=auto_pay_result)
        if not auto_pay_result.get("ok"):
            raise RuntimeError(f"auto-pay failed: {auto_pay_result}")

    return {
        "registration_id": reg_id,
        "invoice_id": resp.get("invoiceId"),
        "payment_request": resp.get("paymentRequest"),
        "checkout_link": resp.get("checkoutLink"),
        "tier": resp.get("tier"),
        "status_poll_url": resp.get("status_poll_url")
        or f"/api/v1/register/status?registration_id={reg_id}",
        "manifest_hash": result.get("manifest_hash"),
        "auto_pay": auto_pay_result,
    }


def wait_until_registered(
    settings: Settings,
    registration_id: str,
    log: Optional[TraceLogger] = None,
    timeout_sec: float = 900.0,
) -> Dict[str, Any]:
    client = ubc.HubClient(settings.kya_hub_base_url)

    def on_tick(st: Dict[str, Any]) -> None:
        if log:
            log.info(
                "register_poll_tick",
                registration_id=registration_id,
                status=st.get("status"),
                payment_status=st.get("payment_status"),
                kya_id=st.get("kya_id"),
            )

    final = ubc.poll_registration_until_done(
        client,
        registration_id,
        timeout_sec=timeout_sec,
        interval_sec=4.0,
        on_tick=on_tick,
    )
    if log:
        log.info("register_completed", kya_id=final.get("kya_id"), cert_url=final.get("cert_url"))

    cert = None
    kya_id = final.get("kya_id")
    if kya_id:
        try:
            cert = ubc.fetch_cert(client, kya_id)
            if log:
                log.info("cert_fetched", kya_id=kya_id, serial=(cert or {}).get("serial"))
        except RuntimeError as e:
            if log:
                log.error("cert_fetch_failed", kya_id=kya_id, error=str(e))
            raise

    out: Dict[str, Any] = {"status": final, "certificate": cert}
    if cert:
        out["cert_file"] = save_certificate_file(cert, settings.kya_cert_file)
        out["kya_id"] = kya_id
        out["serial"] = cert.get("serial")
        _persist_agent_env(settings, kya_id=kya_id, registration_id=registration_id)
    return out


def _persist_agent_env(
    settings: Settings,
    *,
    kya_id: Optional[str] = None,
    registration_id: Optional[str] = None,
) -> None:
    """Best-effort update agents/umbraxon-pr-agent/.env after successful cert save."""
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.is_file():
        return
    keys: Dict[str, str] = {}
    if kya_id:
        keys["KYA_ID"] = kya_id
    if registration_id:
        keys["KYA_REGISTRATION_ID"] = registration_id
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
        out_lines = []
        seen = set()
        for line in lines:
            replaced = False
            for k, v in keys.items():
                if line.startswith(f"{k}="):
                    out_lines.append(f"{k}={v}")
                    seen.add(k)
                    replaced = True
                    break
            if not replaced:
                out_lines.append(line)
        for k, v in keys.items():
            if k not in seen:
                out_lines.append(f"{k}={v}")
        env_path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    except OSError:
        pass


def save_certificate_file(cert: Dict[str, Any], out_path: Union[str, Path]) -> str:
    """Write hub cert JSON to disk (mode 0600). Returns absolute path."""
    path = Path(out_path).expanduser()
    if not path.is_absolute():
        path = (Path(__file__).resolve().parents[1] / path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cert, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)
    return str(path)


def fetch_and_save_certificate(
    settings: Settings,
    kya_id: str,
    log: Optional[TraceLogger] = None,
    *,
    out_path: Optional[Union[str, Path]] = None,
) -> Dict[str, Any]:
    client = ubc.HubClient(settings.kya_hub_base_url)
    cert = ubc.fetch_cert(client, kya_id.strip())
    dest = save_certificate_file(cert, out_path or settings.kya_cert_file)
    if log:
        log.info("cert_saved", kya_id=kya_id, path=dest, serial=cert.get("serial"))
    _persist_agent_env(settings, kya_id=kya_id)
    subj = (cert.get("certificate") or {}).get("credentialSubject") or {}
    return {
        "kya_id": kya_id,
        "cert_file": dest,
        "serial": cert.get("serial"),
        "agent_name": subj.get("agent_name"),
        "tier": subj.get("tier"),
        "certificate": cert,
    }
