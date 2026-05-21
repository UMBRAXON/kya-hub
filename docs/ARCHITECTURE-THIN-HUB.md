# Architecture: thin hub, fat protocol

> Smer refaktoringu po P1.6. **Nie big-bang** — postupné presuny z `server.js` do `lib/routes/*` a `lib/protocol-core.js`.

## Problém dnes

- `server.js` ~6.6k LOC — routy, platby, admin, webhooky v jednom súbore.
- Integrátori musia čítať monolit, aby pochopili gate.
- Ops závislosť: jeden proces = veľká blast radius.

## Cieľový tvar

```
packages/kya-verify/     ← integrator npm (gate)
lib/protocol-core.js     ← manifest, canonical JSON, verify helpers (Node)
lib/routes/*.js          ← HTTP handlers podľa domény
lib/create-hub-app.js    ← express + middleware factory (budúce)
server.js                ← bootstrap: env, pool, register routes, listen
```

### Vrstvy

| Vrstva | Zodpovednosť | Súbory |
|--------|--------------|--------|
| Protocol | Čo je podpis, manifest, cert | `lib/manifest-schema.js`, `lib/protocol-core.js`, `lib/certs.js` |
| Domain | Registrácia, reputácia, platby | `lib/api-v1-register.js`, `lib/reputation-engine.js`, … |
| HTTP | Mapovanie URL → domain | `lib/routes/protocol-routes.js`, `discovery-routes.js`, `platform-integrator-routes.js`, … |
| Bootstrap | Pool, env, PM2 | `server.js`, `ecosystem.config.js` |

## Pravidlá refaktoringu

1. **Jeden PR = jedna route skupina** — žiadny 3k riadkový diff.
2. Nové endpointy **len** v `lib/routes/`, nie v `server.js`.
3. `server.js` môže dočasne re-exportovať helpery — odstrániť až keď nič iné neimportuje.
4. Testy: `npm run ci:smoke` po každom presune.

## Už presunuté

| Modul | Endpointy |
|-------|-----------|
| `platform-integrator-routes.js` | `/api/v1/agents/*`, integrator sandbox |
| `protocol-routes.js` | `/api/protocol/*`, delegation verify |
| `discovery-routes.js` | `/api/discovery/v1/*`, embed badge |
| `admin-growth-routes.js` | sponsor pool admin, agent history export |

## Registrácia — dve cesty (produkt)

| Cesta | Kedy |
|-------|------|
| **Sandbox** | `UMBRA-TEST-*` + `GET /api/protocol/integrator-sandbox` — bez LN |
| **Production** | Python/HTTP register + LN platba alebo sponsor pool kód |

„LN na prvý krok“ nie je cieľ — dokumentácia má viesť sandbox → mainnet.

## Federácia

Pozri [`adr/ADR-001-multi-hub-federation.md`](adr/ADR-001-multi-hub-federation.md).

## Súvis s go-to-market

Tenký hub = rýchlejšie review pre prvého integrátora a lacnejší externý audit.

Posledná aktualizácia: 2026-05-19
