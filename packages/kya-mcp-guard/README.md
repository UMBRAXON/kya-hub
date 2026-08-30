# @umbraxon_kya/kya-mcp-guard

Fail-closed wrapper for **write-capable** MCP tool handlers.

Order: **verify KYA agent → log intent → tool allowlist → execute**.

Not a new protocol — packaging of patterns from KYA Hub (status gate, delegation pass,
action signing). See [`docs/MCP-SECURITY-CHECKLIST.md`](../../docs/MCP-SECURITY-CHECKLIST.md).

```bash
npm install @umbraxon_kya/kya-mcp-guard
# or from monorepo: npm install file:../../packages/kya-mcp-guard
```

```js
import { guardToolCall } from '@umbraxon_kya/kya-mcp-guard';

await guardToolCall({
  baseUrl: 'https://www.umbraxon.xyz',
  kyaId: 'UMBRA-000467',
  toolName: 'payments.send',
  intent: 'settle invoice inv_abc',
  allowedTools: ['payments.send', 'payments.quote'],
  includeCertProof: true,
  execute: async () => {
    // your MCP client callTool() here
    return { ok: true };
  },
});
```

## Options

| Option | Default | Purpose |
|--------|---------|---------|
| `requireVerified` | `true` | Throw `KYA_VERIFY_FAILED` if agent not verified |
| `allowedTools` | — | Throw `TOOL_NOT_ALLOWED` if `toolName` not in list |
| `includeCertProof` | `false` | Hub returns Ed25519 cert proof on status |
| `logIntent` | stderr JSON | Override for structured logging / SIEM |
| `verify` | built-in GET status | Inject mock in tests |

## Errors

| `code` | Meaning |
|--------|---------|
| `KYA_VERIFY_FAILED` | Agent failed hub status gate |
| `TOOL_NOT_ALLOWED` | Tool rename / allowlist bypass attempt |

## Related

- [`@umbraxon_kya/kya-verify`](../kya-verify/) — one-line status check
- [`mcp/`](../../mcp/) — read-only KYA Hub MCP server (lookup only)
- [KYA + L402 vs x402](../../docs/KYA-L402-VS-X402.md)
