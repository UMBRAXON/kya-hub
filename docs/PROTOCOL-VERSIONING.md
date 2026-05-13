# UMBRAXON KYA-Hub — Protocol Versioning

**Status:** Strategic Sprint §30 Item 9 — 2026-05-12.

## Why a handshake

KYA-Hub speaks one logical protocol today (`1.0`) but is designed to
evolve. To keep older agent SDKs working through future breaking
changes, **every client MUST query the hub for its supported protocol
versions before issuing any other API call**, and pin its requests to
a version the hub still supports.

This handshake is intentionally lightweight: one GET, no auth, 60 s of
edge caching. The cost is one round-trip every minute (or per process
lifetime if the client caches in-memory).

## Endpoint

### `GET /api/protocol/versions`

No auth required. Responds:

```json
{
  "supported":     ["1.0"],
  "preferred":     "1.0",
  "deprecated":    [],
  "min_required":  "1.0",
  "next_planned":  "1.1",
  "changelog_url": "https://umbraxon.xyz/docs/protocol-changelog",
  "handshake_required": true
}
```

Headers:

- `Cache-Control: public, max-age=60` — fine to cache for 1 minute.

Field meaning:

| field             | meaning                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `supported`       | Versions the hub will accept on any subsequent call. Ordered oldest → newest.                                     |
| `preferred`       | The version the hub recommends new clients pick (the newest one that is also stable).                             |
| `deprecated`      | Versions still accepted today but scheduled for removal. New clients SHOULD avoid these.                          |
| `min_required`    | The lowest version a client may send. Anything below WILL be rejected with 400 / `UNSUPPORTED_PROTOCOL_VERSION`.   |
| `next_planned`    | The version the operator is currently developing. Not yet served; intended as a heads-up so SDK authors can plan. |
| `changelog_url`   | Public changelog. SDK authors should subscribe.                                                                   |
| `handshake_required` | Always `true` today. Reserved field; if it ever becomes `false`, clients may skip the handshake.               |

## Client picking algorithm

```js
const { supported, preferred, min_required, deprecated } =
    (await fetch('https://hub.umbraxon.xyz/api/protocol/versions')).body;

// 1) compute the intersection of versions the SDK can speak vs hub-supported.
const myVersions = ['1.0', '1.1']; // versions baked into this SDK
const usable = myVersions.filter(v => supported.includes(v));

if (!usable.length) {
    throw new Error(
        `This SDK speaks [${myVersions.join(',')}], hub supports [${supported.join(',')}]; ` +
        `please upgrade. See ${changelog_url}`);
}

// 2) prefer the hub's `preferred` if it is one of ours; else pick the newest
// non-deprecated mutually-supported.
const chosen =
    usable.includes(preferred) ? preferred :
    usable.filter(v => !deprecated.includes(v)).sort().reverse()[0] ||
    usable.sort().reverse()[0];

// 3) attach as `protocol_version` to every manifest / signed payload.
manifest.protocol_version = chosen;
```

## Server-side enforcement

The hub will (in a future patch) reject requests whose
`protocol_version` is:

- Not in the `supported` array → `400 UNSUPPORTED_PROTOCOL_VERSION`
- Below `min_required` → `400 PROTOCOL_VERSION_TOO_OLD`
- In `deprecated` → 200 OK but `Warning: 299 - "protocol version X is deprecated"`

Today (May 2026) the only version is `1.0`. The enforcement path is
ready for use as soon as `1.1` ships.

## Environment variables

| variable                       | default                                                | meaning                                                       |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| `HUB_PROTOCOL_PREFERRED`       | (last entry in `manifest-schema` enum, defaults `1.0`) | the `preferred` field                                         |
| `HUB_PROTOCOL_MIN_REQUIRED`    | (first entry in enum, defaults `1.0`)                  | the `min_required` field                                      |
| `HUB_PROTOCOL_DEPRECATED`      | (empty)                                                | comma-separated list of deprecated versions                   |
| `HUB_PROTOCOL_NEXT_PLANNED`    | `1.1`                                                  | preview field                                                 |
| `HUB_PROTOCOL_CHANGELOG_URL`   | `https://umbraxon.xyz/docs/protocol-changelog`         | hyperlink shown in the response                               |

The `supported` array itself is pulled live from
`lib/manifest-schema.js → SCHEMA.properties.protocol_version.enum` so
the handshake endpoint can never drift from the schema validation
layer.

## When to bump

| change                                                              | versioning             |
| ------------------------------------------------------------------- | ---------------------- |
| Add a new OPTIONAL manifest field                                   | no bump                |
| Add a new endpoint                                                   | no bump                |
| Add a new OPTIONAL request body field                               | no bump                |
| Change the semantic of an existing field                            | minor bump (`1.x → 2.x`) |
| Add a new REQUIRED field                                            | minor bump             |
| Remove a field                                                       | minor bump             |
| Change the canonical signing string format                           | minor bump             |
| Change the cert structure (`@context`, `proof` shape)                | major bump (when issued) |

The hub publishes the SDK migration guide on the changelog URL above
at the same time the version is enabled here.
