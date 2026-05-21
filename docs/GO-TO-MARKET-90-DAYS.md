# Go-to-market — 90 dní (UMBRAXON KYA-Hub)

> Priorita: **(1) viditeľnosť a prví integrátori**, **(2) prví cudzí boti v sieti**, **(3) financie** až keď existuje trakcia.  
> Technický backlog: [`ROADMAP-TODO.md`](ROADMAP-TODO.md) · Architektúra: [`ARCHITECTURE-THIN-HUB.md`](ARCHITECTURE-THIN-HUB.md)

**Export do Wordu (jeden súbor, tabuľky + formátovanie):** [`export/UMBRAXON-OPERATOR-PACK.html`](export/UMBRAXON-OPERATOR-PACK.html) — návod [`JAK-EXPORTOVAT-DO-WORDU.md`](JAK-EXPORTOVAT-DO-WORDU.md)

Legenda: **Ty** = operátor / biznis · **Kód** = repozitár alebo server · **Spolu**

---

## Fáza 0 — mentálny model (deň 0)

| Otázka | Odpoveď |
|--------|---------|
| Čo predávame? | HTTP trust gate + certifikát, nie „AI platformu“. |
| Komu? | Najprv **Lightning / agent framework / marketplace** — nie banky. |
| Čo je úspech v mesiaci 1? | **1 cudzí integrátor** + **3–5 cudzích `UMBRA-*`** (mimo tvojich testov). |
| Čo nie je úspech? | 50 nových feature, ďalší tier, token. |

Verejné čísla sleduj na: `GET https://www.umbraxon.xyz/api/protocol/public-metrics`

---

## Mesiac 1 (dni 1–30) — „Kde sú a ako ich nájsť“

Cieľ: **byť objaviteľný** a mať **jednu konverziu týždenne** s niekým, kto môže integrovať.

### Týždeň 1 — mapa kanálov + prvý obsah

| Deň | Ty | Kód / asset |
|-----|-----|-------------|
| 1–2 | Prečítaj [`WHERE-TO-FIND-INTEGRATORS.md`](WHERE-TO-FIND-INTEGRATORS.md); vypíš 20 konkrétnych miest (nie „internet“). | — |
| 2 | — | Skontroluj: `llms.txt`, `.well-known/kya-hub.json`, `/integrators`, `/status` |
| 3 | **Show HN** — titulok typu „Know Your Agent: Lightning-paid bot certs + one HTTP gate“ (bez AI klišé). Link na integrators + 5min quickstart. | [`docs/INTEGRATOR-QUICKSTART-5MIN.md`](INTEGRATOR-QUICKSTART-5MIN.md) |
| 4 | 1× post **r/lightningnetwork** alebo **r/bitcoin** (technický, krátky). | — |
| 5 | **GSC**: over index `/`, `/integrators`, `/bots/` (5 min). | Sitemap v portáli |
| 6 | GitHub: **pinned issue** „Integrate in 5 min“ (už v [`.github/PINNED_ISSUE_BODY.md`](../.github/PINNED_ISSUE_BODY.md)). | — |
| 7 | Review: koľko traffic / issues / DM. Uprav týždeň 2 podľa odozvy. | `public-metrics` |

**Metriky týždňa 1:** 1 launch post, 50+ návštev integrators, 0–2 inbound správy.

### Týždeň 2 — Lightning komunita (beachhead)

| Akcia | Detail |
|-------|--------|
| LNBits | Napíš maintainerovi / Discorde: „plugin gate pred payout“ — [`integrations/lnbits-kya-verify/README.md`](../integrations/lnbits-kya-verify/README.md) |
| Alby / Megalith / LSP | Nie predaj KYA — otázka: „Máte agentov, čo potrebujú inbound?“ (likvidita je tvoj reálny blocker pre BASIC registrácie) |
| Nostr dev relays | Krátky thread: Ed25519 identita + LN poplatok, nie bearer token |
| Cursor / MCP zoznamy | PR do zoznamov MCP serverov (read-only hub MCP) |

**Metriky:** 3 osobné outreach správy s konkrétnym curl, 1 odpoveď.

### Týždeň 3 — agent frameworky a „platform integrator“

| Cieľ | Kanál |
|------|--------|
| LangChain / CrewAI / AutoGPT diskusie | Issue: „How do you verify the other agent?“ → link status gate |
| GitHub Discussions | Template **Platform integrator** |
| 1 demo video (2 min) | Screen recording: `curl status` + badge embed |

**Metriky:** 1 diskusná vetva s tvojím linkom, 1 key-request formulár od cudzieho emailu.

### Týždeň 4 — prvý „lastovička“ integrátor

| Krok | Popis |
|------|--------|
| Definícia lastovičky | Niekto, kto **nasadí** `GET /api/v1/agents/{id}/status` do **svojho** produktu (aj malého). |
| Ponuka | Bezplatný partner API key + pomoc s integráciou 2h (ty). |
| Verejná referencia | Logo / meno na `/integrators` — len po súhlase. |
| Zlyhanie týždňa | Ak 0 — zúž niche na **jeden** LN projekt a choď all-in. |

**Metriky mesiaca 1:** ≥1 integrátor (aj hobby), ≥10 verify API calls/7d od cudzieho kľúča alebo IP.

---

## Mesiac 2 (dni 31–60) — „Prvé boty do siete“

Cieľ: **`production_agents_paid` ≥ 5** mimo `UMBRA-000467/468` a test mien.

### Týždeň 5–6 — zníž trenie registrácie

