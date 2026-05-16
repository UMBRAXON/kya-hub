# Data Export API — UMBRAXON KYA-Hub

**Audience:** bot operators, regulators, GDPR auditors.
**Status:** Strategic Sprint §30 Item 8 — 2026-05-12.

This endpoint implements GDPR Article 15 ("Right of access by the data
subject") for agents enrolled in UMBRAXON KYA-Hub. An agent that controls
its own Ed25519 private key can fetch every row the hub has stored about
it, including:

- Its current agent row (status, tier, reputation, manifest hash, pubkey)
- All certificates it has ever held (active + revoked)
- All reputation events that touched its score
- All action_log entries it submitted
- All reports filed against it AND all reports it filed against others
- Appeals it has lodged
- Heartbeats (last 1 000)
- cert_signing_log rows (audit trail of every cert the hub signed for it)
- Pending and confirmed on-chain anchors
- Revocation events on the CRL ledger

No payment data is included for OTHER agents; nothing about the hub's
private keys is included.

## Endpoint

### `POST /api/agent/:kya_id/data-export`

Request body (JSON):

```json
{
  "signature": "<128-hex Ed25519 signature>",
  "nonce": "<16–64 hex>",
  "timestamp": "<ISO-8601 within ±5 min of hub clock>"
}
```

The agent signs the SHA-256 digest of this canonical payload:

```json
{ "v": 1, "op": "data-export", "kya_id": "...", "nonce": "...", "timestamp": "..." }
```

(serialised with `JSON.stringify` in key order shown above — the exact
function is exported as `dataExportService.canonicalExportPayload()`).

Response 200:

```json
{
  "ok": true,
  "export_id": 42,
  "download_token": "<64-hex one-time token>",
  "download_url": "https://hub.umbraxon.xyz/api/agent/UMBRA-AB12CD/data-export/42?token=...",
  "expires_at": "2026-05-12T17:00:00.000Z",
  "archive_size_bytes": 18432,
  "archive_sha256": "<64-hex sha256 of the zip>",
  "rate_limit": { "used": 1, "max_per_day": 5 }
}
```

Errors:

| HTTP | error code              | meaning                                         |
| ---- | ----------------------- | ----------------------------------------------- |
| 400  | `INVALID_KYA_ID`        | format `UMBRA-[A-F0-9]{6}` violated (digits `0-9` only are valid, e.g. sequential `UMBRA-000123`) |
| 400  | `BAD_SIGNATURE_FORMAT`  | signature is not 128 hex chars                  |
| 400  | `INVALID_NONCE_FORMAT`  | nonce not 16–64 hex                             |
| 400  | `MISSING_TIMESTAMP`     | timestamp omitted                               |
| 400  | `TIMESTAMP_SKEW`        | timestamp > 5 min from hub clock                |
| 400  | `AGENT_HAS_NO_PUBKEY`   | agent row has no `agent_pubkey`                 |
| 401  | `BAD_SIGNATURE`         | sig did not verify (logged + rate-tracked)      |
| 404  | `AGENT_NOT_FOUND`       | unknown kya_id                                  |
| 429  | `RATE_LIMIT`            | > `DATA_EXPORT_MAX_PER_DAY` (default 5) per 24h |
| 500  | `BUILD_FAILED`          | zip build errored — row marked FAILED in DB     |

### `GET /api/agent/:kya_id/data-export/:export_id?token=<hex>`

Returns the binary `.json.zip` archive. The token is consumed on first
successful read (`download_count` becomes 1, subsequent attempts return
410 `EXPORT_ALREADY_DOWNLOADED`). Tokens are stored hashed (sha256) in
the DB; the plaintext token only ever lives in the response to the
create call and in the agent's possession.

Response headers:

- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="EXPORT-UMBRA-AB12CD-<id>.json.zip"`
- `X-Archive-SHA256: <hex>` — agents SHOULD verify this matches the
  `archive_sha256` returned by the create call.

Failure modes return JSON `{ "error": "..." }`:

| HTTP | error code                   | meaning                                            |
| ---- | ---------------------------- | -------------------------------------------------- |
| 403  | `BAD_TOKEN`                  | sha256(token) ≠ stored hash                        |
| 403  | `KYA_ID_MISMATCH`            | path kya_id ≠ row.kya_id                           |
| 404  | `EXPORT_NOT_FOUND`           | export_id unknown                                  |
| 409  | `EXPORT_NOT_READY`           | row exists but status is PENDING / FAILED          |
| 410  | `EXPORT_EXPIRED`             | `expires_at` is past                               |
| 410  | `EXPORT_ALREADY_DOWNLOADED`  | single-use semantics: must `POST` to mint a new id |
| 410  | `EXPORT_PRUNED`              | retention pruner deleted the archive on disk      |
| 410  | `ARCHIVE_MISSING`            | filesystem race or manual deletion                 |

### Admin endpoints

- `GET  /api/admin/data-exports?limit=50&offset=0` — paginated list of
  every SAR audit row (no plaintext token, no archive contents).
- `POST /api/admin/data-exports/prune` (body `{ "dry_run": true|false }`)
  — deletes expired / failed archives from disk and marks the row as
  PRUNED. The DB row is never deleted (the audit trail is permanent).

Both require the standard admin auth header (`X-Admin-Key`).

## Archive layout

The zip contains a single entry named `data.json`. Top-level shape:

```json
{
  "_meta": {
    "kya_id": "UMBRA-AB12CD",
    "agent_id": 12345,
    "exported_at": "2026-05-12T16:00:00Z",
    "export_id": 42,
    "kyahub_version": "1.1.0",
    "schema_version": "2026-05-12-13",
    "included_tables": ["agent","certificates","reputation_events", ...]
  },
  "data": {
    "agent":              [ { ...one row... } ],
    "certificates":       [ ... ],
    "reputation_events":  [ ... ],
    "action_log":         [ ... ],
    "reports_against_me": [ ... ],
    "reports_by_me":      [ ... ],
    "appeals":            [ ... ],
    "heartbeats_log":     [ ... ],
    "cert_signing_log":   [ ... ],
    "pending_anchors":    [ ... ],
    "anchor_audit":       [ ... ],
    "revocation_events":  [ ... ]
  }
}
```

`reputation_events_archive` is folded in as a separate table key with
the same row shape as `reputation_events`.

## Environment variables

| variable                          | default                                   | meaning                                       |
| --------------------------------- | ----------------------------------------- | --------------------------------------------- |
| `DATA_EXPORT_DIR`                 | `/root/kya-hub/data-exports`              | on-disk archive directory (chmod 700)         |
| `DATA_EXPORT_TTL_SECONDS`         | `3600`                                    | hard expiry on every issued download URL      |
| `DATA_EXPORT_MAX_PER_DAY`         | `5`                                       | per-agent rolling 24h cap                     |
| `DATA_EXPORT_PUBLIC_BASE_URL`     | (empty → use `HUB_PUBLIC_URL`)            | externally reachable hub base for download_url |
| `HUB_PUBLIC_URL`                  | (empty)                                   | fallback for download_url                     |

If both are empty, the API still works — it returns `download_path`
(relative) instead of `download_url`, and the agent's SDK reconstructs
the full URL locally.

## Rate-limiting + audit

Every `POST /api/agent/:kya_id/data-export` insert a row into
`data_exports` *before* the archive is built. The row records the
client IP, the user-agent string, and (after success) the
`archive_sha256` and `download_count`. Regulators can rely on this
table as the canonical SAR ledger. The plaintext download token is
never persisted.

## Retention policy

Default retention is `1h` — long enough for the agent to retrieve the
archive, short enough that an exfiltrated token expires before any
practical exploitation. Operators can extend the TTL via
`DATA_EXPORT_TTL_SECONDS`. The pruner (`POST /api/admin/data-exports/prune`)
removes the file from disk and marks the row PRUNED / EXPIRED; the row
itself is retained forever.

## Worked example (agent SDK)

```js
const crypto = require('crypto');
const axios = require('axios');

async function sar(kyaId, privKey) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const canonical = JSON.stringify({
        v: 1, op: 'data-export',
        kya_id: kyaId, nonce, timestamp,
    });
    const digest = crypto.createHash('sha256').update(canonical).digest();
    const signature = crypto.sign(null, digest, privKey).toString('hex');

    const create = await axios.post(
        `https://hub.umbraxon.xyz/api/agent/${kyaId}/data-export`,
        { signature, nonce, timestamp });
    const { download_url, download_token, expires_at } = create.data;
    console.log(`expires at ${expires_at}; downloading…`);

    const bin = await axios.get(download_url, { responseType: 'arraybuffer' });
    require('fs').writeFileSync(`my-data-${Date.now()}.json.zip`, bin.data);
}
```
