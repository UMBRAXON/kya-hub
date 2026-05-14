# kya-hub-proxy — Ambassador Reverse Proxy

Lightweight `nginx:alpine` container that bridges BTCPay's outer nginx-proxy
(jwilder/nginx-proxy stack) to the host-side **kya-hub** running on port 3000.

```
INTERNET
   ↓ HTTPS:443
[BTCPay nginx] ──Host=pay.umbraxon.xyz──► btcpayserver
       │
       └────Host=umbraxon.xyz───────────► kya-hub-proxy:80
                                              │
                                              └── proxy_pass → host:3000 (kya-hub)
                                                            └─ rate limits, body limits,
                                                               slowloris protection
```

## Why an ambassador?

- BTCPay's `nginx-gen` automatically discovers containers with `VIRTUAL_HOST` env vars and
  generates server blocks + Let's Encrypt TLS certs for them.
- `kya-hub` runs natively on the host (via pm2), not in Docker, so it can't be discovered.
- This tiny container exposes the right env vars and forwards traffic to the host.

## Commands

```bash
# Start
cd /root/kya-hub/nginx-proxy
docker compose up -d   # (or docker-compose up -d)

# Logs (combined)
docker logs -f kya-hub-proxy

# Reload after config change (no downtime)
docker exec kya-hub-proxy nginx -s reload

# Stop
docker compose down
```

## Access log (`kyahub_log`)

`conf.d/default.conf` defines `log_format kyahub_log` with `$real_client_ip` (from `X-Forwarded-For` when present), request line, status, user-agent, timings, `host`, and **`cf_ipcountry=$http_cf_ipcountry`** when traffic passes through **Cloudflare** (otherwise the field is empty).

Example: top client IPs hitting `/api/health` (on the host/container where `access.log` lives):

```bash
grep '/api/health' /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head
```


| Zone | Rate | Burst | Used for |
|------|------|-------|----------|
| `rl_pay` | 10/min | 5 | `/api/pay`, `/api/invoice/*` |
| `rl_register` | 5/min | 3 | `/api/register-bot`, `/api/register/*` (initiate) |
| `rl_action` | 120/min | 30 | `/api/action`, `/api/heartbeat`, `/api/report` |
| `rl_admin` | 30/min | 15 | `/api/admin/*` |
| `rl_default` | 60/min | 20 | everything else |
| `cc_per_ip` | 50 conn | - | concurrent TCP cap per IP |

Trigger: HTTP 429 with JSON `{"error":"rate_limited","retry_after_seconds":60}`.

## Hard limits

- `client_max_body_size`: 256 KB (64 KB for `/webhook/btcpay`)
- `client_body_timeout` / `header_timeout` / `send_timeout`: 10s
- `proxy_read_timeout`: 20s
- Connection limit per IP: 50 concurrent

## Adding `www.umbraxon.xyz` later

Production `docker-compose.yml` in this repo already includes **`www.umbraxon.xyz`**
in `VIRTUAL_HOST` and `LETSENCRYPT_HOST` together with apex and `bots`.

If you are **adding** `www` on a clone that still lacks it:

1. Create DNS A record: `www.umbraxon.xyz →` your origin IP (or CNAME `www` → `@` in Cloudflare).
2. Edit `docker-compose.yml`:
   ```yaml
   VIRTUAL_HOST: "umbraxon.xyz,www.umbraxon.xyz,bots.umbraxon.xyz"
   LETSENCRYPT_HOST: "umbraxon.xyz,www.umbraxon.xyz,bots.umbraxon.xyz"
   ```
3. `docker-compose up -d --force-recreate`
4. Let's Encrypt will issue or extend the cert within ~60s (wait if Cloudflare showed **526** until origin presents a valid cert for `www`).

## Add `bots.umbraxon.xyz` (Bot Developer Portal)

This repo serves a **static** Bot Developer Portal when the request host is `bots.umbraxon.xyz`.
The simplest way is to route that vhost to the same `kya-hub-proxy` container.

1. Create DNS A record: `bots.umbraxon.xyz → 46.225.170.80`.
2. Edit `docker-compose.yml`:
   ```yaml
   VIRTUAL_HOST: "umbraxon.xyz,www.umbraxon.xyz,bots.umbraxon.xyz"
   LETSENCRYPT_HOST: "umbraxon.xyz,www.umbraxon.xyz,bots.umbraxon.xyz"
   ```
3. `docker compose up -d --force-recreate`
4. Verify:
   - `curl -fsSI https://bots.umbraxon.xyz/ | head`
   - `curl -fsSI https://umbraxon.xyz/api/health | head`

## Optional: Cloudflare proxy + origin firewall

If DNS uses Cloudflare **Proxied** (orange cloud) with SSL mode **Full (strict)**,
you may restrict host UFW so only Cloudflare edge IPs reach `:80`/`:443`.
See `UMBRAXON.md` §22.12–22.13 and `scripts/ufw-restrict-http-to-cloudflare.sh`.

