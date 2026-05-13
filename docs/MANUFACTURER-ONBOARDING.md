# UMBRAXON KYA-Hub — Manufacturer Onboarding (Phase 4B)

This document describes how an **AI agent manufacturer** (a company that builds or
ships AI agents and wants UMBRAXON KYA-Hub to recognize them as a trusted issuer)
gets onboarded into KYA-Hub, and how they cryptographically pre-attest each agent
they produce so the agent inherits `manufacturer_verified = true` on registration.

- Audience: B2B partners + UMBRAXON KYA-Hub operators.
- Phase: 4B (DB-backed). Replaces the static `TRUSTED_MANUFACTURERS` env list.
- Crypto: Ed25519 over the canonical sha256 hash of the agent manifest.
- Status: live in production after migration `010_phase4b_manufacturers.sql`.

---

## 1. Onboarding flow (high level)

```
+-----------------+       1. KYC + admin register        +----------------+
|  Manufacturer   |  ---------------------------------> |   KYA-Hub      |
|  (Ed25519 KP)   |       (out-of-band proof, then       |   admin API    |
|                 |        POST /api/admin/manufacturer/ |                |
|                 |        register)                     |                |
+-----------------+                                       +----------------+
        |                                                          |
        |  status = PENDING                                         |
        |                                                          |
        |  2. Admin reviews KYC, calls verify                      |
        |  <----------------------------------------------------   |
        |   POST /api/admin/manufacturer/:mid/verify                |
        |  status = VERIFIED                                        |
        |                                                          |
        |  3. For each agent the mfr ships, build the manifest      |
        |     and sign sha256(canonical(manifest))                  |
        |                                                          |
        |  4. POST /api/manufacturer/attestation                    |
        |  -------------------------------------------------------->|
        |                                                          |
        |  5. Agent (separately) registers via                      |
        |     /api/register/initiate → /api/pay → settle.           |
        |     KYA-Hub matches the agent's manifest hash to the      |
        |     pre-attestation and consumes it (one-shot).           |
```

The manufacturer NEVER needs access to KYA-Hub signing keys. They authenticate
themselves with their own Ed25519 keypair, which KYA-Hub recorded during step 1.

---

## 2. Trust tiers

Manufacturers are assigned a tier at verification time, reflecting the depth of
KYC the operator performed:

| Tier   | Default rep bonus | Suggested KYC depth                              |
|--------|-------------------|---------------------------------------------------|
| BRONZE | +25               | Email-only; basic identity check.                |
| SILVER | +50               | Legal entity confirmed (registration / tax ID).  |
| GOLD   | +100              | Signed contract + ongoing reporting obligations. |

Defaults can be overridden via env vars `MFR_BONUS_BRONZE` / `MFR_BONUS_SILVER`
/ `MFR_BONUS_GOLD`. The selected tier is stored on the `manufacturers` row.

Per-tier weight in reputation calculations (Sybil resistance) follows
`lib/sybil-resistance.js` — `manufacturer_verified = true` agents get a 1.20x
reputation multiplier on top of the starting bonus.

---

## 3. Data model

### `manufacturers`

| Column                 | Notes                                           |
|------------------------|--------------------------------------------------|
| `id`                   | internal PK                                     |
| `manufacturer_id`      | external string, `^[A-Z0-9_]{2,64}$` (e.g. `UMBRAXON_LAB`) |
| `name`                 | display name                                    |
| `legal_entity`         | optional legal name                             |
| `country`              | ISO 3166-1 alpha-2                              |
| `contact_email`        | for operator                                    |
| `homepage`, `description` | optional public marketing fields              |
| `pubkey_ed25519`       | 32B hex, unique. Mfr's signing key.             |
| `status`               | `PENDING` / `VERIFIED` / `SUSPENDED` / `REVOKED` |
| `tier`                 | `BRONZE` / `SILVER` / `GOLD`                    |
| `rep_bonus`            | int, starting-score bonus applied per attested agent |
| `verified_at`, `verified_by` | audit                                    |
| `suspended_at`, `suspended_by`, `suspend_reason` | audit         |
| `revoked_at`, `revoked_by`, `revoke_reason`      | audit         |
| `kyc_metadata`         | free-form JSONB (operator notes)                |
| `attestation_count`, `agent_count` | counters maintained by app          |

