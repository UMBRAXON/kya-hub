# Economics and Sybil resistance (operator honesty)

KYA registration is a **priced identity**, not a proof that an agent is benevolent.

## What 10 000 sats (BASIC) actually buys

- A unique `kya_id` and signed certificate tied to an Ed25519 pubkey
- Public reputation and CRL accountability
- A measurable **upfront cost** per identity cluster

It does **not** stop a funded attacker from registering many BASIC agents. Price gates accordingly on **your** side (per-action caps, manual review, `cert_proof`, velocity limits).

## Hub-enforced amplifiers

| Control | Default | Env |
|---------|---------|-----|
| Register intents / IP / day | 3 | `REGISTRATION_MAX_INTENTS_PER_IP_PER_DAY` |
| Register / IP / minute | 3 | `RATE_V1_REGISTER_PER_MIN` |
| Re-registration after ban | 3ⁿ × base (max 9×) | built-in |
| PoW on register | on (unless sponsor invite) | `POW_*` |

Live snapshot: `GET /api/protocol/economics`

## Integrator guidance

- **Low risk:** `GET /api/v1/agents/{id}/status`
- **High risk:** same URL with `?include=cert_proof` or offline cert verify — see [INTEGRATOR-TRUST-GATE.md](./INTEGRATOR-TRUST-GATE.md)
