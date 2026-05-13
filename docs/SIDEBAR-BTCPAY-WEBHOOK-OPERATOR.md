# BTCPay webhook + TLS — operátorský návod (bokom)

Tento súbor je **odkladací** — skopírovaný postup s konkrétnymi doménami z projektu UMBRAXON / KYA-Hub. Hlavná dokumentácia ostáva v `UMBRAXON.md`, `docs/DIAGNOSTIC-CHECKLIST.md` (§7), `docs/GO-LIVE-OPERATOR-WALKTHROUGH.md`.

## Domény a URL

| Účel | Adresa |
|------|--------|
| KYA-Hub API (verejné) | https://umbraxon.xyz |
| Health | https://umbraxon.xyz/api/health |
| BTCPay webhook do hubu | https://umbraxon.xyz/api/webhook/btcpay |
| Alby webhook do hubu | https://umbraxon.xyz/api/webhook/alby |
| BTCPay Server (UI) | https://pay.umbraxon.xyz (`BTCPAY_URL` v `.env`) |
| Redirect po platbe (príklad) | https://umbraxon.xyz/dashboard |
| Bot developer portal (ak nasadené) | https://bots.umbraxon.xyz |

Webhook **vždy** na hub (`umbraxon.xyz`), nie na `pay.umbraxon.xyz`.

## BTCPay — webhook v UI

1. Otvor https://pay.umbraxon.xyz a prihlás sa.
2. Store musí zodpovedať `BTCPAY_STORE_ID` v `/root/kya-hub/.env` na serveri.
3. Store → Settings → Webhooks → Create (alebo uprav existujúci).
4. **Payload URL:** `https://umbraxon.xyz/api/webhook/btcpay`
5. Udalosť napr. **Invoice Settled**; ulož; secret do `BTCPAY_WEBHOOK_SECRET` v `.env`.
6. `cd /root/kya-hub && pm2 restart kya-hub --update-env`
7. Kontrola logu: `grep 'webhook/btcpay' /root/.pm2/logs/kya-hub-out.log | tail -n 10`

## Tunel (dočasná náhrada DNS)

Ak používaš ngrok/cloudflared, Payload URL je `https://<tvoj-tunel>/api/webhook/btcpay` — po zmene hosta treba webhook v BTCPay znova uložiť.

Smoke zvonku (bez HMAC očakávaj 400):

```bash
curl -sS -o /dev/null -w 'code=%{http_code} tls=%{time_appconnect}\n' \
  -X POST 'https://umbraxon.xyz/api/webhook/btcpay' \
  -H 'Content-Type: application/json' -d '{}'
```

## TLS / latencia

```bash
curl -sS -o /dev/null -w 'connect=%{time_connect} tls_handshake=%{time_appconnect} total=%{time_total}\n' \
  'https://umbraxon.xyz/api/status'
curl -sS -o /dev/null -w 'connect=%{time_connect} tls_handshake=%{time_appconnect} total=%{time_total}\n' \
  'https://umbraxon.xyz/api/whitelist?limit=1'
```

## Nginx access log (edge)

```bash
docker exec kya-hub-proxy tail -n 50 /var/log/nginx/access.log
```

Hľadaj `POST /api/webhook/btcpay`.

---

*Uložené pre návrat k postupu bez hľadania v chate.*