### `manufacturer_attestations`

| Column                    | Notes                                          |
|---------------------------|-------------------------------------------------|
| `id`                      | BIGSERIAL PK                                    |
| `manufacturer_id`         | FK to `manufacturers.id`                        |
| `manufacturer_ext_id`     | denormalised string for fast lookup             |
| `agent_manifest_hash`     | sha256 hex of canonical agent manifest          |
| `expected_agent_pubkey`   | optional pin to lock the attestation to a specific bot |
| `expected_agent_name`     | optional pin                                    |
| `mfr_signature`           | Ed25519 64B hex of `agent_manifest_hash` bytes  |
| `attestation_metadata`    | free-form JSONB (model, sku, build_id, …)       |
| `attested_at`             | NOW() at submission                             |
| `expires_at`              | optional mfr-imposed validity window            |
| `agent_id`                | FK to `agents.id` once consumed                 |
| `consumed_at`             | when the agent registered using this attestation |
| `revoked_at`, `revoked_by`, `revoke_reason` | for compromise / mistake handling |

Uniqueness: `(manufacturer_id, agent_manifest_hash)`. Re-submitting the same
(mfr, hash) tuple is an idempotent **upsert**.

---

## 4. API reference

All admin endpoints require the `X-Admin-Key` header (and may include an
`X-Admin-User` audit header). All public endpoints accept JSON.

### 4.1 Admin: register a manufacturer

```http
POST /api/admin/manufacturer/register
X-Admin-Key: <admin_api_key>
Content-Type: application/json

{
  "manufacturer_id": "ACME_BOTS",
  "name": "ACME Bots, Inc.",
  "pubkey": "<32B-hex-ed25519-pubkey>",
  "tier": "SILVER",
  "legal_entity": "ACME Bots GmbH",
  "country": "DE",
  "contact_email": "ops@acme-bots.example",
  "homepage": "https://acme-bots.example",
  "description": "Industrial automation agents.",
  "kyc_metadata": { "kyc_ref": "ZK-2026-0001" }
}
```

Returns `{ ok: true, manufacturer: { ..., status: "PENDING" } }`.

### 4.2 Admin: verify / suspend / revoke / list attestations

```
POST /api/admin/manufacturer/:manufacturer_id/verify
POST /api/admin/manufacturer/:manufacturer_id/suspend     { reason: "..." }
POST /api/admin/manufacturer/:manufacturer_id/revoke      { reason: "..." }
GET  /api/admin/manufacturer/:manufacturer_id/attestations?limit=50&offset=0
POST /api/admin/manufacturer/attestation/:id/revoke       { reason: "..." }
```

### 4.3 Public: list verified manufacturers

```http
GET /api/manufacturers?limit=50&offset=0
```

```json
{
  "count": 3,
  "total": 3,
  "limit": 50,
  "offset": 0,
  "manufacturers": [
    {
      "manufacturer_id": "ACME_BOTS",
      "name": "ACME Bots, Inc.",
      "pubkey": "...",
      "status": "VERIFIED",
      "tier": "SILVER",
      "rep_bonus": 50,
      "attestation_count": 12,
      "agent_count": 9
    }
  ]
}
```

### 4.4 Public: single manufacturer

```http
GET /api/manufacturer/:manufacturer_id
```

Returns the public projection if status=VERIFIED. PENDING/SUSPENDED/REVOKED
manufacturers return 404 to non-admin callers.

### 4.5 Public: submit a pre-attestation

