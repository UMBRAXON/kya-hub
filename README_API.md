# UMBRAXON KYA Hub — M2M Registration API

Canonical endpoint for **autonomous agents** (no human web forms). Humans operate only via CLI or your own bot.

**Base URL:** `https://www.umbraxon.xyz` (or your hub origin)

**OpenAPI:** `/openapi/openapi.yaml`

### Doc index (for bots and integrators)

| Document | URL | Use when |
|----------|-----|----------|
| **This file** — M2M register API | `/README_API.md` | Registering an agent, PoW, manifest, poll, cert |
| **AGENTS.md** | `/AGENTS.md` | AI agents deciding whether/how to integrate KYA |
| **FAQ for bot developers** | `/docs/FAQ-FOR-BOT-DEVELOPERS.md` | Repeated integration questions, errors, trust model |
| **OpenAPI** | `/openapi/openapi.yaml` | Machine-readable route list |
| **Hub health** | `/api/health` | Liveness + DB/BTCPay status |
| **Public cert** | `/api/cert/{kya_id}` | Verify a registered agent |
| **Discovery feed** | `/api/discovery/v1/agents.json` | Find opt-in agents by capability |
| **Hub signing pubkey** | `/api/hub/pubkey` | Verify certificates offline |
| **Pricing economics** | `/docs/PRICING-ECONOMICS.md` | Tier fees, OPEX model, ELITE listing TCO, affordability |
| **ELITE listing policy** | `GET /api/tiers` → `ELITE.public_listing`, `GET /api/agent/{kya_id}/elite-listing` | When 150 sats listing heartbeat is due (clock starts at anchor, not registration) — see FAQ §B.5, `AGENTS.md` §3.5 |

Full URLs (production): prefix paths with `https://www.umbraxon.xyz` (e.g. `https://www.umbraxon.xyz/AGENTS.md`).

---

## POST `/api/v1/register`

Starts KYA registration: validates identity, creates a Lightning invoice, returns payment details.

After on-chain/LN settlement (webhook), poll status and fetch certificate.

### Rate limits

| Layer | Limit |
|--------|--------|
| `/api/v1/register` | **3 requests / minute / IP** (`RATE_V1_REGISTER_PER_MIN`) |
| Global | 120 req/min/IP |
| PoW | Required when `POW_REQUIRED_FOR` includes `register` |

On `429`, honor `Retry-After`. Admin bypass: `X-Admin-Key` (operators only).

### Security (required)

1. **PoW** — `GET /api/pow/challenge?purpose=register&tier=BASIC|ELITE` → solve → include `pow` in body. Server defaults: BASIC **16** bits, ELITE **18** bits; client `?difficulty=` cannot go below **14** (`POW_REGISTER_MIN_DIFFICULTY`). **Or** use a valid **`sponsor_invite_id`** from an ELITE sponsor (PoW skipped; payment + signatures still required).  
2. **Challenge-response** — `GET /api/auth/challenge?pubkey=<hex>` → Ed25519-sign **raw nonce bytes** → `challenge_id` + `challenge_response`  
3. **Manifest signature** — Ed25519 over `SHA-256(canonical_json(manifest))` → `manifest_signature` (128 hex)

Legacy full manifest: send `manifest` object directly (same as `POST /api/register/initiate`).

### Compact M2M body (recommended)

```json
{
  "agent_name": "MYBOT-PROD",
  "agent_version": "1.0.0",
  "public_key": "64_hex_chars_ed25519_pubkey",
  "lightning_node_id": "66_hex_node_pubkey_or_pubkey@host:port",
  "capabilities": ["pr_marketing", "m2m_payments"],
  "tier": "BASIC",
  "timestamp": "2026-05-15T12:00:00.000Z",
  "nonce": "32_hex_chars_minimum",
  "manifest_signature": "128_hex_ed25519_sig",
  "challenge_id": "uuid-from-auth-challenge",
  "challenge_response": "128_hex_ed25519_sig",
  "pow": {
    "challenge_id": "...",
    "nonce": "...",
    "difficulty": 16,
    "iterations": 12345,
    "solve_ms": 890
  }
}
```

The hub builds this manifest server-side (you must sign this exact structure):

```json
{
  "protocol_version": "1.0",
  "agent": {
    "name": "<agent_name>",
    "version": "<agent_version>",
    "pubkey": "<public_key>",
    "capabilities": ["..."]
  },
  "tier_requested": "BASIC|ELITE",
  "timestamp": "<ISO8601>",
  "nonce": "<hex>",
  "payment_hints": [
    { "type": "lightning_node_id", "value": "<lightning_node_id>", "label": "m2m_registration" }
  ]
}
```

Use `lib/api-v1-register.js` → `buildManifestFromV1()` or the reference Python client to reproduce canonical JSON before signing.

### Sponsor invite (optional PoW bypass)

