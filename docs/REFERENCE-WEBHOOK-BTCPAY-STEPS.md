# Webhook, BTCPay, TLS — referencia (bokom)

Tento súbor je uložený na žiadosť operátora; nie je súčasťou hlavného go-live checklistu. Aktualizuj podľa skutočného `.env` a BTCPay UI.

## Domény a URL

| Účel | Adresa |
|------|--------|
| KYA-Hub API | https://umbraxon.xyz |
| Health | https://umbraxon.xyz/api/health |
| BTCPay webhook | https://umbraxon.xyz/api/webhook/btcpay |
| Alby webhook | https://umbraxon.xyz/api/webhook/alby |
| BTCPay Server (UI) | https://pay.umbraxon.xyz |
| Redirect (príklad) | https://umbraxon.xyz/dashboard |
| Bot portal (ak nasadené) | https://www.umbraxon.xyz/bots/ (alias `bots.umbraxon.xyz` → 301) |

Webhook vždy na **hub** (`umbraxon.xyz`), nie na `pay.umbraxon.xyz`.

## BTCPay — webhook v UI

1. https://pay.umbraxon.xyz → Store zodpovedajúca `BTCPAY_STORE_ID` v `/root/kya-hub/.env`
2. Store → Settings → Webhooks → Create / upraviť
3. Payload URL: `https://umbraxon.xyz/api/webhook/btcpay`
4. Udalosť: Invoice Settled (podľa runbooku aj ďalšie)
5. Secret → `BTCPAY_WEBHOOK_SECRET` v `.env`, potom `pm2 restart kya-hub --update-env`
6. Log: `grep 'webhook/btcpay' /root/.pm2/logs/kya-hub-out.log | tail -n 10`

## Tunel (dočasné)

Payload URL napr. `https://<ngrok-id>.ngrok-free.app/api/webhook/btcpay` — po zmene URL znova uložiť v BTCPay.

Smoke (bez platného HMAC očakávaj 400):

```bash
curl -sS -o /dev/null -w 'code=%{http_code} tls=%{time_appconnect}\n' \
  -X POST 'https://umbraxon.xyz/api/webhook/btcpay' \
  -H 'Content-Type: application/json' -d '{}'
```

## TLS / klient zvonku

```bash
curl -sS -o /dev/null -w 'tls_handshake=%{time_appconnect} total=%{time_total}\n' \
  'https://umbraxon.xyz/api/status'
curl -sS -o /dev/null -w 'tls_handshake=%{time_appconnect} total=%{time_total}\n' \
  'https://umbraxon.xyz/api/whitelist?limit=1'
```

## Nginx (edge)

```bash
docker exec kya-hub-proxy tail -n 50 /var/log/nginx/access.log
```

Hľadať `POST /api/webhook/btcpay`.

## Ďalšia dokumentácia

- `docs/DIAGNOSTIC-CHECKLIST.md` §7
- `docs/GO-LIVE-OPERATOR-WALKTHROUGH.md` (webhook, TLS)
- `UMBRAXON.md` §22 (architektúra)
