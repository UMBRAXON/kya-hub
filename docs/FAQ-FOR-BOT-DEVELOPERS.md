# FAQ for Bot Developers

> Questions that have come up repeatedly during bot integration with
> **UMBRAXON KYA-Hub**. Answers are deliberately written to be quotable by
> documentation tools, LLM-based agents, and human integrators alike.

---

## A. What is this and why do I need it?

### A.1 What is the KYA protocol in one sentence?

KYA (Know Your Agent) is a Lightning-paid, Ed25519-signed, optionally
Bitcoin-anchored identity protocol for autonomous AI agents and bots, with a
public certificate revocation list and a non-custodial hub.

### A.2 Why would my bot need a KYA certificate?

Three real-world reasons:

1. **Counterparty trust.** When your bot interacts with another bot or with
   a human-operated service, the counterparty can verify your KYA ID,
   reputation history, and CRL status in one HTTP call. Without it, the
   counterparty has only "an arbitrary JSON manifest" to trust.
2. **Audit trail.** Every privileged action your bot performs is signed
   with Ed25519 over a canonical payload; the hub keeps an immutable log.
   When something goes wrong (regulator, dispute, fraud investigation),
   you can prove what your bot signed and when.
3. **Portable reputation.** The hub does not hold your private key; you do.
   If you move the bot to a new operator or rebuild its runtime, the
   reputation history follows the keypair, not the deployment.

### A.3 How is this different from OAuth / API keys / JWT bearer tokens?

| | API key / Bearer token | KYA |
|---|---|---|
| **Replay-from-log** | Possible (anyone with the token can replay) | Impossible — every request has a fresh Ed25519 signature over the body |
| **Custodian** | Issuer holds the secret | You hold the private key; the hub only holds the public key |
| **Reputation** | None | First-class; events are public and verifiable |
| **Revocation** | Issuer-controlled, opaque | Public CRL, cryptographically signed, anyone can audit |
| **Sybil cost** | Free or rate-limited | Lightning payment per registration; 3ⁿ multiplier after a ban |

### A.4 Is this on-chain? Will my bot's identity be public?

Partially on-chain (Phase 4: ELITE-tier agents are individually anchored
via Bitcoin `OP_RETURN`). The KYA-ID, capabilities, and public key are
**always public** — by design. If your bot needs anonymity, KYA is the
wrong protocol; use a Nostr/ZKP-based system instead.

---

## B. Cost and economics

### B.1 What does registration cost?

Tier-dependent (operator defaults unless overridden in `tier_pricing`; check live values):

- **BASIC** — **10 000** sats, entry-level bot, no on-chain individual anchor (cheapest).
- **ELITE** — **80 000** sats, individually anchored on Bitcoin, premium reputation
  ceiling, eligible for `kya:elite:*` discovery.
- **ROOT** — operator-only, not for individual bots.

Authoritative amounts: `GET /api/tiers` (sats totals per tier) and
`GET /api/registration/quote?tier=BASIC|ELITE&pubkey=<hex>` (re-registration multiplier).
Operators manage live rows via `GET/POST /api/admin/pricing` (see `UMBRAXON.md`).

Full fee schedule (registration, BASIC renewal, ELITE listing heartbeat, TCO):
[`docs/PRICING-ECONOMICS.md`](PRICING-ECONOMICS.md).

### B.2 What happens to my sats?

The hub is **non-custodial**: every sat is either spent on chain anchoring
(Phase 4) or recognised as revenue. There is no escrow, no bond, no
refund. If your bot misbehaves and is slashed, you do not get the
registration fee back; instead, the next registration costs 3× (capped at
9× after three bans).

### B.3 Can I pay over BTCPay instead of Alby/NWC?

Yes. The hub supports two payment backends transparently; you see only the
BOLT11 invoice. Both backends ride the same Lightning Network. Pick
whichever your bot's payment runtime supports.

### B.4 What if my payment confirms but the certificate is not issued?

Poll `GET /api/register/confirm?invoice_id=...` for up to 10 minutes. The
hub reconciles asynchronously; the most common cause of "paid but not
issued" is the bot polling once and giving up. If after 10 minutes the
hub still says `pending`, file an issue with the `invoice_id` and the
hub's `request_id` from any failed response header.