```http
POST /api/manufacturer/attestation
Content-Type: application/json

{
  "manufacturer_id": "ACME_BOTS",
  "manifest": { ...full agent manifest, v1.0 schema... },
  "mfr_signature": "<128-hex-chars Ed25519 sig of sha256(canonical(manifest))>",
  "expected_agent_pubkey": "<32B-hex>",
  "expected_agent_name": "acme-trader-001",
  "attestation_metadata": { "model": "gpt-4o", "build_id": "B-2026-05" },
  "expires_at": "2026-12-31T23:59:59Z"
}
```

Returns:

```json
{
  "ok": true,
  "attestation_id": 42,
  "manufacturer_id": "ACME_BOTS",
  "manufacturer_pubkey": "...",
  "manifest_hash": "9ee4826bb...",
  "attested_at": "2026-05-12T14:35:00.000Z",
  "consumed": false,
  "revoked": false
}
```

Error codes (HTTP / body `error` field):

| Status | `error`                       | Meaning                          |
|--------|-------------------------------|----------------------------------|
| 400    | `MISSING_MANIFEST`            | request body lacks `manifest`    |
| 400    | `MANIFEST_INVALID`            | manifest fails v1.0 schema       |
| 400    | `INVALID_SIGNATURE_FORMAT`    | sig not 64B hex                  |
| 400    | `INVALID_EXPECTED_PUBKEY`     | pin pubkey not 32B hex           |
| 400    | `INVALID_EXPIRES_AT`          | bad ISO timestamp                |
| 401    | `BAD_MFR_SIGNATURE`           | Ed25519 verify failed            |
| 403    | `MANUFACTURER_NOT_VERIFIED`   | mfr is PENDING/SUSPENDED/REVOKED |
| 404    | `MANUFACTURER_NOT_FOUND`      | unknown `manufacturer_id`        |
| 429    | `RATE_LIMITED`                | too many submissions per minute  |

---

## 5. Canonical hash & signature

The `manifest_hash` is computed by `lib/manifest-schema.js`:

```
manifest_hash = sha256( canonical_json(manifest) )
canonical_json = key-sorted, no whitespace, UTF-8 encoded
```

The manufacturer signs the **raw 32 bytes** of `manifest_hash` (NOT the hex
string) using their Ed25519 private key:

```
mfr_signature = Ed25519.sign( sk_mfr, manifest_hash_bytes )
```

KYA-Hub verifies the signature against the registered `pubkey_ed25519`.

> Note: The bot's own signature on its manifest (sent during
> `/api/register/initiate`) is independent of the mfr signature. Both are
> verified; the mfr signature proves provenance, and the bot signature proves
> possession of the bot's pubkey.

---

## 6. Reference signer code

### 6.1 Node.js

```js
const crypto = require('crypto');
const axios  = require('axios');

// Load mfr Ed25519 private key (PKCS8 DER hex or PEM) you stored during onboarding.
const skPem = require('fs').readFileSync('mfr-ed25519.pem');
const sk = crypto.createPrivateKey(skPem);

const manifest = {
    protocol_version: '1.0',
    agent: {
        name: 'acme-trader-001',
        version: '1.0.0',
        pubkey: '<32B-hex-bot-pubkey>',
        capabilities: ['payments', 'spot_trading'],
        model: 'gpt-4o',
        runtime: 'node-22',
        description: 'ACME spot-trader bot',
    },
    tier_requested: 'BASIC',
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex'),
};

// Canonicalise (key-sorted, no spaces) and hash
function canonical(o) {
    if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
    if (o && typeof o === 'object') {
        return '{' + Object.keys(o).sort().map(k =>
            JSON.stringify(k) + ':' + canonical(o[k])
        ).join(',') + '}';
    }
    return JSON.stringify(o);
}
const hashBytes = crypto.createHash('sha256').update(canonical(manifest)).digest();
const mfr_signature = crypto.sign(null, hashBytes, sk).toString('hex');

await axios.post('https://hub.umbraxon.xyz/api/manufacturer/attestation', {
    manufacturer_id: 'ACME_BOTS',
    manifest,
    mfr_signature,
    expected_agent_pubkey: manifest.agent.pubkey,
    expected_agent_name: manifest.agent.name,
});
```

### 6.2 Python (cryptography)

