# umbraxon (Python SDK)

Thin wrapper over the KYA Hub reference client and integrator read API.

## Install (from monorepo)

```bash
cd /path/to/kya-hub
pip install -e packages/umbraxon-py
```

Requires `scripts/umbrexon_bot_client.py` at the repo root (editable layout).

## Integrator — verify before gate

```python
from umbraxon import UmbraxonIntegratorClient, agent_status

# Anonymous (public rate limit)
assert agent_status("https://hub.umbraxon.xyz", "UMBRA-ABCDEF") is True

# With partner API key
client = UmbraxonIntegratorClient("https://hub.umbraxon.xyz", api_key="umb_live_…")
profile = client.get_agent("UMBRA-ABCDEF")

# LSAT day pass (pay → poll → redeem → reuse token)
inv = client.create_lsat_invoice()
# pay inv["bolt11"], then:
client.lsat_status(inv["access_id"])
tok = client.redeem_lsat(inv["access_id"])
client2 = UmbraxonIntegratorClient("https://hub.umbraxon.xyz", lsat_token=tok["lsat_token"])
```

## Agent registration

```python
from umbraxon import UmbraxonClient

c = UmbraxonClient("https://hub.umbraxon.xyz")
# use c.hub + scripts helpers, or c.register_v1(...) with seed/path kwargs
```

Protocol: `GET /api/protocol/integrator-lsat-profile`
