# Roadmap & TODO — po kritickom review (dev + investor)

> Kontext: skorá prevádzka, čakáme na prvého externého bota/integrátora. Priorita = dôvera, čestnosť, nízke trenie pre adopciu.

Legenda: **Ty** = človek / biznis · **Kód** = môžem v repozitári / serveri · **Spolu** = oboje

---

## P0 — dôvera a čestnosť (tento mesiac)

| # | Úloha | Kto | Poznámka |
|---|--------|-----|----------|
| P0.1 | Jednostránka **Čo sme / nie sme** | Kód | `docs/WHAT-WE-ARE-NOT.md` |
| P0.2 | Tabuľka **On-chain vs live** | Kód | `docs/ON-CHAIN-STATUS.md` |
| P0.3 | Verejný **`GET /api/protocol/public-metrics`** | Kód | trakcia + economics + uptime hint |
| P0.4 | Show HN + 1× Reddit | Ty | najväčší dosah |
| P0.5 | GSC index `/` + `/integrators` | Ty | 5 min |
| P0.6 | Pinned GitHub issue „Integrate in 5 min“ | Ty | `.github/PINNED_ISSUE_BODY.md` |

---

## P1 — technická zrelosť (1–3 mesiace)

| # | Úloha | Kto | Poznámka |
|---|--------|-----|----------|
| P1.1 | Sanitizovať **500 na verejných API** (žiadne `e.message`) | Kód | `lib/http-public-error.js` + vybrané routy |
| P1.2 | **Branch protection** na `main` (smoke required, žiadny bypass) | Ty | GitHub Settings |
| P1.3 | Zavrieť **Dependabot moderate** | Kód/Ty | `npm audit` + PR |
| P1.4 | Zjednotiť **brand** (`umbraxon` vs `umbraxon_kya`) | Spolu | npm org, copy, doména |
| P1.5 | **Uptime / status** stránka pre integrátorov | Kód | `/status` na portáli |
| P1.6 | Monolit: ďalšie routy do `lib/routes/*` | Kód | postupne, nie big-bang |
| P1.7 | **Runbook SLA** (čo ak hub 4h down) | Kód | `docs/OPS-SLA-DRAFT.md` |
| P1.8 | Externý **nezávislý audit** alebo bug bounty | Ty | keď prvý partner |

---

## P2 — rast a sieť (keď príde prvý externý user)

| # | Úloha | Kto | Poznámka |
|---|--------|-----|----------|
| P2.1 | **10+ platených agentov** mimo testov | Čas | organické + 1 sponsor invite kampaň |
| P2.2 | **1 integrátor** s verejnou referenciou | Ty | LNBits / marketplace / framework |
| P2.3 | **PyPI** `umbraxon` (Trusted Publisher) | Ty | Actions workflow hotový |
| P2.4 | **Self-host Docker** „hub-lite“ | Kód | `docker-compose.hub-lite.yml` + `docs/HUB-LITE-DOCKER.md` |
| P2.5 | **Federácia / 2. hub** ADR | Kód | dokument, nie implementácia hneď |
| P2.6 | HSM / offline ROOT | Kód | investor ask |
| P2.7 | Právnik: GDPR + CRL + purge | Ty | 1 konzultácia |

---

## Extra — hodnota pre ostatných (nie len pre nás)

| Nápad | Pre koho | Čo rieši |
|--------|----------|----------|
| **Verify badge** (embed / SVG) | Integrátori | „Overené KYA“ na webe partnera |
| **Open metrics** `/api/protocol/public-metrics` | Investori, devs | transparentná trakcia bez dashboardu |
| **LNBits plugin** `integrations/lnbits-kya-verify` | Lightning komunita | gate pred platbou v LNBits |
| **Webhook „nový agent v discovery“** | Platformy | notifikácia pri opt-in feed |
| **Sponsor invites** (už v protokole) | Prví boti | prvých N registrácií bez trenia |
| **Porovnávacia tabuľka** KYA vs API key vs OAuth | Rozhodovatelia | prečo nie len API kľúč |
| **llms.txt + well-known** (hotové) | AI agenti | objaviteľnosť |
| **Sandbox `UMBRA-TEST-*`** (hotové) | Integrátori | test bez mainnetu |
| **Economics API** (hotové) | Integrátori | úprimný Sybil popis |
| **MCP read-only** | Cursor / IDE | dev skúša hub bez platby |

---

## Čo zámerne NERobiť teraz

- Sľubovať „anti-Sybil záruku“ alebo AML compliance
- Multi-region cluster pred prvým partnerom
- Token / ICO / „trust coin“
- Spam automat na sociálnych sieťach

---

## Stav implementácie tohto dokumentu

| Položka | Stav |
|---------|------|
| WHAT-WE-ARE-NOT.md | hotové |
| ON-CHAIN-STATUS.md | hotové |
| GET /api/protocol/public-metrics | hotové |
| P1.1 500 sanitization | čiastočne hotové |
| P1.5 /status page | hotové |
| P2.4 hub-lite Docker | hotové |
| KYA vs API key doc | hotové |
| Verify badge on /integrators | hotové |
| Ostatné | backlog |

Posledná aktualizácia: 2026-05-18
