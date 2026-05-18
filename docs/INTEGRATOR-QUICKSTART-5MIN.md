# Integrator quickstart (5 minutes)

**Live UI:** https://www.umbraxon.xyz/integrators

## 1. Status gate (no API key)

```bash
curl -s "https://www.umbraxon.xyz/api/v1/agents/UMBRA-TEST-0001/status" | jq .
# → "verified": true

curl -s "https://www.umbraxon.xyz/api/v1/agents/UMBRA-TEST-0005/status" | jq .
# → "verified": false (revoked fixture)
```

Sandbox IDs: `UMBRA-TEST-0001` … `UMBRA-TEST-9999` (no database). Profile: `GET /api/protocol/integrator-sandbox`.

## 2. Gate in your app

```bash
node examples/plugin-gate-v1.js UMBRA-TEST-0001
```

Or Python: `pip install umbraxon` then `UmbraxonIntegratorClient(base_url).agent_status(kya_id)`.

## 3. Partner API key (optional)

Submit the form at `/integrators` or:

```bash
curl -s -X POST "https://www.umbraxon.xyz/api/v1/integrator/key-request" \
  -H "Content-Type: application/json" \
  -d '{"organization":"My LNBits","contact_email":"you@example.com","use_case":"Gate payouts before send — read status API only."}'
```

Operator gets a **Telegram** alert (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in hub `.env`).
Approve: `POST /api/admin/integrator-key-requests/:id/approve` (`X-Admin-Key`). Key shown once — email the requester manually (SMTP coming later).

## 4. Webhooks (optional)

Register agents with `integrations.developer_webhooks` in manifest (see FAQ §H). Events: `agent.registered`, `reputation.changed`, `cert.revoked`.

## 5. CI

Use the repo GitHub Action `.github/actions/kya-verify` in your workflow.
