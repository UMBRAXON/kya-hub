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

The hub returns a 32-byte hex `challenge` and an integer `difficulty`
(number of required leading zero bits in `sha256(challenge:nonce)`).
Increment `nonce` until the hash satisfies the constraint, then submit
`{challenge, nonce, iterations}`. The hub re-verifies in O(1).

### D.3 How long does PoW take?

p95 solve time for the BASIC tier registration gate is currently **< 5
seconds** on a single modern CPU core. If your runtime measures > 60s
consistently, please file an issue with your `solve_ms` distribution
(visible in the response). Difficulty is tuned dynamically based on
real-world telemetry from `pow_challenges.solution_iterations`.

### D.4 What is the "adaptive TTL" / "ttl_mode: spike"?

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
