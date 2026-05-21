# Kde hľadať prvých integrátorov a botov

> Svet je veľký — tento dokument zužuje na **konkrétne miesta**, nie „všade na internete“.

---

## 1. Lightning / Bitcoin (P0 — tvoj beachhead)

| Miesto | Čo urobiť | Čo im ponúknuť |
|--------|-----------|----------------|
| [LNBits extensions / plugins](https://github.com/lnbits/lnbits-extensions) | Issue alebo PR: `integrations/lnbits-kya-verify` | Gate pred send/payout |
| Alby Hub komunita | DM / fórum — technický, nie sales | NWC + status gate pre agentov |
| r/lightningnetwork, r/bitcoin | 1 post / mesiac max, faktický | curl + link integrators |
| Megalith / LSP (už máš kanál) | Likvidita + „agent registration test“ | Reálny inbound pre BASIC |
| BTCPay komunita | Plugin / webhook story | Overenie agenta pred invoice |

**Signál záujmu:** nie lajk — **issue, fork, alebo „môžeme to dať do pluginu?“**

---

## 2. Vývojári agentov (P0–P1)

| Miesto | Čo urobiť |
|--------|-----------|
| GitHub Topics: `ai-agent`, `langchain`, `autonomous-agent`, `mcp-server` | Star + komentár na issue o trust/identity |
| [Model Context Protocol](https://modelcontextprotocol.io) komunity | MCP server už máš — 1 PR do awesome zoznamu |
| Cursor / Windsurf / IDE fóra | „Verify bot before tool call“ — status API |
| Hacker News (Show HN) | Jeden silný launch, nie opakovanie |
| Discord servery projektov (CrewAI, AutoGPT, …) | Odpovedať na „how to trust remote agent“ |

**Signál:** niekto spustí `UMBRA-TEST-*` a potom otvorí registration-help issue.

---

## 3. Platformy a marketplaces (P1)

| Typ | Príklad use-case |
|-----|------------------|
| Agent marketplace | Badge + `GET …/status` na listing |
| Freelance bot API | cert_proof na vysokú hodnotu |
| M2M API s LN platbami | payment_hints + KYA id |

**Signál:** vyplnený [`/api/v1/integrator/key-request`](https://www.umbraxon.xyz/integrators) s reálnym use-case.

---

## 4. Regulácia / enterprise (P2 — neskôr)

| Kto | Prečo až neskôr |
|-----|------------------|
| Banky, KYC vendori | Chcú audit, SLA, viac ako 2 agentov |
| EU AI Act konzultanti | Potrebujú case study, nie whitepaper |

**Signál:** RFP alebo „security questionnaire“ — vtedy [`agent history export`](../lib/agent-history-export.js) a OPS SLA.

---

## 5. Čo napísať (šablóna — 6 viet)

```
We run a public KYA registry: bots pay 10k sats (Lightning), get an Ed25519 cert,
no API keys on privileged actions. Your app can gate in one HTTP call:
GET /api/v1/agents/{kya_id}/status — sandbox: UMBRA-TEST-0001 (verified true).
Docs: https://www.umbraxon.xyz/integrators
5 min: https://github.com/UMBRAXON/kya-hub/blob/main/docs/INTEGRATOR-QUICKSTART-5MIN.md
```

Žiadne „revolučné AI riešenie“. Len curl a link.

---

## 6. Červené vlajky (strácaš čas)

| Signál | Reakcia |
|--------|---------|
| „Urobíme vlastný registry“ | OK — ponúkni hub-lite Docker |
| Chce len free identitu | Ukáž economics API (Sybil cost) |
| Chce KYC ľudí | Odíď — [`WHAT-WE-ARE-NOT.md`](WHAT-WE-ARE-NOT.md) |
| Žiadna odpoveď po 2 follow-up | Ďalší kanál |

---

## 7. Sledovanie pokroku

Týždenne: [`GO-TO-MARKET-90-DAYS.md`](GO-TO-MARKET-90-DAYS.md) dashboard + `public-metrics`.

Posledná aktualizácia: 2026-05-19
