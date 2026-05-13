# Prometheus metrics — UMBRAXON KYA-Hub

**Status:** Strategic Sprint §30 Item 10 — 2026-05-12.

## Endpoint

### `GET /api/metrics`

Returns metrics in Prometheus 0.0.4 text exposition format. **Admin-auth
gated** (header `X-Admin-Key: <ADMIN_API_KEY>`). The endpoint is
gated to prevent third-party scraping, since some labels (e.g. agent
counts by tier+zone) could leak business-sensitive information.

## Metric reference

All metrics use the `kyahub_` prefix (configurable via `METRICS_PREFIX`).

| metric                                                    | type        | labels                            | meaning                                                                             |
| --------------------------------------------------------- | ----------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `kyahub_requests_total`                                   | counter     | route, method, status             | total HTTP requests served, split by status class (2xx/4xx/5xx) and exact code      |
| `kyahub_request_duration_seconds`                         | histogram   | route, method                     | latency distribution. Buckets: 5 ms, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000 |
| `kyahub_pending_anchors`                                  | gauge       | —                                 | rows in `pending_anchors` with status PENDING/BROADCAST (sampled every 15 s)        |
| `kyahub_active_agents`                                    | gauge       | tier, zone                        | active (non-retired) agents bucketed by tier + reputation zone (GREEN/YELLOW/RED)   |
| `kyahub_agents_ever_registered`                           | gauge       | —                                 | `COUNT(*)` from `agents` (lifetime rows, including retired)                         |
| `kyahub_registration_intents`                             | gauge       | status                            | `registration_intents` grouped by `status` (DB truth; refreshed with other slow gauges) |
| `kyahub_webhook_deliveries_unprocessed`                   | gauge       | source                            | rows in `webhook_deliveries` with `processed = false`, by `source` (`btcpay` / `alby`) |
| `kyahub_rejected_requests_24h`                            | gauge       | —                                 | rows in `rejected_requests` with `occurred_at` in the rolling last 24 hours          |
| `kyahub_rejected_requests_by_reason_24h`                | gauge       | reason                            | top 8 `reason` values in that same 24 h window (bounded cardinality)                   |
| `kyahub_circuit_breaker_state`                            | gauge       | breaker_name                      | 0=CLOSED, 1=OPEN, 2=HALF_OPEN, 3=DEGRADED_WARN, 4=MAINTENANCE_HALT                  |
| `kyahub_cert_breaker_fail_pct`                            | gauge       | —                                 | cert-issuance breaker rolling-window failure %                                      |
| `kyahub_chain_consensus_state`                            | gauge       | —                                 | 0=OK, 1=INSUFFICIENT_SOURCES, 2=LOCAL_RPC_UNREACHABLE, 3=FORK_DETECTED              |
| `kyahub_lightning_inbound_sat`                            | gauge       | —                                 | last-known Lightning inbound liquidity. `-1` if unknown (NWC fallback path)         |
| `kyahub_lightning_outbound_sat`                           | gauge       | —                                 | last-known Lightning outbound liquidity                                             |
| `kyahub_btcpay_balance_sat`                               | gauge       | —                                 | last-observed BTCPay wallet balance                                                 |
| `kyahub_bitcoind_anchor_balance_sat`                      | gauge       | —                                 | last-observed bitcoind kya-anchor wallet balance                                    |
| `kyahub_volumetric_usage`                                 | gauge       | limit_key, subject_id             | current rolling-window consumption per AML limit                                    |
| `kyahub_start_time_seconds`                               | gauge       | —                                 | Unix timestamp of hub process start                                                 |
| `kyahub_proc_*` (default node.js metrics)                 | mixed       | —                                 | CPU, RSS, GC, event-loop lag, open FDs, etc. Provided by `prom-client`              |

## Adding to Netdata scrape config

Netdata's Prometheus collector lives at
`/etc/netdata/go.d/prometheus.conf`. Append:

```yaml
jobs:
  - name: kya-hub
    url: http://127.0.0.1:3000/api/metrics
    headers:
      X-Admin-Key: ${KYAHUB_ADMIN_API_KEY}
    timeout: 5
```

Then drop `ADMIN_API_KEY` into Netdata's env file at
`/etc/netdata/.environment` (chmod 600):

```bash
KYAHUB_ADMIN_API_KEY=...
```

Reload Netdata: `systemctl reload netdata`.

## Human-readable ops summary (same aggregates)

