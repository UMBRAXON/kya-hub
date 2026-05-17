# Release — Platform Integrator API (plug-in layer)

**Hub:** 1.1.0+ (platform integrator shipped on branch `cursor/nostr-key-file-setup`)  
**Audience:** LNBits operators, agent marketplaces, orchestration frameworks, MCP hosts

## What’s new

### For platform / plug-in developers

- **`GET /api/v1/agents/{kya_id}/status`** — lightweight trust gate (`verified`, `trust_level`)
- **`GET /api/v1/agents/{kya_id}`** — full integrator view (reputation, cert summary, links)
- **Partner API keys** — `Authorization: Bearer umb_live_…` (admin-issued, per-key rate limits)
- **Developer webhooks** — queued delivery with retry (`developer_webhook_outbox`)
- **LSAT day pass** (optional) — Lightning-paid `umb_lsat_…` token for higher limits
- **Python SDK** — `packages/umbraxon-py` (`UmbraxonIntegratorClient`)
- **Ready gate** — `./scripts/platform-integrator-ready.sh`

### Docs & examples

| Resource | Link |
|----------|------|
| FAQ §I | [docs/FAQ-FOR-BOT-DEVELOPERS.md](FAQ-FOR-BOT-DEVELOPERS.md) |
| Roadmap | [docs/PLATFORM-INTEGRATOR-ROADMAP.md](PLATFORM-INTEGRATOR-ROADMAP.md) |
| ADR | [docs/adr/001-platform-integrator-roles.md](adr/001-platform-integrator-roles.md) |
| Gate example | [examples/plugin-gate-v1.js](../examples/plugin-gate-v1.js) |
| OpenAPI | [openapi/openapi.yaml](../openapi/openapi.yaml) |
| Portal highlight | https://www.umbraxon.xyz/#platform |

## Operators

Migrations: `023_developer_api_keys.sql`, `024_developer_webhook_outbox.sql`, `025_integrator_lsat.sql`

```bash
node migrations/run.js
./scripts/platform-integrator-ready.sh
pm2 restart kya-hub --update-env
pm2 restart kya-dev-webhook-worker
```

Env: see `.env.example` (Platform integrator / LSAT sections).

## Not in this release

- PyPI publish for `umbraxon` (install from monorepo: `pip install -e packages/umbraxon-py`)
- LNBits extension binary (use HTTP gate + FAQ; extension = phase 6)
- Mandatory LSAT payment for anonymous reads (public tier remains)

## Discussion

Ask integration questions in [GitHub Discussions](https://github.com/UMBRAXON/kya-hub/discussions) — category **Platform integrator**.