```python
import json, hashlib, requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sk: Ed25519PrivateKey = serialization.load_pem_private_key(
    open('mfr-ed25519.pem','rb').read(), password=None
)

manifest = {
    "protocol_version": "1.0",
    "agent": {
        "name": "acme-trader-001",
        "version": "1.0.0",
        "pubkey": "<32B-hex-bot-pubkey>",
        "capabilities": ["payments", "spot_trading"],
        "model": "gpt-4o",
        "runtime": "python-3.12",
        "description": "ACME spot-trader bot",
    },
    "tier_requested": "BASIC",
    "timestamp": "2026-05-12T14:00:00Z",
    "nonce": "00112233445566778899aabbccddeeff",
}

canon = json.dumps(manifest, sort_keys=True, separators=(',',':')).encode()
hash_bytes = hashlib.sha256(canon).digest()
mfr_signature = sk.sign(hash_bytes).hex()

resp = requests.post('https://hub.umbraxon.xyz/api/manufacturer/attestation', json={
    "manufacturer_id": "ACME_BOTS",
    "manifest": manifest,
    "mfr_signature": mfr_signature,
    "expected_agent_pubkey": manifest["agent"]["pubkey"],
    "expected_agent_name": manifest["agent"]["name"],
})
print(resp.status_code, resp.json())
```

### 6.3 CLI one-liner (curl) – debug / ops use

```bash
# 1. canonicalise manifest with jq -S
canon=$(jq -Sc . manifest.json)
# 2. hash
echo -n "$canon" | sha256sum | awk '{print $1}' > /tmp/h.hex
# 3. sign (using openssl with raw Ed25519 sk)
xxd -r -p /tmp/h.hex > /tmp/h.bin
openssl pkeyutl -sign -rawin -in /tmp/h.bin \
    -inkey mfr-ed25519.pem -out /tmp/sig.bin
sig=$(xxd -p -c 256 /tmp/sig.bin)
# 4. submit
jq -nc --argjson m "$(<manifest.json)" \
       --arg mid "ACME_BOTS" --arg sig "$sig" \
       '{manufacturer_id:$mid, manifest:$m, mfr_signature:$sig}' \
| curl -sS -H 'Content-Type: application/json' -d @- \
    https://hub.umbraxon.xyz/api/manufacturer/attestation
```

---

## 7. Agent registration: how the attestation is consumed

1. The bot calls `POST /api/register/initiate` with its full manifest + its
   own Ed25519 signature.
2. KYA-Hub computes `manifest_hash` (identical canonical scheme) and looks up
   `manufacturer_attestations` for any usable row matching that hash with:
   - `agent_id IS NULL` (not yet consumed)
   - `revoked_at IS NULL`
   - `expires_at IS NULL OR expires_at > NOW()`
   - parent mfr `status = 'VERIFIED'`
   - optional pubkey / name pins satisfied
3. If found, the agent is registered with:
   - `manufacturer_verified = true`
   - `manufacturer_id = <mfr_ext_id>`
   - `mfr_attestation_id = <attestation.id>` (forensic pointer)
   - `mfr_tier = <BRONZE|SILVER|GOLD>`
   - starting reputation `= base + mfr.rep_bonus` (capped by reputation engine)
4. After the agent's payment settles and the agent row is INSERTed, the
   attestation row is updated:
   - `agent_id = <new agent.id>`
   - `consumed_at = NOW()`
   - `manufacturers.agent_count = agent_count + 1`

If no usable attestation is found, the legacy in-manifest path (env-var
`TRUSTED_MANUFACTURERS`) is still consulted as a fallback for backward
compatibility.

---

## 8. Operator playbook

### 8.1 Onboard a new manufacturer

1. Collect KYC documents out-of-band (legal entity, contact, ID of person
   holding the signing key).
2. Have the partner generate an Ed25519 keypair on **their** side (we never
   touch the private key). Acceptable formats: PEM (PKCS8) or raw 32B hex.
