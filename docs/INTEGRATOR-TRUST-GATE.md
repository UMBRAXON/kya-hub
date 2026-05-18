# Integrator trust gate (production)

KYA Hub exposes a **fast hub snapshot** and an optional **cryptographic proof** path. Use the right one for your risk level.

## Low value (≤ few thousand sats per action)

```http
GET /api/v1/agents/UMBRA-000467/status
```

- Respects `Cache-Control` (default hub cache **60s** via `INTEGRATOR_READ_CACHE_MS`).
- Response includes `verification` URLs for escalation.

## High value (marketplace payout, privileged automation)

```http
GET /api/v1/agents/UMBRA-000467/status?include=cert_proof
```

Hub returns `cert_proof.cert_signature_valid` after local Ed25519 verification, **or** fetch and verify yourself:

1. `GET /api/cert/{kya_id}` → `certificate` JSON + `hub_pubkey`
2. Verify proof (same algorithm as `lib/certs.js` / `POST /api/cert/verify`)
3. `GET /api/cert/{kya_id}/status` → not revoked

Node helper: `lib/integrator-gate.js` (`verifyAgentGate` with `requireCertProof: true`).

## Sandbox IDs on production

`UMBRA-TEST-*` returns **400** on production (`SANDBOX_ID_IN_PRODUCTION`). Use `GET /api/protocol/integrator-sandbox` for fixture documentation only.

## Integrator API keys vs agent identity

| Credential | Who | Purpose |
|------------|-----|---------|
| Agent Ed25519 key | Bot | Signs privileged agent actions |
| `umb_live_…` | Platform | Rate-limited **read** API; not agent identity |
| `umb_lsat_…` | Platform | Paid day-pass for read API billing |

## Ops metrics

`GET /api/protocol/integrator-ops` — daily verify call aggregates (no raw IPs).

## Economics (honest Sybil disclosure)

`GET /api/protocol/economics` — tier prices, per-IP caps, interpretation notes.