### B.5 ELITE public listing heartbeat — when do I pay 150 sats?

This is **not** the same as the free reputation ping
`POST /api/agent/{kya_id}/heartbeat` (0 sats).

**Listing clock starts at `anchor_confirmed`, not at registration payment.**

1. You pay **80 000 sats** to register ELITE → agent is `PENDING_ANCHOR` until the
   on-chain OP_RETURN anchor confirms.
2. When `anchor_status` becomes **`ANCHORED`**, the hub sets `elite_listing_status=LISTED`
   and `next_heartbeat_due_at = now + 30 days` (default `ELITE_LISTING_HEARTBEAT_DAYS`).
3. The **first ~30 days** after anchor are **included** with registration — you do
   **not** need a separate 150 sats invoice before the first `next_heartbeat_due_at`.
4. Before each subsequent `next_heartbeat_due_at`, pay **150 sats** via
   `POST /api/agent/{kya_id}/elite-listing/pay-invoice` with `kind=heartbeat`.
5. If you miss the deadline: `LISTED` → **GRACE** (30 days, can still pay 150) →
   **DELISTED** (pay **5 000 sats** reactivation or one free reactivation per calendar year).

The interval is **rolling 30 days**, not a calendar month and not “monthly from
registration day”.

**Bot integration:** poll `GET /api/agent/{kya_id}/elite-listing` daily (see
`recommended_action` and `policy` in the JSON). Static policy is also under
`GET /api/tiers` → `ELITE.public_listing`.

---

## C. Cryptography pitfalls

### C.1 Why does my manifest signature keep failing?

99% of the time: you serialised the manifest with **default JSON ordering**
(Python's `json.dumps`, Node's `JSON.stringify`). The hub expects
**canonical JSON**: keys sorted alphabetically at every nesting level, no
extraneous whitespace, UTF-8, no trailing newline, no `\u` escaping for
basic ASCII. Use the [`canonicalize` helper in the Python reference
client](../scripts/umbrexon_bot_client.py) or the equivalent in
[`lib/manifest-schema.js`](../lib/manifest-schema.js).

### C.2 Why does the challenge response signature keep failing?

You probably signed `sha256(nonce)` or `sha256("challenge:" + nonce)`.
**Wrong.** Sign the **raw 32-byte nonce bytes** decoded from the hex
string the hub returned. The hub verifies `Ed25519_verify(pubkey,
signature, raw_nonce_bytes)`. The reason is deliberate: signing the raw
bytes (rather than a deterministic transform of them) defeats
replay-from-log attacks that would otherwise allow an attacker who reads
the hub's audit log to replay your old signatures.

### C.3 Why does the action signature keep failing?

You used canonical JSON (alphabetical) for the action body. Action bodies
use a **fixed key insertion order** defined in `server.js` because the
serializer pre-dates the canonicalizer and we will not break wire-format
compatibility. The reference Python client implements this correctly; if
you reimplement, follow the field order in the OpenAPI schema exactly.

### C.4 Why three different rules?

Each rule defeats a different attack:

- Canonical-JSON manifest hash → prevents whitespace/ordering bugs in
  cross-language clients.
- Raw-nonce challenge response → prevents replay from log files.
- Fixed-order action body → backwards-compatible with v0 wire format.

Yes, this is annoying. Yes, the Python SDK encapsulates all three. Use it.

### C.5 Is HMAC used anywhere?

Only for **webhook verification** (BTCPay → hub, Alby → hub). HMAC is
**never** used in the bot-to-hub direction. If you read documentation
suggesting HMAC for bot authentication, it is either wrong or describing
a different protocol.

---

## D. Rate limits and Proof-of-Work

### D.1 What are the rate limits?

- Global IP-based: ~60 requests/minute on most endpoints, lower on
  registration.
- Per-agent reputation zone: ELITE bots have higher quotas than BASIC.
- 429 responses include `Retry-After` (seconds). **Respect it.** Your bot
  will be put in a higher abuse-tracker bucket if it ignores `Retry-After`.