3. Call `POST /api/admin/manufacturer/register` with their public key + tier.
4. Review the `manufacturers` row in DB:
   `SELECT * FROM manufacturers WHERE manufacturer_id = 'ACME_BOTS';`
5. Call `POST /api/admin/manufacturer/:mid/verify` to promote to `VERIFIED`.

### 8.2 Rotate a manufacturer's signing key

KYA-Hub stores **one** public key per manufacturer. To rotate:

1. Register a NEW manufacturer record with a different `manufacturer_id` and
   the new pubkey. Old + new can coexist during the transition.
2. Verify the new record.
3. Suspend the old record once the partner confirms migration: `POST
   /api/admin/manufacturer/:old_mid/suspend { "reason": "key rotated" }`.

(Hot in-place key swap is intentionally not supported; suspended -> new is
auditable.)

### 8.3 Compromise response

If a manufacturer's signing key is suspected to be compromised:

1. **Immediately** `POST /api/admin/manufacturer/:mid/suspend` to freeze new
   attestations.
2. Audit unconsumed attestations:
   ```sql
   SELECT id, agent_manifest_hash, expected_agent_pubkey, attested_at
   FROM manufacturer_attestations
   WHERE manufacturer_ext_id = 'ACME_BOTS'
     AND agent_id IS NULL AND revoked_at IS NULL;
   ```
3. For any suspect attestations, `POST
   /api/admin/manufacturer/attestation/:id/revoke`.
4. For consumed (i.e. already a live agent) attestations originating from the
   compromised key, optionally revoke those agents via the existing
   `POST /api/admin/agent/:kya_id/revoke` flow (this also feeds into the CRL
   Merkle anchor — see Phase 5).
5. Once the new key is ready, follow the rotation steps in 8.2.

### 8.4 Default rep_bonus per tier (override via env)

```bash
MFR_BONUS_BRONZE=25
MFR_BONUS_SILVER=50
MFR_BONUS_GOLD=100
```

Per-manufacturer overrides are not currently supported via API; set the bonus
indirectly by choosing the appropriate tier at verify time.

---

## 9. Test harness

`scripts/test-manufacturer-flow.js` exercises the full flow end-to-end against
a running hub:

```bash
node scripts/test-manufacturer-flow.js                 # cleans up after itself
node scripts/test-manufacturer-flow.js --no-cleanup    # keep rows for inspection
KYAHUB_BASE_URL=https://hub.umbraxon.xyz node scripts/test-manufacturer-flow.js
```

The test:

1. Generates a throwaway Ed25519 keypair.
2. Registers a `KYA_TEST_<rand>` manufacturer.
3. Verifies, then submits an attestation, then idempotency-replays it.
4. Tampers with the signature and asserts 401 `BAD_MFR_SIGNATURE`.
5. Verifies DB row state.
6. Tests `findUsableAttestation`, suspend/verify cycle, attestation revoke.
7. Cleans up (hard-DELETE via privileged DB user if `DB_ADMIN_USER` /
   `DB_ADMIN_PASSWORD` are exported, otherwise soft-cleanup via the revoke API).

Successful run reports `PASS: 39  FAIL: 0`.

---

## 10. Migration notes

`migrations/010_phase4b_manufacturers.sql` is idempotent; safe to re-run. It:

- creates `manufacturers` + `manufacturer_attestations`
- adds `registration_intents.mfr_attestation_id` and `mfr_tier`
- adds `agents.mfr_attestation_id` and `mfr_tier`
- grants `SELECT / INSERT / UPDATE` (NOT DELETE) on the new tables to
  `kyahub_app`. Hard-delete of mfr/attestation rows requires a privileged DB
  user; production uses soft-delete (`status=REVOKED`, `revoked_at=NOW()`).

---

## 11. Open improvements (deferred)

- Per-mfr rate limits (currently one global limiter for the attestation route).
- Per-attestation usage limits (e.g. allow one mfr key to back N agents per
  day).
- Public Merkle root of the manufacturer registry (cross with Phase 5 CRL
  anchor for transparency).
- Self-service mfr portal (today everything goes through the admin API).
