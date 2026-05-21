# ADR-001: Multi-hub federation (read path first)

**Status:** Accepted (design) · **Implementation:** Phase P2.5+  
**Date:** 2026-05-19

## Context

Production today is a **single operator hub** (`www.umbraxon.xyz`). Integrators call one origin. This creates trust concentration and operator bus factor — documented in [`WHAT-WE-ARE-NOT.md`](../WHAT-WE-ARE-NOT.md).

Market need: portable **KYA-ID** + cert chain that survives hub politics, without forcing every integrator to trust one Postgres.

## Decision

Adopt a **federation model in phases**:

1. **Phase A (now):** Each cert includes `hub_id` + `hub_url` in issuer metadata; integrators MAY pin a hub URL.
2. **Phase B:** Read-only **mirror** endpoints (`GET /api/v1/agents/{id}/status`) on a second host that caches signed snapshots (no registration).
3. **Phase C:** Cross-hub CRL merge + `GET /api/protocol/trusted-hubs.json` allowlist curated by integrator policy.
4. **Phase D:** Write path (registration) only on home hub; optional hub-to-hub replication of public agent rows (out of scope until Phase C stable).

We explicitly **reject** full peer-to-peer registration gossip in v1 — too hard to secure.

## Consequences

| Positive | Negative |
|----------|----------|
| Integrators can survive hub outage (read mirror) | Stale mirror data if cache TTL wrong |
| Neutral protocol story for investors | Operator must run 2nd mirror or partner does |
| Aligns with hub-lite self-host | Split-brain if two hubs both “register” same pubkey |

## Certificate shape (Phase A)

Add to hub-signed cert payload (non-breaking optional fields):

```json
{
  "hub_id": "umbraxon-main",
  "hub_url": "https://www.umbraxon.xyz",
  "federation_epoch": 1
}
```

Default `hub_id` for existing certs: env `HUB_FEDERATION_ID` (default `umbraxon-main`).

## Integrator guidance

- **Low risk:** trust `www.umbraxon.xyz` only.
- **Medium:** primary + mirror; fail if both disagree on `cert_serial` + pubkey.
- **High value:** `?include=cert_proof` + offline Ed25519 verify against pinned hub pubkey (already supported).

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Blockchain-only registry | Cost + privacy mismatch |
| Single global SaaS | Centralization (current state, interim only) |
| DID / W3C only | Poor LN economics story for Sybil tax |

## Implementation checklist

- [ ] `HUB_FEDERATION_ID` in `.env` + health payload
- [ ] `GET /api/protocol/trusted-hubs.json` (static + operator-edited)
- [ ] Document mirror deploy in `docs/HUB-LITE-DOCKER.md`
- [ ] Cross-hub verify in `@umbraxon_kya/kya-verify` (future minor release)

## References

- [`ARCHITECTURE-THIN-HUB.md`](../ARCHITECTURE-THIN-HUB.md)
- [`HUB-LITE-DOCKER.md`](../HUB-LITE-DOCKER.md)
- [`GO-TO-MARKET-90-DAYS.md`](../GO-TO-MARKET-90-DAYS.md) mesiac 3
