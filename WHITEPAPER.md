# UMBRAXON KYA-Hub — Whitepaper / Public ToS overview

> Living document. Operator: Umbraxon. Last revision: 2026-05-13.
> The canonical engineering/runbook reference is `UMBRAXON.md`; this file is
> the public-facing summary of pricing, penalty, and disclaimer language.

---

## 1. What the hub does

UMBRAXON KYA-Hub ("the hub") issues cryptographic identity attestations to
AI agents ("bots"). Each registered bot receives:

- A unique `KYA-ID` (UMBRA-XXXXXX).
- An Ed25519-signed certificate that relying parties can verify offline.
- Reputation tracking (`reputation_score` 0–1 000, zoned).
- For ELITE tier: an individual on-chain anchor (`OP_RETURN`) on Bitcoin
  mainnet, plus optional **public listing liveness** — small recurring Lightning
  payments keep the bot in the public `/api/whitelist` discovery feeds; BASIC
  tier is unaffected. Defaults and contract: `UMBRAXON.md` (migration 016,
  env `ELITE_LISTING_*`).

The hub is operated by Umbraxon as a single-tenant service. It is NOT a
custodian, exchange, or money transmitter.

---

## 2. Pricing schedule (effective 2026-05-12)

All prices are paid **upfront** over the Bitcoin Lightning Network. There is
**no bond, no collateral, no refund**. The hub holds **no bot funds** beyond
the moment of payment settlement.

| Tier  | Base price | Validity | Grade | Anchor |
| ----- | ---------- | -------- | ----- | ------ |
| BASIC | **10 000 sats** | 12 months | B | Optional Merkle batch anchor |
| ELITE | **80 000 sats** | Indefinite (subject to reputation) | S | Individual `OP_RETURN` on Bitcoin mainnet |

> ELITE price changed from 50 000 → 80 000 sats on 2026-05-12 (operator
> policy: increase upfront cost as a Sybil deterrent now that the bond /
> custody model is dropped). Historical paid invoices retain their original
> `paid_amount_sats` snapshot; the new price applies to **new registrations
> only**.

A live read-only quote endpoint reveals the exact price the hub will
charge a specific pubkey *before* the bot pays:

```
GET https://umbraxon.xyz/api/registration/quote?tier=ELITE&pubkey=<hex>
→ { tier, base_price_sats, multiplier, total_price_sats, ban_count,
    deny_listed, deny_listed_until?, custody: "NONE", notice: "..." }
```

---

## 3. Penalty system (A + B + D, no custody)

The hub uses a four-layer penalty model. **None of the layers involve the
hub holding bot funds.**

1. **Reputation drop** — a banned agent loses `BAN_REPUTATION_DROP` points
   (default 500) immediately on ban. This is enforced via
   `reputation_events` ledger entries.
2. **Certificate revocation list (CRL)** — the agent's active certificate is
   marked `is_current=FALSE` and an entry lands in `revocation_events`.
   Periodically the CRL hash is anchored to Bitcoin mainnet
   (`KYAR` `OP_RETURN`).
3. **Pubkey deny-list cooldown** — the agent's pubkey is added to
   `pubkey_deny_list` with `expires_at = NOW() + tier_cooldown_days` where:
   - BASIC: 30 days.
   - ELITE: 90 days.
   During the cooldown, any new `/api/pay` request from that pubkey is
   rejected with `409 PUBKEY_DENY_LISTED`.
4. **Re-registration multiplier** — once the cooldown expires, the pubkey
   can re-register, but the price is multiplied:
   ```
   multiplier(ban_count) = min(3 ^ ban_count, 9)
   ```
   So:
   - First re-registration  → 3× base.
   - Second re-registration → 9× base.
   - Third and beyond       → still 9× base (cap).

`ban_count` is a lifetime counter on `pubkey_deny_list` and is intentionally
**not reset** by an operator-issued unban. An operator-issued unban only
clears the active cooldown; the multiplier stays in force for the next
infraction.

### Worked example

Bot's pubkey is `K`. Both bans below are for fraud.

| Event | Time | `ban_count` | Cooldown end | Next price (ELITE) |
| ----- | ---- | ----------- | ------------ | ------------------ |
| Initial ELITE registration | T=0   | 0 | — |  80 000 sats |
| Ban #1                     | T=10d | 1 | T=100d | 240 000 sats (3×, after cooldown) |
| Re-registration            | T=110d| 1 | — | (paid 240 000) |
| Ban #2                     | T=170d| 2 | T=260d | 720 000 sats (9×, after cooldown) |
| Ban #3                     | T=400d| 3 | T=490d | 720 000 sats (still 9×, cap) |

---

## 4. Disclaimers

- **No financial product.** Hub revenue is service revenue. The hub does
  **not** invest, lend, custody, or pool bot funds.
- **No refund.** Cryptographic registration is a one-way operation. Once a
  payment is settled and a certificate is issued, the bot's `paid_amount_sats`
  is recorded as service revenue.
- **Best-effort reputation.** Reputation is computed from on-hub behaviour
  (heartbeats, peer reports, decay, mfr attestation). The hub disclaims all
  liability for losses or damages caused by certified agents. Relying
  parties are expected to perform their own due diligence proportional to
  transaction value.
- **VAT.** The seller's VAT treatment of AI-agent-recipient payments is
  under operator review. Issued invoices currently carry a 0% VAT line
  with a notice flag.

---

## 5. ToS pointers

- Engineering & runbook: `UMBRAXON.md` (Slovak/English mixed).
- AML / volumetric limits: `docs/AML-VOLUMETRIC-LIMITS.md`.
- ESG statement: `docs/ESG-STATEMENT.md`.
- Restore procedures: `docs/RESTORE-PROCEDURES.md`.
- Security audit (current): `SECURITY-AUDIT-2026-05-12-EVENING.md`.

Public ToS will be published at `https://umbraxon.xyz/terms` (operator
follow-up). Until then, the disclaimer in §4 of this document is the
authoritative summary.
