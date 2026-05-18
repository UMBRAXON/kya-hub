# LNBits — KYA verify gate (thin wrapper)

Call UMBRAXON KYA Hub before allowing a wallet action. No macaroons — HTTP only.

## Install

Copy `kya_gate.py` into your LNBits extensions folder or import from your service.

```bash
pip install requests umbraxon
```

## Usage

```python
from kya_gate import require_kya_verified

require_kya_verified("UMBRA-000467")  # raises if not verified
```

## Environment

| Variable | Default |
|----------|---------|
| `KYA_HUB_BASE_URL` | `https://www.umbraxon.xyz` |
| `KYA_INTEGRATOR_API_KEY` | optional `umb_live_…` |

## Sandbox

Use `UMBRA-TEST-0001` (verified) or `UMBRA-TEST-0005` (revoked) — see `/integrators`.

## Full docs

- https://www.umbraxon.xyz/integrators
- `docs/INTEGRATOR-QUICKSTART-5MIN.md`
