# Roadmap & TODO — po kritickom review (dev + investor)

> Kontext: skorá prevádzka, čakáme na prvého externého bota/integrátora. Priorita = dôvera, čestnosť, nízke trenie pre adopciu.  
> **90-dňový GTM plán:** [`GO-TO-MARKET-90-DAYS.md`](GO-TO-MARKET-90-DAYS.md) · **Kde hľadať ľudí:** [`WHERE-TO-FIND-INTEGRATORS.md`](WHERE-TO-FIND-INTEGRATORS.md)

Legenda: **Ty** = človek / biznis · **Kód** = môžem v repozitári / serveri · **Spolu** = oboje

---

## P0 — dôvera a čestnosť (tento mesiac)

| # | Úloha | Kto | Poznámka |
|---|--------|-----|----------|
| P0.1 | Jednostránka **Čo sme / nie sme** | Kód | `docs/WHAT-WE-ARE-NOT.md` ✅ |
| P0.2 | Tabuľka **On-chain vs live** | Kód | `docs/ON-CHAIN-STATUS.md` ✅ |
| P0.3 | Verejný **`GET /api/protocol/public-metrics`** | Kód | ✅ |
| P0.4 | Show HN + 1× Reddit | Ty | najväčší dosah |
| P0.5 | GSC index `/` + `/integrators` | Ty | 5 min |
| P0.6 | Pinned GitHub issue „Integrate in 5 min“ | Ty | `.github/PINNED_ISSUE_BODY.md` ✅ |

---

## P1 — technická zrelosť (1–3 mesiace)

| # | Úloha | Kto | Poznámka |
|---|--------|-----|----------|
| P1.1 | Sanitizovať **500 na verejných API** | Kód | `lib/http-public-error.js` + protocol/discovery routes ✅ (pokračovať na zvyšku server.js) |
| P1.2 | **Branch protection** na `main` | Ty | GitHub Settings |
| P1.3 | Zavrieť **Dependabot moderate** | Kód/Ty | `npm audit` |
| P1.4 | Zjednotiť **brand** | Spolu | npm `@umbraxon_kya/kya-verify` |
| P1.5 | **Uptime / status** | Kód | `/status` + OPS SLA link ✅ |
| P1.6 | Monolit → `lib/routes/*` | Kód | protocol, discovery, admin-growth ✅; ďalšie skupiny v [`ARCHITECTURE-THIN-HUB.md`](ARCHITECTURE-THIN-HUB.md) |
| P1.7 | **Runbook SLA** | Kód | `docs/OPS-SLA-DRAFT.md` ✅ |
| P1.8 | Externý audit / bug bounty | Ty | po prvom partnerovi |

---

## P2 — rast a sieť

| # | Úloha | Kto | Poznámka |
|---|--------|-----|----------|
| P2.1 | **10+ platených agentov** | Čas | [`GO-TO-MARKET-90-DAYS.md`](GO-TO-MARKET-90-DAYS.md) mesiac 2 |
| P2.2 | **1 integrátor** s referenciou | Ty | LNBits / marketplace |
| P2.3 | **PyPI** `umbraxon` | Ty | workflow v `.github/workflows/publish-umbraxon-pypi.yml` |
| P2.4 | **Self-host hub-lite** | Kód | ✅ |
| P2.5 | **Federácia ADR** | Kód | `docs/adr/ADR-001-multi-hub-federation.md` + `GET /api/protocol/trusted-hubs.json` ✅ |
| P2.6 | HSM / offline ROOT | Kód | backlog |
| P2.7 | Právnik GDPR | Ty | 1 konzultácia |

---

## Extra — implementované / rozšírené (2026-05-19)

| Nápad | Stav |
|--------|------|
| `scripts/integrate-in-5min.sh` | ✅ |
| `lib/protocol-core.js` | ✅ |
| Discovery webhook (`DISCOVERY_WEBHOOK_URLS`) | ✅ |
| `discovery.indexed` dev webhook event | ✅ |
| Sponsor pool admin API + migrácia 028 | ✅ (register hook = env, default off) |
| Agent history export `GET /api/admin/agent/:id/history-export` | ✅ |
| LNBits plugin | ✅ `integrations/lnbits-kya-verify/` |
| Sandbox-first registration doc | ✅ |

---

## Čo zámerne NERobiť teraz

- Token / ICO
- Multi-region HA pred prvým partnerom
- Sľubovať AML compliance

Posledná aktualizácia: 2026-05-19
