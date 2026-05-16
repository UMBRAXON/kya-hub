# Release v1.1.0 — Integrations v1

**Hub release:** 1.1.0 · **Manifest protocol:** 1.0

## Highlights

- **M2M registration:** `POST /api/v1/register`, status poll, compact manifest builder
- **Integrations v1:** discovery feed opt-in, L402 delegation pass, developer webhooks, manifest extensions
- **Sponsor invites:** ELITE sponsors can issue one-time PoW bypass for invited pubkeys (payment + signatures remain)
- **Register PoW:** BASIC 16 / ELITE 18 bits (floor 14) for weaker clients
- **Bot Developer Portal:** https://www.umbraxon.xyz/bots/ (EN/SK, live tiers)

## Operators

- Migrations: `020_integrations_discovery.sql`, `021_m2m_lightning_node_index.sql`, `022_sponsor_invites.sql`
- Env: see `.env.example` (Integrations + Sponsor invites sections)
- Docs: `docs/SPONSOR-INVITE-DESIGN.md`, FAQ §D.4

## Links

- [README_API.md](../README_API.md)
- [CHANGELOG entry in UMBRAXON.md](../UMBRAXON.md)
