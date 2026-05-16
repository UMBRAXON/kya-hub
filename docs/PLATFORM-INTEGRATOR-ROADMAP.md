# Platform / plug-in integrator roadmap

> Layer on existing KYA Hub — **no service split**. Portal and plug-ins call the same `server.js` API.

## Roles

| Role | Auth | Pays registration |
|------|------|-------------------|
| **Agent (KYA)** | Ed25519 + PoW/payment | Yes → operator BTCPay/Alby |
| **Integrator (plug-in)** | Optional `umb_live_…` API key | No (reads verify API; paid tiers later) |
| **Admin** | `X-Admin-Key` | — |

## Phases & estimates (solo, production-safe)

| Phase | Scope | Calendar (part-time ~15h/wk) | Calendar (full-time) |
|-------|--------|------------------------------|----------------------|
| **0** | ADR, OpenAPI policy, portal audit | 1 week | 2–3 days |
| **1** | `GET /api/v1/agents/{id}` + `/status`, TTL cache, tests | **Done (core)** + 1 week polish | 3–5 days |
| **2** | `developer_api_keys`, middleware, per-key rate limit, admin create key | 3–4 weeks | 1–2 weeks |
| **2b** | Partner FAQ, README_API section, example snippet | 1 week | 2–3 days |
| **3** | Webhook delivery queue + retry + delivery log | **Done (core)** + polish | — |
| **4** | `umbraxon-py` on repo (`packages/umbraxon-py`) | **Done (core)** | — |
| **5** | LSAT day pass (`umb_lsat_…`, BTCPay invoice) | **Done (core)** | — |
| **6** | LNBits extension, CrewAI tool (thin proxies) | per platform | per platform |

**MVP for real plug-in partners (phases 0–2b):** ~**6–10 weeks** part-time, ~**3–4 weeks** full-time.

## Shipped in repo

- `lib/platform-integrator.js` — aggregated read + `trust.verified`
- `lib/ttl-cache.js` — 5 min cache (`INTEGRATOR_READ_CACHE_MS`)
- `GET /api/v1/agents/:kya_id`, `GET /api/v1/agents/:kya_id/status`
- `lib/developer-api-auth.js` + migration `023_developer_api_keys.sql`
- `lib/developer-webhook-queue.js` + migration `024_developer_webhook_outbox.sql`
- `packages/umbraxon-py/` — Python SDK (`UmbraxonIntegratorClient`, `verify_agent`)
- `lib/integrator-lsat.js` + migration `025_integrator_lsat.sql` — LSAT invoice/redeem
- `test-platform-integrator.js`, `test-developer-api-keys.js`, `test-integrator-lsat.js`

## Plug-in flow (payments)

Registration invoices always hit **operator** hub store. Integrators verify via read API; revenue is registration + ELITE fees, not API key fees until phase 5.
