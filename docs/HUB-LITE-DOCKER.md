# KYA Hub Lite (Docker)

Minimal self-hosted stack for integrators who want their own gate without vendor lock-in to `www.umbraxon.xyz`.

## Quick start

```bash
cp .env.example .env.hub-lite
# Edit: ADMIN_KEY, BTCPAY_* or ALBY_NWC_URI, HUB_KEYS paths

docker compose -f docker-compose.hub-lite.yml up -d --build
docker compose -f docker-compose.hub-lite.yml exec hub node migrations/run.js
curl -fsS http://127.0.0.1:3000/api/health | jq .
```

Point your app at `http://127.0.0.1:3000` instead of production.

## Not included

- Portal (Next.js) — use production https://www.umbraxon.xyz for docs or host portal separately
- PM2 workers (CRL anchor, anchor worker) — enable manually if needed
- TLS — put Caddy/nginx in front

## Production hub

The public network remains at https://www.umbraxon.xyz. Hub-lite is for **private pilots** and development.
