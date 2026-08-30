# KYA + L402 vs raw x402

> One line: **x402 solves payment. KYA solves who pays and with what trust score.**

Many x402 endpoints see traffic without revenue when payment is anonymous and
uncorrelated with agent identity. KYA Hub layers **verifiable agent identity** and
**delegation caveats** on top of Lightning-paid access.

---

## Comparison

| | Raw x402 | KYA + L402 delegation |
|--|----------|---------------------|
| **Payment** | HTTP 402 + wallet | BOLT11 / LSAT / delegation pass |
| **Payer identity** | Wallet pubkey (ephemeral) | `kya_id` + Ed25519 cert + manifest hash |
| **Trust signal** | None (pay = access) | Reputation, tier, CRL, cert proof |
| **Scope limits** | Usually price only | Caveats on delegation pass (`max_sats`, `allowed_tools`, …) |
| **Audit trail** | Payment hash | Payment + signed intent + action hash |
| **Integrator gate** | Optional | `POST /api/delegation-pass/verify` before paid API |

---

## Recommended flow (paid API operator)

```
Client agent                    Your API                     KYA Hub
     |                              |                            |
     |-- delegation pass request -->|                            |
     |                              |-- verify pass + caveats -->|
     |                              |<-- valid, kya_id, tier ----|
     |-- paid call + x402/L402 ---->|                            |
     |                              |-- optional status check -->|
     |<-- 200 + resource -----------|                            |
```

1. Verify delegation pass (or agent status for lower stakes).
2. Enforce caveats locally (tool name, amount, TTL).
3. Accept payment (x402 header, LSAT, or your existing Lightning flow).
4. Log `kya_id` + intent for dispute resolution.

---

## Hub primitives

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/agents/{id}/status` | Fast trust gate |
| `GET /api/v1/agents/{id}/status?include=cert_proof` | Cryptographic proof |
| `POST /api/delegation-pass/verify` | L402-aligned pass validation |
| `GET /api/protocol/l402-delegation-profile` | Claims + caveat schema |
| `POST /api/v1/integrator/lsat/invoice` | B2B day pass (default **5 000 sats / 24 h**) |

---

## Integrator pricing (live)

| Tier | Price | Notes |
|------|-------|-------|
| **Sandbox** | Free | Unauthenticated read limits; `UMBRA-TEST-*` blocked on prod |
| **LSAT day pass** | `GET /api/protocol/integrator-lsat-profile` | Self-serve Lightning |
| **Partner key** | Contact | `umb_live_…` — higher rate limits + webhooks |

Details: [Integrator quickstart](https://www.umbraxon.xyz/integrators/) · [FAQ §I.6](FAQ-FOR-BOT-DEVELOPERS.md)

---

## When to use which

- **Raw x402 only** — public metered API, no accountability, low dispute risk.
- **KYA status check** — marketplace / orchestrator needs “is this agent real?”
- **Delegation pass** — paid automation with spend caps and tool allowlists.
- **LSAT** — your product gates many verify calls (B2B integrator).

---

## Related

- [MCP Security Checklist](MCP-SECURITY-CHECKLIST.md) — permission boundaries + intent log
- [INTEGRATOR-TRUST-GATE.md](INTEGRATOR-TRUST-GATE.md) — status vs cert_proof
- [PRICING-ECONOMICS.md](PRICING-ECONOMICS.md) — full fee schedule
