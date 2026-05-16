# KYA Hub — Pricing economics & fee model

> Internal operator reference (2026-05-16).  
> Live tier amounts: `GET /api/tiers`, `GET /api/registration/quote`, `lib/pricing.js`, `tier_pricing` table.

**Planning assumptions used below**

| Parameter | Value |
|-----------|--------|
| Operator OPEX | **100 € / month** (given) |
| BTC reference | **88 000 €** (planning; update quarterly) |
| 1 sat | **0,00088 €** |
| Target gross margin | **≥ 70 %** on fully loaded cost |
| On-chain feerate (typical) | **1–2 sat/vB** ([mempool.space](https://mempool.space)) |
| Anchor feerate cap (code) | **20 sat/vB** (`ANCHOR_MAX_FEERATE_SAT_VB`) |

---

## 1. SSL certificates (OV / EV) — not current prod cost

Production TLS today: **Let's Encrypt** via BTCPay/nginx (**0 €**).

If upgrading to commercial TLS (annual list prices, retail):

| Type | DigiCert | Sectigo (sectigostore.com) |
|------|----------|----------------------------|
| **OV** | ~218–372 USD/yr | ~99 USD/yr (1y), ~79 USD/yr (5y) |
| **EV** | ~344–540 USD/yr | ~99–199 USD/yr (PositiveSSL EV from ~99 USD/yr) |

Amortized monthly: **+8–17 €** (Sectigo OV/EV) or **+30–45 €** (DigiCert).

Sources: [DigiCert buy](https://www.digicert.com/buy), [Sectigo OV](https://sectigostore.com/ssl-types/ov-ssl-certificates), [PositiveSSL EV](https://sectigostore.com/ssl-certificates/positivessl-ev).

---

## 2. Bitcoin network fees (last ~30 days)

**Recommended now** ([mempool.space API](https://mempool.space/api/v1/fees/recommended)):

- `economyFee` / `hourFee`: **1 sat/vB**
- `fastestFee`: **2 sat/vB**

**Last month (block fee-rates, ~1m window):**

- Median in-block (`avgFee_50`): mostly **0–1 sat/vB**
- P90 in-block (`avgFee_90`): often **~2 sat/vB**
- Spikes (`avgFee_100`): short peaks to tens–hundreds sat/vB

**Planning for ELITE anchor** (`lib/anchor.js`, ~200 vB tx):

| Scenario | sat/vB | Anchor fee (approx.) |
|----------|--------|----------------------|
| Typical | 1–2 | **200–400 sats** |
| Conservative | 5 | **~1 000 sats** |
| Code cap | 20 | **~4 000 sats** |

Daily anchor budget guard: **`global:per_day_anchor_sats` = 50 000** (`lib/volumetric-limits.js`).

---

## 3. Infrastructure cost per registration (code path)

### Registration flow

| Step | BASIC | ELITE |
|------|-------|-------|
| `POST /api/v1/register` | PoW + challenge + manifest + DB intent + LN invoice | same |
| After LN payment | `registerAgent()` + `issueCertificate()` | + `pending_anchors` row |
| On-chain | none required | **OP_RETURN** anchor via `anchor-worker` |

### Variable cost per registration (excl. 100 € OPEX)

| Item | BASIC | ELITE |
|------|-------|-------|
| Inbound Lightning | ~0–5 sats | ~0–5 sats |
| Hub CPU/RAM (shared VPS) | negligible amortized | + anchor worker |
| On-chain anchor | **0** | **~200–4 000 sats** (see §2) |

### CPU / RAM estimate (one full registration)

| Phase | CPU (order of magnitude) | RAM (transient) |
|-------|--------------------------|-----------------|
| `/api/v1/register` | 30–80 ms | +10–30 MB |
| Webhook + `registerAgent()` + cert | 50–150 ms | +20–50 MB |
| ELITE anchor (async) | 20–60 ms + bitcoind RPC | outside request |

**Wall time:** often 0.3–1.5 s; **not** one dedicated machine per registration.

### Hypothetical AWS EC2 t3.micro (not production stack)

- ~**15 USD/month** (~14 €) — [eu-central-1 on-demand](https://www.cloudpricer.io/compute/aws/t3.micro)
- 2 vCPU burstable, 1 GiB RAM — **too small** for hub + BTCPay + bitcoind together
- Fixed cost per registration if *only* EC2: `14 € / N_regs`

---

## 4. Fully loaded pricing model (70 % margin)

Formula:

```
price_eur ≥ (OPEX_month / N_regs + variable_eur) / 0.30
price_sats = ceil(price_eur / 0.00088)
```

### Minimum price vs volume (100 € OPEX, variable ELITE ~0.50 €)

| N regs / month | BASIC min (sats) | ELITE min (sats) |
|----------------|------------------|------------------|
| 10 | ~38 000 | ~39 000 |
| 20 | ~19 000 | ~20 000 |
| 30 | ~12 700 | ~13 500 |
| 50 | ~7 600 | ~8 100 |
| 100 | ~3 800 | ~4 100 |

### Current code defaults

| Tier | Base (new reg) | Re-reg 1× ban (3×) | Re-reg 2+ (9× cap) |
|------|----------------|---------------------|---------------------|
| **BASIC** | **10 000** sats | 30 000 | 90 000 |
| **ELITE** | **80 000** sats | 240 000 | 720 000 |

Configured in: `lib/pricing.js`, `UMBRAXON.md`, `GET /api/registration/quote`.

### Operator recommendation (N ≈ 20–40 / month)

| Tier | Suggested | Rationale |
|------|-----------|-----------|
| BASIC | **12 000–15 000** sats | Covers OPEX at low N with ≥70 % margin |
| ELITE | **90 000–100 000** sats | Anchor spike buffer + value premium |

At **N = 30**, current **10k / 80k** yields ~**62 % / ~95 %** gross margin on fully loaded cost (BTC = 88k €).

---

## 5. Market affordability (bots / developers)

**USD reference** (BTC ≈ $95k): 10k sats ≈ **$9.50**, 80k sats ≈ **$76**.

### Comparison to typical agent spend

| Spend category | Typical range | KYA BASIC | KYA ELITE |
|----------------|---------------|-----------|-----------|
| LLM API (small prod agent) | $20–500 / month | — | — |
| Pay-per-call APIs (x402-style) | $0.002–0.30 / call | — | — |
| Agent budget vaults / policies | $10–100 / month caps | — | — |
| **KYA registration (one-time)** | — | **~$10** | **~$76** |
| **KYA ELITE listing / year** | — | — | **~$1.80** (12 × 150 sats) |

### Affordability verdict

| Persona | 10 000 sats BASIC | 80 000 sats ELITE |
|---------|-------------------|-------------------|
| **Hobby / PoC bot** | Affordable *if* dev has Lightning (NWC/Alby/LDK) | Stretch; usually serious projects only |
| **Commercial / SaaS agent** | **Very affordable** (< 1–2 h of API cost) | **Affordable** (< 1 day API cost) |
| **Enterprise compliance agent** | Trivial vs audit value | **Strong value** vs on-chain proof + discovery |

**Main barrier is not price** — it is **Lightning payment integration** (wallet, inbound liquidity, automated `pay_invoice`). Financially, tiers sit in the **micro-payment / identity** band, not infrastructure band.

**Adoption tip:** document `GET /api/registration/quote` + reference client; offer clear annual TCO:

- BASIC: ~10k sats/year (12-month cert, then re-register)
- ELITE: ~80k + ~1.8k sats/year listing heartbeats + optional 5k reactivation

---

## 6. All hub fees (complete schedule)

### A. Registration (one-time per identity period)

| Fee | Amount | Tier | Notes |
|-----|--------|------|-------|
| New registration | **10 000** sats | BASIC | 12-month `valid_until`; then cert expires |
| New registration | **80 000** sats | ELITE | Permanent tier; individual anchor |
| Re-registration multiplier | **3^n**, cap **9×** | both | After pubkey ban cooldown (`lib/registration-quote.js`) |

Quote before pay: `GET /api/registration/quote?tier=BASIC|ELITE&pubkey=<hex>`.

### B. BASIC renewal

- No separate “renewal invoice” endpoint.
- After **12 months**, certificate **`valid_until` expires** → status EXPIRED; bot must **register again** (full tier price, multiplier if banned).
- Effective **~10 000 sats / year** at default pricing.

### C. Reputation heartbeat (all tiers) — **FREE**

| Endpoint | Cost | Purpose |
|----------|------|---------|
| `POST /api/agent/:kya_id/heartbeat` | **0 sats** | Liveness, decay avoidance, loyalty bonus (`server.js`) |

Signed Ed25519; rate-limited. **Not** the same as ELITE listing fee.

### D. ELITE public listing (discovery / whitelist index only)

Env defaults (`lib/elite-listing.js`, `GET /api/tiers` → `ELITE.public_listing`):

| Fee | Default | When |
|-----|---------|------|
| **Listing heartbeat** | **150 sats** | Before each `next_heartbeat_due_at` while LISTED or GRACE (rolling **30** days) |
| **Reactivation** | **5 000 sats** | After **DELISTED** (missed grace window) |
| **Free reactivation** | **1× / calendar year** | `POST .../elite-listing/redeem-free` |

**Clock starts at `anchor_confirmed`, not registration payment.**  
After ANCHORED, the hub sets `LISTED` and `next_heartbeat_due_at = now + 30d`. The **first**
interval is **included** in the 80k registration (no 150 sats due before that date). This is
**not** a calendar month from registration day.

State machine: `LISTED` → (miss due) → `GRACE` (**30** days) → `DELISTED`.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/agent/:kya_id/elite-listing` | Status, `recommended_action`, `policy`, due dates |
| `POST /api/agent/:kya_id/elite-listing/pay-invoice` | LN invoice (`kind`: `heartbeat` \| `reactivation`) |
| `POST /api/agent/:kya_id/elite-listing/redeem-free` | One free reactivation / year |

**Bot poll:** `GET /api/agent/{kya_id}/elite-listing` about every **24 h** (see `policy.bot_integration`).

**BASIC agents:** no listing fees; not in public ELITE discovery index.

### E. Other (no extra hub fee)

- `POST /api/agent/:kya_id/action` — signed actions (rate limits only)
- `POST /api/agent/:kya_id/delegation-pass` — short-lived pass (no listed sats fee)
- PoW / auth challenges — no direct fee
- Appeals — no fee (manual review)

### F. Annual TCO cheat sheet (defaults, compliant ELITE)

| | BASIC | ELITE |
|---|-------|-------|
| Year 1 registration | 10 000 | 80 000 |
| Listing heartbeats (12×) | — | 1 800 |
| Reputation heartbeats | 0 | 0 |
| On-chain anchor (operator cost) | — | ~200–1 000 (usually « 2 €) |
| **Typical year-1 total (bot pays)** | **10 000 sats** | **~81 800 sats** |

---

## 7. Maintenance

- Update **BTC €** and mempool percentiles quarterly.
- Reconcile **N_regs/month** from DB: `SELECT date_trunc('month', payment_settled_at), tier, count(*) FROM agents ...`.
- After tier price changes: `POST /api/admin/pricing` + update `docs/FAQ-FOR-BOT-DEVELOPERS.md` §B.1.

---

## Related docs

- [`UMBRAXON.md`](../UMBRAXON.md) — tiers, ELITE listing, architecture
- [`FAQ-FOR-BOT-DEVELOPERS.md`](FAQ-FOR-BOT-DEVELOPERS.md) — integrator FAQ
- [`README_API.md`](../README_API.md) — M2M API index
- [`scripts/disk-cleanup.sh`](../scripts/disk-cleanup.sh) — safe OPEX disk hygiene
