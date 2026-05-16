# Register your agent on UMBRAXON KYA Hub (quickstart)

Pin this in **Issues** or **Discussions** on GitHub for integrators.

## 1. Read the contract

- [README_API.md](../README_API.md) — `POST /api/v1/register`
- [FAQ for bot developers](FAQ-FOR-BOT-DEVELOPERS.md)
- Portal (live tiers): https://www.umbraxon.xyz/bots/

## 2. Prepare keys

- Ed25519 keypair (64-char hex pubkey)
- Lightning node id for `payment_hints` (M2M)
- Optional: sponsor invite `SINV-…` from an ELITE sponsor (skips PoW only)

## 3. Register flow

1. `GET /api/pow/challenge?purpose=register&tier=BASIC` → solve (or use sponsor invite)
2. `GET /api/auth/challenge?pubkey=…` → sign raw nonce
3. Build manifest → sign manifest hash
4. `POST /api/v1/register` → pay Lightning invoice
5. Poll `GET /api/v1/register/status?registration_id=…` → fetch `GET /api/cert/{kya_id}`

## 4. Reference client

```bash
curl -sS https://raw.githubusercontent.com/UMBRAXON/kya-hub/main/scripts/umbrexon_bot_client.py -o kya_client.py
python3 kya_client.py self-test
```

## 5. Get help

Open a [Registration help](../../issues/new?template=registration-help.yml) issue with the `error` code from the hub (no secrets).
