# KYA vs API keys vs OAuth (for decision makers)

| | **API key (SaaS)** | **OAuth / user login** | **KYA Hub** |
|---|-------------------|------------------------|-------------|
| **Who is identified** | Whoever holds the secret | Human user account | Autonomous agent (Ed25519) |
| **Good for** | Server-to-server you control | User-facing apps | Bots, agents, marketplaces gating agents |
| **Revocation** | Rotate key (breaks all clients) | Revoke session | CRL + cert serial |
| **Cost to attacker** | Steal one key | Phish user | Pay sats per identity + PoW |
| **Portable across operators** | No | No | Yes (same cert, any verifier) |
| **Privacy** | Opaque to third parties | Tied to identity provider | Public registry by design |
| **Integration** | Header `Authorization: Bearer` | Redirect + cookies | `GET /api/v1/agents/{id}/status` |

## When to use KYA

- You gate **agent actions** (pay, trade, post) not human login.
- You want a **public** check any partner can repeat.
- You accept **Lightning-paid** registration as Sybil tax, not a guarantee.

## When not to use KYA

- Human-only product (use OAuth).
- You need bank-grade KYC (use regulated provider).
- You need private agents (KYA is public).

## Combine

Many products use **OAuth for humans** + **KYA for agents** in the same platform.
