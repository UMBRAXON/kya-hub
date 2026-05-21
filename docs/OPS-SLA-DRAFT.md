# OPS SLA (draft) — UMBRAXON KYA-Hub

> **Draft** pre integrátorov a vlastný runbook. Nie je právna zmluva — uprav pred B2B podpisom.

## Scope

| V súčasnosti | Mimo scope |
|--------------|------------|
| `https://www.umbraxon.xyz` (Cloudflare → origin) | Self-hosted hub-lite u tretích strán |
| `GET /api/health`, `/api/v1/agents/*/status`, verejné protocol GET | Platená registrácia (závisí na Alby/BTCPay) |
| CRL + cert verify | On-chain anchor (závisí na bitcoind) |

## Cieľová dostupnosť (interný cieľ)

| Obdobie | Cieľ | Poznámka |
|---------|------|----------|
| Mesiac 1–3 | **99.0%** mesačne | Single-node, žiadny HA |
| Po prvom platenom partnerovi | **99.5%** | + dokumentované okná údržby |

Výpočet: `(total_minutes - downtime_minutes) / total_minutes`.  
Verejný signál: [`/status`](https://www.umbraxon.xyz/status) + `GET /api/health`.

## Plánovaná údržba

- Okno: **UTR 03:00–05:00 UTC** (nízky traffic).
- Oznámenie: minimum **24h** vopred (Telegram / status banner) pre zmeny DB migrácie.
- Postup: `docs/DEPLOY-CHECKLIST.md` → migrácie → `pm2 restart kya-hub` → smoke curl.

## Incident severity

| Severity | Príklad | Cieľová reakcia | Cieľové obnovenie |
|----------|---------|-----------------|-------------------|
| SEV-1 | Hub 5xx, status gate down pre všetkých | 15 min acknowledge | 4h |
| SEV-2 | Registrácia nefunguje, read API OK | 1h | 24h |
| SEV-3 | Jedna funkcia (discovery, badge) | Ďalší pracovný deň | 72h |
| SEV-4 | Kosmetika portálu | Backlog | — |

## Runbook (skrátený)

### Hub nedostupný (SEV-1)

1. `curl -fsSI https://www.umbraxon.xyz/api/health`
2. SSH: `pm2 list` — `kya-hub`, `kya-portal`, `kya-hub-proxy`
3. Logy: `pm2 logs kya-hub --lines 100 --nostream`
4. DB: `systemctl status postgresql`
5. Ak origin: Cloudflare orange-cloud + UFW len CF — priamy hit na IP **nie** je test
6. Komunikácia: aktualizuj `/status`, Telegram ak SEV-1 > 30 min

### Registrácia zlyhá (SEV-2)

1. `GET /api/health` — `alby`, `btcpay` polia
2. Lightning liquidity monitor log (inbound pre BASIC)
3. `scripts/alby-lookup-invoice.js <payment_hash>`

### Po obnove

1. Smoke: `npm run ci:smoke` na stroji
2. `curl` status gate + `public-metrics`
3. Post-mortem do `docs/` (1 strana) ak SEV-1/2 > 1h

## Závislosti (single points of failure)

| Komponent | Dopad | Mitigácia (budúcnosť) |
|-----------|-------|------------------------|
| Hetzner 1× VPS | Total outage | DR snapshot, hub-lite second region |
| Cloudflare | Edge outage | Rare; DNS-only fallback documented |
| PostgreSQL single | Data + API | Offsite backup `backup-database.sh` |
| Alby Hub | LN registrácie | BTCPay fallback čiastočne |
| Operátor (ty) | Bus factor | Runbook + 2nd admin key holder |

## Komunikácia s integrátormi

| Kanál | Použitie |
|-------|----------|
| `/status` | Verejný stav |
| GitHub Issues | Bug reporty |
| Email / Telegram | Dohodnutý partner kanál (manuálne) |

**SLA odpovede pre partner API key:** ešte nie definované — nastav po prvom podpísanom integrátorovi.

## Metriky

- Prometheus: `GET /api/metrics` (admin)
- Verejné: `GET /api/protocol/public-metrics`
- Uptime externý: UptimeRobot na `https://www.umbraxon.xyz/api/health` (nie na origin IP)

Posledná aktualizácia: 2026-05-19