- **`GET /api/admin/ops-summary`** — JSON with the same DB aggregates as the gauges above, plus `agents_active`, `agents_ever_registered`, and the last 15 `rejected_requests` rows. Same **`X-Admin-Key`** as other admin routes.
- **Web dashboard (čísla + grafy):** v prehliadači otvor  
  **`https://<tvoj-hub-host>/public/admin/ops-dashboard.html`**  
  (napr. `https://umbraxon.xyz/public/admin/ops-dashboard.html`). Zadaj **Base URL** ak otváraš z inej domény, vlož **`X-Admin-Key`**, tlačidlo **Načítať** — stránka volá `ops-summary` (vrátane bloku **`extended`**: zamietnutia podľa cesty/statusu, PoW, auth challenge, heartbeat log, anchory, action log), zobrazí karty, grafy a **vysvetlenie „Aktívni agenti“** v poli `legend`. Predvolene auto-obnovenie každých 30 s. Vyžaduje Chart.js z CDN (internet).

## PromQL examples (registration & pay traffic)

**Two notions of “failed registration”:**

1. **HTTP layer** — `kyahub_requests_total` for `route="/api/register/initiate"` with `status="4xx"` or `status="5xx"` (and exact codes on the `status` label). Counters reset on hub process restart.
2. **DB layer** — `kyahub_registration_intents{status="FAILED"}` and/or `status="EXPIRED"` (intent never completed or timed out).

**Registration initiate error rate (5m, HTTP 5xx class):**

```promql
sum(rate(kyahub_requests_total{route="/api/register/initiate",status="5xx"}[5m]))
```

**Pay endpoint volume (5m, all methods):**

```promql
sum(rate(kyahub_requests_total{route="/api/pay"}[5m]))
```

**Webhook backlog (should usually be near 0):**

```promql
sum(kyahub_webhook_deliveries_unprocessed)
```

**Rejected API traffic (24 h rolling, as exposed at scrape time):**

```promql
kyahub_rejected_requests_24h
```

## Reference alerts (Prometheus alertmanager)

Strategic Sprint §30 Item 10 ships a baseline of alert rules in
`config/prometheus-alerts.yml`. The most important is the **p99 latency
SLO** for `/api/pay`:

```yaml
- alert: KYAHubPayLatencyP99High
  expr: |
    histogram_quantile(
      0.99,
      sum by (le) (
        rate(kyahub_request_duration_seconds_bucket{route="/api/pay"}[5m])
      )
    ) > 0.5
  for: 5m
  labels: { severity: warning, service: kya-hub }
  annotations:
    summary: "p99 /api/pay latency > 500 ms for 5 min"
    description: "Investigate BTCPay / Alby upstream latency, DB pool saturation, or HUB key encrypt/decrypt cost."
```

Other built-in rules:

- `KYAHubAnchorBacklog` — pending_anchors > 10 for 15 min
- `KYAHubBreakerOpen` — any breaker in state ≥ 1 (OPEN/HALF_OPEN/HALT)
- `KYAHubChainForkDetected` — `kyahub_chain_consensus_state == 3`
- `KYAHubLowInboundLiquidity` — `kyahub_lightning_inbound_sat > -1 AND < 200_000`
- `KYAHubBitcoindAnchorWalletLow` — `kyahub_bitcoind_anchor_balance_sat < 5_000`

These rules are imported by the operator's existing alertmanager. The
Telegram bridge already exists in `lib/notifications.js`, but the
node.js process itself never sends p99 alerts directly — it just exposes
the histogram, and alerting belongs in alertmanager.

## Environment variables

| variable                  | default     | meaning                                                       |
| ------------------------- | ----------- | ------------------------------------------------------------- |
| `METRICS_PREFIX`          | `kyahub`    | all metrics use this prefix                                   |
| `METRICS_REFRESH_TTL_MS`  | `15000`     | min time between full refreshes of slow gauges (DB hit cap)   |

## What's NOT in `/api/metrics`

- Per-agent metrics with `kya_id` labels. The label cardinality would
  be unbounded. Use the admin API for per-agent state.
- Anything containing a Bitcoin tx id, payment hash, or invoice — same
  reason.
- Anything containing actual sats numbers per agent — `volumetric_usage`
  is the only exception, and it's protected by admin auth.
- **`GET /api/admin/ops-summary`** includes recent rejection rows (paths, IPs in DB) — treat like other admin-only surfaces; do not expose publicly without auth.