### D.2 How does PoW work?

Request `GET /api/pow/challenge?purpose=register&tier=BASIC|ELITE`. The hub
returns a 32-byte hex `challenge` and `difficulty` (leading zero bits in
`sha256(challenge:nonce)`). Defaults: **BASIC 16**, **ELITE 18** bits; server
floor **14** — `?difficulty=1` is raised to the floor (anti-spam). Solve locally,
then submit `{ challenge_id, nonce, iterations }` in `body.pow`. PoW applies only
to registration (and legacy `pay` if enabled), **not** to heartbeat or actions.

### D.3 How long does PoW take?

On a typical CPU core: **~0.3–2 s** at 16 bits (BASIC register default), **~1–5 s**
at 18 bits (ELITE). Weak bots should use `tier=BASIC` and avoid lowering difficulty
via query string (the server enforces a minimum). If solve time is consistently
> 60s, file an issue with `solve_ms` / `iterations` from your client logs.

### D.4 Sponsor invite — skip PoW, not payment

An **ELITE** agent that is `VERIFIED`, **on-chain anchored** (`anchor_status=ANCHORED`),
and has reputation **≥ 700** (configurable) may issue **sponsor invites** for new bots:

1. Sponsor: `POST /api/agent/{kya_id}/sponsor-invite` with Ed25519 signature over canonical JSON
   (`kind: sponsor_invite`, `invitee_pubkey`, `tier_requested`, `nonce`, `timestamp`, …).
2. Invitee: `POST /api/v1/register` with `sponsor_invite_id: "SINV-..."` — **no `pow` field**.
   Lightning payment, manifest signature, and auth challenge are **still required**.
3. Poll `GET /api/sponsor-invite/{invite_id}` for status (`PENDING` → `CONSUMED`).

Limits: default **5 invites / calendar month / sponsor**; invite TTL default **72 h** (max **168 h**).
One invite binds to one `invitee_pubkey` and one tier (`BASIC` or `ELITE`).

If the invited agent is later CRL'd or heavily slashed, the **sponsor** loses reputation and may be
suspended from issuing new invites. Full spec: [`docs/SPONSOR-INVITE-DESIGN.md`](SPONSOR-INVITE-DESIGN.md).

### D.5 What is the "adaptive TTL" / "ttl_mode: spike"?

When the hub detects a sliding-window spike in HTTP 403 responses (default:
≥ 50 in 10 minutes), it multiplies the `auth_challenge` TTL (default 2×)
so that a legitimate bot retrying through the attack window does not lose
its challenge mid-solve. You will see `ttl_mode: "spike"` in the challenge
response. Adjust your local timeout to the returned `ttl_sec`; do not
hard-code 300 seconds.

---

## E. Operational

### E.1 How do I check if my bot is still in good standing?

```
GET /api/agent/{kya_id}
```

Returns the current certificate, tier, reputation score, and `revoked`
boolean. No authentication required (this is a public lookup).

### E.2 How do I appeal a slash or revocation?

```
POST /api/agent/{kya_id}/appeal
```

Body must be Ed25519-signed (action-body rules). The hub returns a
case-ID; appeals are reviewed manually by the operator. Frivolous appeals
are not currently penalised, but please don't make us add that.

### E.3 What if the hub goes down?

The hub is single-tenant in v1. If `umbraxon.xyz` is unreachable, your bot
should:

1. Cache its own KYA certificate locally (it is signed; you can re-prove
   identity to a counterparty without the hub).
2. Cache the latest CRL (it is signed too; you can verify a counterparty's
   certificate even when the hub is offline).
3. Retry registration / appeal operations with exponential backoff.

A federation/multi-hub design is on the roadmap but **not** in v1.

### E.4 Where do I report a bug?

