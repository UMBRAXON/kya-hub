# KYA-Hub MCP server

**Package:** `@umbraxon/kya-hub-mcp` **1.1.0** (tracks hub **Integrations v1** / OpenAPI bundle 1.1).

Read-only [Model Context Protocol](https://modelcontextprotocol.io) bridge to the public UMBRAXON KYA-Hub HTTP API. Use it from Cursor, Claude Desktop, or any MCP client so models can look up certificates, reputation, tiers, and protocol metadata without copy-pasting JSON.

## Install

From the repository root:

```bash
cd mcp && npm install
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `KYA_HUB_BASE_URL` | `https://umbraxon.xyz` | Hub origin (no trailing slash). |
| `KYA_HUB_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `KYA_HUB_USER_AGENT` | (built-in) | Optional custom `User-Agent`. |

## Cursor

Add to your MCP settings (merge into `mcpServers`):

```json
"kya-hub": {
  "command": "node",
  "args": ["/ABSOLUTE/PATH/TO/kya-hub/mcp/src/index.js"],
  "env": {
    "KYA_HUB_BASE_URL": "https://umbraxon.xyz"
  }
}
```

Replace `/ABSOLUTE/PATH/TO/kya-hub` with your clone path.

## Tools

- `kya_health`, `kya_tiers`, `kya_hub_pubkey`, `kya_manifest_schema`, `kya_reputation_model`, `kya_protocol_versions`
- `kya_l402_delegation_profile`, `kya_delegation_pass_verify` (POST body is the pass JSON), `kya_discovery_agents` (optional `capability`, `limit`), `kya_embed_badge_status`
- `kya_cert`, `kya_cert_status`, `kya_cert_verify` (POST body `{ "certificate": { ... } }`)
- `kya_agent_reputation`, `kya_agent_events`, `kya_agent_actions` (optional `limit` / `offset`)
- `kya_manufacturers`, `kya_manufacturer`
- `kya_registration_quote` (`tier`, optional `pubkey` hex)
- `kya_crl_latest` — `GET /crl/latest.json` (404 if not deployed)

Registration, invoices, and signed agent actions are **not** exposed here; use the Python reference client or direct HTTP with Ed25519 signing.

## Resources

- `kya-hub://openapi` — local `openapi/openapi.yaml` from the repo checkout when present.
- `kya-hub://protocol-summary` — short integration summary.

## Test

Hermetic (no network):

```bash
cd mcp && npm test
```

Live (real HTTPS to the hub + MCP `tools/call` for `kya_health`). **Off by default** so CI stays isolated. Requires outbound HTTPS:

```bash
cd mcp && KYA_HUB_LIVE_TEST=1 npm run test:live
```

Optional: `KYA_HUB_BASE_URL=https://other-host.example` (no trailing slash) for another deployment, or `http://127.0.0.1:3000` when your hub runs locally.

If `fetch` fails with `getaddrinfo EAI_AGAIN` / `ENOTFOUND`, the machine cannot resolve or reach the host (VPN, DNS, or air-gapped CI). Hermetic CI does **not** run this step.
