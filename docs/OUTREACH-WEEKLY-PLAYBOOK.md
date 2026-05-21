# Týždenný outreach — konkrétne kroky (1 kanál / týždeň)

Cieľ nie je „byť všade“, ale **jedna konverzia týždenne** s niekým, kto môže integrovať `GET /api/v1/agents/{id}/status`.

Metriky: `GET https://www.umbraxon.xyz/api/protocol/public-metrics` · logy: `logs/growth/`

---

## Týždeň A — Show HN (raz za 4–6 týždňov, nie každý týždeň)

**Kedy:** utorok–štvrtok, 14:00–17:00 UTC (USA ešte vstáva).

**Kroky:**

1. Skontroluj sandbox: `./scripts/integrate-in-5min.sh` (7/7).
2. Titulok (bez AI klišé):  
   `Know Your Agent — Lightning-paid bot certs + one HTTP status gate`
3. Text (šablóna):
   - 2 vety: čo to je (Ed25519 + LN poplatok, nie OAuth).
   - `curl` na `UMBRA-TEST-0001/status`.
   - Link: https://www.umbraxon.xyz/integrators
   - Link: https://www.umbraxon.xyz/llms.txt
4. Odpovedaj na **každý** komentár do 24 h (technicky, krátko).
5. Zapíš si: koľko komentárov, koľko klikov (Cloudflare Analytics).

**Úspech týždňa:** 1+ komentár od niekoho s vlastným projektom / integráciou.

---

## Týždeň B — LNBits / Lightning maintainer (DM alebo issue)

**Koho:** maintainer LNBits plugin ekosystému alebo niekto z `integrations/lnbits-kya-verify/README.md`.

**Kroky:**

1. Prečítaj README pluginu v repozitári.
2. Otvor **jeden** kanál: GitHub issue *alebo* Discord DM (nie oboje naraz).
3. Správa (max 12 riadkov):
   - „Gate pred payout: jeden GET na KYA status.“
   - Link na integrators + curl sandbox.
   - Ponuka: pomôžeš s PR do ich docs / example (2 h tvojho času).
4. Follow-up po 5 dňoch, ak ticho — jeden krátky bump, nie spam.

**Úspech:** odpoveď alebo „pošli PR“.

---

## Týždeň C — 1 konkrétny maintainer (framework / agent stack)

**Koho:** vyber z [`WHERE-TO-FIND-INTEGRATORS.md`](WHERE-TO-FIND-INTEGRATORS.md) — **jeden** riadok (LangChain diskusia, CrewAI, AutoGPT issue, MCP zoznam…).

**Kroky:**

1. Nájdi **otvorený** issue/discussion: „how to verify agent“, „Sybil“, „tool auth“.
2. Nepíš predajný essay. Napíš:
   - 1 vetu problému, ktorý riešiš.
   - `curl -sS "https://www.umbraxon.xyz/api/v1/agents/UMBRA-TEST-0001/status"`
   - „Sandbox na produkcii, bez platby.“
3. Ak máš draft zo scoutu: `logs/growth/scout-*.md` — uprav rukou, pošli.
4. Zapíš meno projektu + URL do poznámky (neopakuj kontakt 30 dní).

**Úspech:** reakcia alebo key-request na `/integrators`.

---

## Týždeň D — GitHub Discussions / pinned issue (nízko náročné)

**Kroky:**

1. Skontroluj pinned issue „Integrate in 5 min“ na `UMBRAXON/kya-hub`.
2. Ak niekto komentoval tento týždeň — odpovedz.
3. Ak ticho: krátky update komentár (novinka: sandbox, `/status`, npm `@umbraxon_kya/kya-verify`).

---

## Čo nerobiť každý týždeň

- Masové DM desiatkam ľudí.
- Postovanie toho istého textu na 5 subredditov.
- Sľub „EU compliant KYC“ — nie ste to.

---

## Rotácia (odporúčané)

| Týždeň v mesiaci | Kanál |
|------------------|--------|
| 1 | LNBits / Lightning |
| 2 | 1 maintainer (issue) |
| 3 | GitHub Discussions / scout lead |
| 4 | Show HN **alebo** Reddit r/lightningnetwork (ak HN pred mesiacom) |

Automatizácia dopĺňa: `kya-growth-cycle` (scout, HN/Reddit alerty, demo witness) — pozri [`GROWTH-BOTS.md`](GROWTH-BOTS.md).
