# Register your agent on UMBRAXON KYA Hub (quickstart)

**Order matters:** sandbox (free) → then mainnet registration (Lightning).

## 0. Integrator gate (no payment) — 2 minutes

```bash
curl -fsS "https://www.umbraxon.xyz/api/v1/agents/UMBRA-TEST-0001/status" | jq .
# → "verified": true

./scripts/integrate-in-5min.sh
```

Profile: `GET /api/protocol/integrator-sandbox` · Docs: [INTEGRATOR-QUICKSTART-5MIN.md](INTEGRATOR-QUICKSTART-5MIN.md)

## 1. Read the contract

- [README_API.md](../README_API.md) — `POST /api/v1/register`
- [FAQ for bot developers](FAQ-FOR-BOT-DEVELOPERS.md)
- Portal: https://www.umbraxon.xyz/bots/

## 2. Prepare keys

- Ed25519 keypair (64-char hex pubkey)
- Lightning node id for `payment_hints` (M2M) — or skip until production
- Optional: sponsor invite `SINV-…` (skips PoW only)
- Optional: operator **sponsor pool** code (growth — ask operator)

## 3. Register flow (mainnet)

1. `GET /api/pow/challenge?purpose=register&tier=BASIC` → solve (or sponsor invite)
2. `GET /api/auth/challenge?pubkey=…` → sign **raw nonce** (not hash)
3. Build manifest → sign manifest hash (canonical JSON)
4. `POST /api/v1/register` → pay Lightning invoice (10k sats BASIC default)
5. Poll `GET /api/v1/register/status?registration_id=…` → `GET /api/cert/{kya_id}`

Optional: `integrations.discovery_opt_in: true` → listed in `/api/discovery/v1/agents.json` + `discovery.indexed` webhook.

## 4. Reference client

```bash
curl -sS https://raw.githubusercontent.com/UMBRAXON/kya-hub/main/scripts/umbrexon_bot_client.py -o kya_client.py
pip install pynacl
python3 kya_client.py self-test
python3 kya_client.py register --base-url https://www.umbraxon.xyz ...
```

## 5. Get help

[Registration help issue](https://github.com/UMBRAXON/kya-hub/issues/new?template=registration-help.yml) — include hub `error` code, no secrets.

Go-to-market (operators): [GO-TO-MARKET-90-DAYS.md](GO-TO-MARKET-90-DAYS.md)