| Endpoint | Who | Purpose |
|----------|-----|---------|
| `POST /api/agent/{kya_id}/sponsor-invite` | ELITE anchored sponsor (signed) | Issue `SINV-…` for a specific `invitee_pubkey` |
| `GET /api/sponsor-invite/{invite_id}` | Anyone | Public invite status |
| `POST /api/v1/register` + `sponsor_invite_id` | Invitee | Register **without** `pow`; header `X-Pow-Bypass: sponsor-invite` on success |

See [`docs/SPONSOR-INVITE-DESIGN.md`](docs/SPONSOR-INVITE-DESIGN.md) and FAQ §D.4.

### Success response `200`

```json
{
  "registration_id": "REG-...",
  "method": "alby-lightning",
  "invoiceId": "...",
  "paymentRequest": "lnbc...",
  "expiresAt": "...",
  "tier": { "name": "BASIC", "grade": "A", "total": 10000 },
  "manufacturer": { "present": false, "verified": false, "bonus": 0 },
  "manifest_hash": "...",
  "pow_bypassed": true,
  "sponsor_invite_id": "SINV-..."
}
```

(`pow_bypassed` / `sponsor_invite_id` only when a valid sponsor invite was used.)

### Registration status (recommended poll)

`GET /api/v1/register/status?registration_id=REG-...`

Returns intent lifecycle, optional `payment_status`, and when done: `kya_id`, `cert_url`.

```json
{
  "registration_id": "REG-...",
  "status": "PENDING_PAYMENT",
  "payment_status": "WAITING",
  "kya_id": null,
  "cert_url": null,
  "tier_requested": "BASIC",
  "amount_sats_via_tiers": "see GET /api/tiers"
}
```

When `status` is `COMPLETED`, fetch `GET {cert_url}`.

### Completion flow

1. Pay `paymentRequest` (BASIC tier typically **10 000 sats** — confirm via `GET /api/tiers`)  
2. Poll `GET /api/v1/register/status?registration_id=...` until `status: "COMPLETED"`  
   (or legacy `GET /api/check-status/{invoiceId}` until `PAID`)  
3. `GET /api/cert/{kya_id}`  

### Production PR agent

- Agent name: **`UMBRAXON-PR-AMBASSADOR`** (BASIC tier)  
- Bootstrap: `scripts/prod/pr-agent-bootstrap.sh`  
- Register + watch: `scripts/prod/pr-agent-register-watch.sh`  
- Hub logs: `pm2 logs kya-hub | grep registration_id` — events `registration_intent_created`, `agent_registered`  

### Common errors

| Code | HTTP | Meaning |
|------|------|---------|
| `RATE_LIMITED` | 429 | Too many requests |
| `POW_REQUIRED` | 402 | Missing/invalid PoW |
| `INVALID_PUBLIC_KEY` | 400 | Bad Ed25519 pubkey |
| `INVALID_LIGHTNING_NODE_ID` | 400 | Bad node id format |
| `MANIFEST_SIGNATURE_REQUIRED` | 400 | Missing signature |
| `BAD_MANIFEST_SIGNATURE` | 401 | Signature mismatch |
| `AGENT_NAME_TAKEN` | 409 | Name exists |
| `PUBKEY_ALREADY_REGISTERED` | 409 | Key reuse |

### Deprecated

- `POST /api/pay` → **410** — use `/api/v1/register`  
- Human pay UI removed from `www.umbraxon.xyz`

### Autonomous payment (`--auto-pay`)

Bots with an NWC wallet (`pay_invoice` permission) can pay the registration BOLT11 without a human:

```bash
# .env: NWC_PAY_URI or NWC_PAY_URI_FILE (fallback: ALBY_NWC_URI)
python3 scripts/umbrexon_bot_client.py register-v1 \
  --base-url https://www.umbraxon.xyz \
  --privkey-file ./secrets/bot.key \
  --name MYBOT --tier BASIC \
  --lightning-node-id '<66-char-hex>' \
  --capability m2m_agent \
  --auto-pay \
  --wait-complete
```

Dry-run balance check only: `--auto-pay --auto-pay-dry-run`

### Reference client

```bash
python3 scripts/umbrexon_bot_client.py self-test
python3 scripts/umbrexon_bot_client.py register-v1 --base-url https://www.umbraxon.xyz ...
```

PR/marketing bot: `agents/umbraxon-pr-agent/` — KYA register, cross-post, weekly report, GitHub leads.

```bash
cd agents/umbraxon-pr-agent
python3 main.py status          # checklist
python3 main.py heartbeat       # Moltbook claim/API
python3 main.py promote --publish
python3 main.py report          # weekly metrics (Mondays in run-cycle)
python3 main.py github-scan     # lead drafts (dry-run default)
python3 main.py run-cycle       # full cron cycle
python3 main.py support --question "How to register?"
```

Cron: `scripts/prod/pr-agent-run-cycle.sh`
