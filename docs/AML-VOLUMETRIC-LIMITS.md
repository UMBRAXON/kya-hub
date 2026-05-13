# AML volumetric limits (Strategic Sprint §30 Item 4)

UMBRAXON KYA-Hub enforces three anti-money-laundering volumetric
ceilings on its own infrastructure. These caps are *administrative
controls* (not protocol features): they protect against runaway burn
rate and constrain the system's daily on-chain footprint to a
defensible, predictable envelope. They are **not** transaction-monitoring
in the FinCEN/EBA sense — KYA-Hub does **not** intermediate user funds.
The hub spends only its own operational sat balance on cert anchoring
and pays its own LN routing fees.

## Threshold rationale (defensible to regulators)

Seeded with migration 012:

| Key                          | Threshold | Window | Scope     | Rationale |
|------------------------------|----------:|-------:|-----------|-----------|
| `agent:per_day_sats`         | 200 000   | 24 h   | per_agent | Caps total on-chain sats burned **by a single agent** per rolling 24 h. Sized at 200 k SAT ≈ 100 OP_RETURN anchors at typical sat/vB feerates, which is **20× our planned maximum** of ~5 anchors/agent/day. A single agent burning >200 k SAT/day is anomalous and worth investigating before continuing. |
| `global:per_hour_regs`       | 1 000     | 1 h    | global    | Caps **total system-wide new registrations** per rolling 1 h. KYA-Hub's current organic registration rate is ~1–10 / day. 1 000 / h equals **~1000× headroom** while still hard-blocking any conceivable sybil/scripted-bot flood. |
| `global:per_day_anchor_sats` | 50 000    | 24 h   | global    | Caps **total sats spent on OP_RETURN anchors** per rolling 24 h, system-wide. Sized at ~10 ELITE anchors/day at current fee market (~5 k SAT each). Acts as a circuit breaker against fee-market spikes (a 10× feerate jump could otherwise drain the hot wallet in one batch). |

All three are **soft-deny** caps: violating a threshold returns HTTP 429
to the calling client and logs a Telegram warning. The hub does **not**
auto-pause itself on a limit hit — the operator decides whether to (a)
investigate and adjust, or (b) ride out the spike.

## Behaviour on breach

* `agent:per_day_sats` — checked from `scripts/anchor-worker.js` after
  each successful OP_RETURN broadcast. Breach **does not** retry
  on-chain (already landed); it merely logs the event and Telegrams
  a `warning` with dedupe `aml_breach_agent:per_day_sats:<kya_id>`. The
  next anchor for that agent would land another counter row; if the
  agent is well above threshold the operator can manually pause that
  agent's anchor flow via:
  ```bash
  PGPASSWORD=$DB_PASSWORD psql -h localhost -U $DB_USER -d $DB_NAME \
      -c "UPDATE pending_anchors SET status='SUSPENDED', last_error='AML cap' WHERE agent_id=(SELECT id FROM agents WHERE kya_id='UMBRA-XXXXXX') AND status='PENDING';"
  ```
* `global:per_hour_regs` — checked from `/api/pay` in `server.js`. Breach
  blocks the request: HTTP 429 + `Retry-After: 3600`. Telegram
  `warning` deduped per limit_key. Caller sees:
  ```json
  {"error":"VOLUMETRIC_LIMIT_EXCEEDED","limit_key":"global:per_hour_regs","threshold":1000,"current":1001,"window_seconds":3600,"retry_after_sec":3600}
  ```
* `global:per_day_anchor_sats` — checked from anchor worker (same path
  as `agent:per_day_sats`). Same soft-deny semantics; system-wide ops
  alert.

The DB `check()` function **always inserts the counter row first**, then
sums the rolling window. This means even denied requests leave a
forensic audit row in `volumetric_counters`. This is intentional: it
prevents an attacker from sneaking events past the counter by racing
multiple parallel connections.

`check()` **fails OPEN** if the DB is unreachable (logs `error` with
event `volumetric_check_db_fail` but does not block traffic). The
trade-off: a misconfigured pool cannot accidentally take the whole hub
offline, but a DB outage during an attack means the cap isn't enforced.
Operator monitoring should alert on `volumetric_check_db_fail` logs.

## Admin endpoints

All require `X-Admin-Key`. All emit `BAD_ADMIN_KEY` rejections through
abuse-tracker (P2.2 ban escalation).

```
GET    /api/admin/volumetric-limits
   List all limits with their current global-scope window utilisation
   (per_agent / per_ip scope cannot pre-aggregate without a subject_id —
   for those, use the single-limit `/peek` endpoint below).

GET    /api/admin/volumetric-limits/:limit_key?subject_id=UMBRA-XXXXXX
   "Peek" at the current window without inserting a counter row.
   Returns { threshold, current, utilization_pct, window_seconds, ... }.

POST   /api/admin/volumetric-limits
   Upsert a limit row. Body:
   {
     "limit_key": "agent:per_day_sats",   // required; matches /^[a-z0-9._:-]{3,96}$/
     "threshold_value": 250000,           // optional (omit to keep current)
     "window_seconds": 86400,             // optional
     "enabled": true,                     // optional
     "unit": "sats",                      // optional: "sats" or "count"
     "scope": "per_agent",                // optional: "global" | "per_agent" | "per_ip"
     "description": "Per-agent daily burn cap",
     "change_reason": "Raised from 200k to 250k after observation"
   }
   Headers: optional `X-Admin-User: alice@umbraxon` for audit attribution.

POST   /api/admin/volumetric-limits/prune?dry_run=1
   Prune `volumetric_counters` rows older than the longest configured
   window + `extra_margin_days` (default 7 d).
```

## Counter retention

`volumetric_counters` is INSERT-heavy and grows linearly. The
admin-driven `/prune` endpoint deletes rows older than (longest window +
margin); recommended cron:

```
# Strategic Sprint §30 Item 4 — prune old volumetric counters weekly
3 4 * * 1 curl -sS -X POST -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
    -d '{}' https://umbraxon.xyz/api/admin/volumetric-limits/prune \
    >> /var/log/kya-vol-prune.log 2>&1
```

The current sprint does **not** install this cron automatically (it
requires the operator's actual `ADMIN_API_KEY` in the cron env). Add it
once you've verified the API key handling on your host.

## Adding new limits

Any code path that wants to enforce a new volumetric cap follows the
same pattern:

```javascript
const vol = require('./lib/volumetric-limits');

const r = await vol.check(pool, 'my:new:limit', {
    subject_id: 'optional-subject-when-per_agent',
    amount: 1,               // sats OR count, depending on unit
    metadata: { ctx: 'x' },  // forensic JSON
});
if (!r.ok) {
    res.set('Retry-After', String(r.retry_after_sec));
    return res.status(429).json({ error: 'VOLUMETRIC_LIMIT_EXCEEDED', ...r });
}
```

To seed a new limit, either INSERT directly into `volumetric_limits` via
SQL during a follow-up migration, or call the admin upsert endpoint
above. Either way, **fill in `change_reason`** — the column is the
audit trail when a regulator asks "why did you allow / deny this?".

## Test scripts

* `scripts/test-item4-volumetric.js` — exercises:
  1) `peek()` returns 0/threshold for fresh limits
  2) `check()` records counter rows and returns ok=true while under cap
  3) `check()` returns ok=false at the configured threshold
  4) `peek()` shows utilization >= 100% after breach
  5) admin endpoints serve correctly with valid `X-Admin-Key`
  6) prune dry-run reports an upper bound on stale rows
  7) prune live deletes only rows older than longest window + margin
