# Alerting & SLO — Operator runbook (simple baseline)

This runbook defines what “critical” means operationally and what to do first.
It complements:
- `docs/NETDATA-ACCESS.md` (Netdata + Telegram alarms)
- `docs/PROMETHEUS-METRICS.md` + `config/prometheus-alerts.yml` (app metrics + alert rules)

## 1) Paging policy

- **CRITICAL**: immediate operator action (service degraded or funds-at-risk).
- **WARNING**: investigate during working hours (often pre-failure signal).
- **INFO**: audit trail / expected ops events.

Primary notification channel: **Telegram** via `lib/notifications.js`.

## 2) What we page on (baseline)

### Service availability / correctness

- **CRITICAL**: `KYAHubCertBreakerHalted`
  - Symptom: `/api/pay` returns 503 (maintenance halt)
  - Immediate: check logs + upstream health; reset only after root cause is understood.
- **WARNING/CRITICAL**: `/api/pay` p99 latency
  - Warning: `KYAHubPayLatencyP99High` (p99 > 500ms for 5m)
  - Critical: `KYAHubPayLatencyP99Critical` (p99 > 2s for 5m)
- **WARNING**: `KYAHubHigh5xxRate` (5xx > 2% for 10m)

### Chain / anchoring safety

- **CRITICAL**: `KYAHubChainForkDetected` (fork detector says tip disagrees)
- **WARNING**: `KYAHubAnchorBacklog` (pending_anchors > 10 for 15m)

### Capacity / infra

Netdata custom alarms (see `docs/NETDATA-ACCESS.md`):
- disk usage (warn>80%, crit>90%)
- RAM pressure (warn>80%, crit>92%)
- load high (warn>6, crit>12)
- PG connections high (warn>75%, crit>90%)
- Nginx 5xx / connection anomalies

## 3) First-5-min triage checklist (copy/paste)

Run on the server:

```bash
# 1) quick HTTP sanity
curl -fsS http://127.0.0.1:3000/api/health | head -c 400; echo

# 2) see what restarted/crashed recently
pm2 list
pm2 logs kya-hub --lines 200 --nostream

# 3) worker-specific checks (as needed)
pm2 logs kya-anchor-worker --lines 200 --nostream || true
pm2 logs kya-crl-worker --lines 200 --nostream || true
pm2 logs alby-hub --lines 200 --nostream || true

# 4) disk pressure (volume + root)
df -h
du -sh /root/.pm2/logs /root/backups 2>/dev/null || true
```

If DB-related:

```bash
sudo -u postgres psql -c "SELECT now(), count(*) FROM pg_stat_activity;"
```

If the cert breaker is halted:

```bash
curl -fsS -H "X-Admin-Key: $ADMIN_API_KEY" http://127.0.0.1:3000/api/admin/breaker/cert-issuance/state | head -c 1200; echo
```

## 3b) Secret rotation (operator)

If any secret is exposed (chat, paste, screenshot, etc.), rotate **immediately**:

- **Admin API key**: generate a new 32-byte hex and replace `ADMIN_API_KEY` in `.env`, then `pm2 restart --update-env kya-hub`.
- **Telegram bot token**: rotate via BotFather (new token) and update `TELEGRAM_BOT_TOKEN` in `.env`, then restart `kya-hub` (or whichever process sends notifications).
- **BTCPay API key**: create a new key in BTCPay and replace `BTCPAY_API_KEY` in `.env`, then restart `kya-hub`.

After rotation, verify:

- Admin calls still work (with the new `X-Admin-Key`)
- Alerts still deliver to Telegram
- Payments still work (Alby/BTCPay as applicable)

## 4) Reset policies (safety)

- Do **not** “blind-reset” a breaker to silence alerts. Reset only after:
  - upstream dependencies are healthy, and
  - logs indicate the underlying error cause stopped.

