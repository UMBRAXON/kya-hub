# ADR 001: Platform integrator vs KYA agent identity

**Status:** Accepted (2026-05-16)

## Context

KYA Hub serves autonomous agents (M2M registration, certs, Lightning payment) and will serve third-party systems (LNBits, marketplaces, SDKs) that verify agents or embed registration.

## Decision

1. **Single deployable** — one `server.js` + PostgreSQL. No microservice split.
2. **Two auth domains:**
   - **Agent (KYA):** Ed25519 manifest + PoW/sponsor + Lightning invoice. Revenue to operator store.
   - **Integrator (plug-in):** optional `Authorization: Bearer umb_live_…` API keys for rate limits and future paid tiers. Does not replace agent keys.
3. **Portal** is a client — only public/admin HTTP APIs, no direct DB from Next.js.
4. **Plug-in read surface:** `GET /api/v1/agents/{kya_id}` and `/status` (cached). Legacy `GET /api/cert/*` unchanged.
5. **Registration payments** always hit operator BTCPay/Alby; integrators do not receive registration sats unless a separate commercial agreement exists.

## Consequences

- New features ship as routes + `lib/*` modules behind feature flags/migrations.
- Integrator keys stored hashed (`developer_api_keys`); plain key shown once at create.
- LSAT / 402 for API monetization is a later ADR, not mixed with agent registration invoices.
