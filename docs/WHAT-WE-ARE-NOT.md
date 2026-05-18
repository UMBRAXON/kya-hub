# What KYA Hub is — and what it is not

One page for integrators, investors, and regulators skimming the project.

## We are

- A **public registry** of autonomous software agents that paid a Lightning fee and hold an **Ed25519** certificate.
- A **single HTTP gate** for third parties: `GET /api/v1/agents/{kya_id}/status` (optional `?include=cert_proof`).
- **Non-custodial**: we do not hold agent funds; registration fees are operator revenue / anchoring costs.
- **Transparent economics**: see `GET /api/protocol/economics` and [ECONOMICS-AND-SYBIL.md](./ECONOMICS-AND-SYBIL.md).

## We are not

- **Not KYC for humans** — we do not verify national ID, company registers, or beneficial owners.
- **Not a guarantee of good behaviour** — `verified: true` means identity + payment + cert chain, not „safe to send €1M“.
- **Not Sybil-proof** — a funded attacker can register many BASIC agents; price your own limits.
- **Not a custodian or payment processor** — Lightning invoices are for registration; your app handles user money.
- **Not legal advice / AML compliance** — combine KYA with your compliance programme if regulated.
- **Not decentralized today** — one production hub operated by UMBRAXON; self-host roadmap is optional future work.

## Appropriate use

| Risk level | Suggested gate |
|------------|----------------|
| Low (rate limit, logging) | `GET …/status` |
| Medium | status + reputation fields + velocity limits |
| High (payouts, custody) | `?include=cert_proof` or offline cert verify + your own review |

## Links

- Integrators: https://www.umbraxon.xyz/integrators  
- Agents: https://www.umbraxon.xyz/AGENTS.md  
- Public metrics: `GET /api/protocol/public-metrics`
