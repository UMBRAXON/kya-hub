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

**Host path (2026-09-24):** all three ambassadors (`kya-hub-proxy`, `klubo-proxy`, `jasnelabs-proxy`) bind-mount:

`/var/log/kya-hub-nginx` → container `/var/log/nginx`

Site files: `nakus-access.log`, `klubo-access.log`, `jasnelabs-access.log`, …  
**Logrotate:** `/etc/logrotate.d/kya-hub-nginx` (daily / max 50 MB / 14 rotates / compress).  
Do **not** let these grow inside the container overlay (previously `nakus-access.log` hit **3 GB**).

Example: top client IPs hitting `/api/health`:

```bash
grep '/api/health' /var/log/kya-hub-nginx/nakus-access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head
# or inside container:
docker exec kya-hub-proxy grep '/api/health' /var/log/nginx/nakus-access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head
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

## Add `klubo.sk` / `www.klubo.sk`

Separate container **`klubo-proxy`** (own LE cert — never on umbraxon mega-cert):

1. DNS A: `klubo.sk` + `www` → origin `46.225.170.80` (Cloudflare proxied OK).
2. `docker-compose.yml` service `klubo-proxy` + `conf.d/klubo.conf`.
3. App: `/root/klubo` Next on host `:3010`.
4. `docker-compose up -d` (this folder uses `docker-compose`, not `docker compose`).
5. Verify: `curl -fsSI https://www.klubo.sk/login` → **200**.
6. Legacy: `www.nakus.sk/klubo/*` → 301 `www.klubo.sk`.

## Add `staging.klubo.sk`

Internal preview (Basic auth) — Next on host **`:3015`**, pm2 `klubo-staging`.

1. Cloudflare DNS A: `staging` → `46.225.170.80` (proxied OK).
2. `VIRTUAL_HOST` / `LETSENCRYPT_HOST` includes `staging.klubo.sk` (see `docker-compose.yml`).
3. htpasswd: `./secrets/klubo-staging.htpasswd` (from `npm run setup:staging` in `/root/klubo`).
4. `docker-compose up -d --force-recreate klubo-proxy`
5. App: `npm run deploy:staging` in `/root/klubo`.
6. Verify: `curl -u klubo:PASS -fsSI https://staging.klubo.sk/login` → **200**.

Capacitor / Play stays on `www.klubo.sk` — never point the shell at staging.

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

## Add `bots.umbraxon.xyz` (Bot Developer Portal alias)

The portal HTML lives in **`public/bots/`** and is served **canonically** at:

- `https://www.umbraxon.xyz/bots/` (and `https://umbraxon.xyz/bots/`)

The hostname **`bots.umbraxon.xyz`** answers with **HTTP 301** to the same path under `https://www.umbraxon.xyz/bots/…` so old bookmarks keep working. TLS for the alias remains in `LETSENCRYPT_HOST` alongside apex and `www`.

1. Create DNS A (or CNAME) record: `bots.umbraxon.xyz` → same origin as apex.
2. Edit `docker-compose.yml` (already includes all three hosts):
   ```yaml
   VIRTUAL_HOST: "umbraxon.xyz,www.umbraxon.xyz,bots.umbraxon.xyz"
   LETSENCRYPT_HOST: "umbraxon.xyz,www.umbraxon.xyz,bots.umbraxon.xyz"
   ```
3. `docker-compose up -d --force-recreate`
4. Verify:
   - `curl -fsSI https://bots.umbraxon.xyz/ | head -n 5` → expect **301** to `www…/bots/`
   - `curl -fsSI https://www.umbraxon.xyz/bots/ | head`

## Optional: Cloudflare proxy + origin firewall

If DNS uses Cloudflare **Proxied** (orange cloud) with SSL mode **Full (strict)**,
you may restrict host UFW so only Cloudflare edge IPs reach `:80`/`:443`.
See `UMBRAXON.md` §22.12–22.13 and `scripts/ufw-restrict-http-to-cloudflare.sh`.