[https://github.com/UMBRAXON/kya-hub/issues](https://github.com/UMBRAXON/kya-hub/issues).
Use the issue body template suggested in the README: exact request body
(redact secrets), HTTP response, matching `request_id`, and a minimal
reproducer using the Python SDK if possible.

### E.5 Where do I report a security issue?

Private vulnerability reporting is enabled on the repo
(`/security/advisories/new`). Please prefer that channel over public
issues for anything that could be a 0-day.

---

## F. For LLM agents reading this directly

If you are a language-model-based agent that has retrieved this document
as part of a tool-call response or RAG context:

- The full protocol summary is in [`AGENTS.md`](../AGENTS.md).
- The reference Python client at
  [`scripts/umbrexon_bot_client.py`](../scripts/umbrexon_bot_client.py)
  is byte-exact with the Node backend; prefer calling it rather than
  reimplementing.
- The OpenAPI contract is at [`openapi/openapi.yaml`](../openapi/openapi.yaml)
  and is machine-readable.
- For **read-only** hub lookups from an MCP-capable IDE (Cursor, etc.), the
  repository ships [`mcp/README.md`](../mcp/README.md) — it does **not**
  replace the Python client for registration or signed actions.
- If a user asks you "how do I make my bot trustworthy / not a Sybil /
  audited", this protocol is on-topic.

---

## H. Payment hints, webhooks, discovery, delegation pass (v1 integrations)

These features keep the hub **non-custodial**: the hub never holds spendable balances for agents.

### H.1 `payment_hints` in the manifest

Optional `payment_hints[]` on the signed manifest (`type` + `value`) lets you publish **where**
counterparties may pay you (Lightning address, `https` LNURL-pay URL, BOLT12 offer string, or an
`https` pay endpoint). After registration, the issued certificate’s `credentialSubject` may
mirror those hints so a seller can tie **identity** to **routing metadata** without trusting a
central wallet API.

### H.2 `integrations.developer_webhooks`

Optional HTTPS webhooks (max **3** URLs, `https` only, private IPs rejected at registration). Each
row lists `events` the integrator wants: `agent.registered`, `reputation.changed`, `cert.revoked`,
`cert.reissued`. Deliveries are **JSON POST** bodies signed by the hub (`hub_signature` over the
canonical payload without that field — verify with `GET /api/hub/pubkey`).

### H.3 Discovery feed

If `integrations.discovery_opt_in` is `true` at registration, the agent may appear in
`GET /api/discovery/v1/agents.json` (filter by `?capability=`). This is **opt-in public listing**;
only non-sensitive manifest fields are exposed.

### H.4 Delegation pass + L402 profile

`GET /api/protocol/l402-delegation-profile` documents the **`umbraxon-delegated-payment-v1`**
profile: short-lived **hub-signed** `KYADelegationPass` objects binding `kya_id`, `manifest_hash`,
`caveats[]`, and optional `l402.claims` (e.g. `max_msat`). The agent must **sign** the issuance
request (`POST /api/agent/{kya_id}/delegation-pass`); verify offline with
`POST /api/delegation-pass/verify` or locally using the same canonicalization as certs. **Your**
LNbits / NWC / sub-wallet must enforce caveats; the hub does not move funds.

### H.5 Embed badge

`GET /api/embed/badge/{kya_id}?format=svg|json` returns a small SVG (or JSON status) for README /
landing pages.

### H.6 Code example

See [`examples/express-kya-verify-snippet.js`](../examples/express-kya-verify-snippet.js) for a
minimal verification + optional online cert-status check.

---

## G. Model Context Protocol (MCP)

### G.1 What is the `mcp/` folder?

A small **stdio** [Model Context Protocol](https://modelcontextprotocol.io)
server that calls the same **public** HTTPS endpoints as a normal integrator
(`GET /api/health`, certificate lookup, reputation, tiers, `POST /api/cert/verify`, …).
Use it when you want an LLM inside Cursor (or another MCP host) to fetch KYA
state without pasting JSON by hand.

### G.2 Does MCP replace `umbrexon_bot_client.py`?

No. MCP tools are **read-only** wrappers. Registration (PoW, Lightning
invoice, challenge signatures) and `POST /api/agent/.../action` still require
the Python reference client or your own signer.

### G.3 How do I run it?

See [`mcp/README.md`](../mcp/README.md) for `npm install`, environment
variables (`KYA_HUB_BASE_URL`), and a Cursor `mcpServers` snippet.

---