| Ty | Kód |
|----|-----|
| Zapni **sponsor invites** pre 1–2 dôveryhodných ELITE (ak máš) | `SPONSOR_INVITE_ENABLED=true` |
| Rozdaj 5× **sponsor pool** kódov na BASIC (konferencia, DM) | Admin: `POST /api/admin/sponsor-pool/codes` |
| Dokumentuj sandbox → mainnet cestu | [`REGISTRATION-QUICKSTART.md`](REGISTRATION-QUICKSTART.md) |

**Flow pre prvého bota:**

1. Integrátor otestuje `UMBRA-TEST-*` (bez platby).
2. Zaregistruje vlastného bota (BASIC 10k sats alebo pool kód).
3. Voliteľne `discovery_opt_in` → objaviteľný v feede.

### Týždeň 7–8 — sieťový efekt (mini)

| Akcia | Prečo |
|-------|--------|
| Discovery feed + webhook `discovery.indexed` | Platformy vidia nového agenta |
| 2 agenti s **payment_hints** | Ukáž M2M LN routing v praxi |
| Jedna „peer report“ medzi dvoma cudzími botmi | Dokážeš, že reputácia žije |

### Týždeň 9–10 — druhý integrátor alebo hĺbka prvého

| Vetva A (rast siete) | Vetva B (hlbšia integrácia) |
|----------------------|-----------------------------|
| Druhý malý integrátor | Prvý používa `cert_proof` + webhooks |
| Spoločný blog post / README badge | Case study 1 strana |

**Metriky mesiaca 2:** 5+ platených agentov, 2+ v discovery, 1 cudzí integrátor s verejným zmienkou.

---

## Mesiac 3 (dni 61–90) — „Financie a zrelosť“

Financie **až tu** — nie preto, že by neboli dôležité, ale preto, že bez mesiaca 1–2 nemáš čo monetizovať okrem vlastných 10k sats.

### Týždeň 11–12 — unit economics

| Položka | Akcia |
|---------|--------|
| Náklady | Hetzner + CF + čas — jedna tabuľka (mesiac) |
| Príjmy | Súčet registrácií z DB / public-metrics |
| Cieľ | Pokryť **prevádzku** (nie plat) z 10–20 BASIC / mesiac |

### Týždeň 13 — cenotvorba a ELITE

| Rozhodnutie | Odporúčanie |
|-------------|-------------|
| BASIC 10k | Nechaj, kým nemáš 20+ agentov |
| ELITE 80k | Predávaj len keď anchor + listing dávajú zmysel |
| Partner pricing | Integrátor s vysokým objemom → custom API tier (manuálne) |

### Týždeň 14 — právne a audit (light)

| Ty | Poznámka |
|----|----------|
| 1h konzultácia GDPR + verejný register | [`WHAT-WE-ARE-NOT.md`](WHAT-WE-ARE-NOT.md) ako podklad |
| Bug bounty / audit | Až pri prvom platenom B2B partnerovi |

### Týždeň 15 — technická dôvera pre partnera

| Kód | Stav |
|-----|------|
| Branch protection + CI smoke | Ty: GitHub Settings |
| Route split (`lib/routes/*`) | Pokračuj podľa [`ARCHITECTURE-THIN-HUB.md`](ARCHITECTURE-THIN-HUB.md) |
| Federácia ADR | [`adr/ADR-001-multi-hub-federation.md`](adr/ADR-001-multi-hub-federation.md) |
| OPS SLA | [`OPS-SLA-DRAFT.md`](OPS-SLA-DRAFT.md) |

**Metriky mesiaca 3:** 10+ agentov, 2 integrátori, náklady ≤ príjmy alebo jasný plán partner deal.

---

## Kanály — kde sú „lastovičky“ (skrátená mapa)

Detail: [`WHERE-TO-FIND-INTEGRATORS.md`](WHERE-TO-FIND-INTEGRATORS.md)

| Priorita | Kde | Kto tam sedí |
|----------|-----|--------------|
| P0 | Lightning / LNBits / Alby ekosystém | Operátori uzlov, plugin autori |
| P0 | Hacker News, GitHub `agent`, `mcp` trendy | Early adopters |
| P1 | AI agent framework Discord/Issues | DevOps pre botov |
| P1 | Bitcoin-only marketplaces | Predaj služieb za sats |
| P2 | Enterprise compliance | Až po 10+ agentoch a case study |

---

## Čo nerobiť (90 dní)

- Token, ICO, „KYA coin“
- Sľubovať AML/KYC pre ľudí
- Multi-region pred prvým partnerom
- 20 nových tierov
- Spam na Twitter/X bez technického obsahu

---

## Týždenný dashboard (5 min každý pondelok)

```bash
curl -fsS https://www.umbraxon.xyz/api/protocol/public-metrics | jq '.traction, .integrator_verify_7d'
curl -fsS https://www.umbraxon.xyz/api/discovery/v1/agents.json | jq '.count'
```

| Metrika | Mesiac 1 cieľ | Mesiac 2 | Mesiac 3 |
|---------|---------------|----------|----------|
| `production_agents_paid` | 3 | 8 | 15 |
| Distinct integrator API keys (7d) | 1 | 2 | 3 |
| Verify calls (7d) | 50 | 200 | 500 |
| Discovery `count` | 2 | 6 | 12 |
| Inbound key-requests | 2 | 5 | 10 |

---

## Súvis s technickým roadmapom

| GTM potreba | Kód / doc |
|-------------|-----------|
| Dôvera | `/status`, public-metrics, WHAT-WE-ARE-NOT |
| Nízke trenie | Sandbox first, `scripts/integrate-in-5min.sh` |
| Prví boti | Sponsor pool, sponsor invites |
| Platformy | Discovery webhook, LNBits plugin, badge |
| Partner | Agent history export, OPS SLA, federation ADR |

Posledná aktualizácia: 2026-05-19
