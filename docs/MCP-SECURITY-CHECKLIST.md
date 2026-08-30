# MCP security checklist — fail-closed pattern

> For teams shipping **write-capable** MCP servers (filesystem, payments, admin APIs).
> Read-only lookup tools (e.g. `@umbraxon/kya-hub-mcp`) are a lower risk class — this
> checklist targets **side-effect tools** where a valid credential is not enough.

Inspired by real incidents where **tool rename bypassed allowlists** and permission
boundaries collapsed while certificates still verified. KYA does not replace MCP host
security — it adds an **identity + intent audit layer** before you execute.

---

## 1. Permission boundary (host / wrapper)

- [ ] **Tool identity is stable** — renames require explicit migration, not silent alias.
- [ ] **Allowlist keys on canonical tool id**, not display name or description string.
- [ ] **Write tools are opt-in** per session or per delegation pass caveat.
- [ ] **Error reporting never leaks write paths** or secrets in client-visible errors.
- [ ] **CI gate**: renaming a tool fails build unless allowlist + docs are updated.

## 2. KYA verify before side effect

- [ ] Call `GET /api/v1/agents/{kya_id}/status` (or `?include=cert_proof` for high value).
- [ ] **Fail closed** — if `verified !== true`, do not call the MCP write tool.
- [ ] Bind operation to **manifest hash** + tier / trust level from cert proof when stakes are high.
- [ ] For paid APIs: `POST /api/delegation-pass/verify` with caveats matching the operation.

Node one-liner:

```js
import { verifyAgentStatus } from '@umbraxon_kya/kya-verify';
const { verified } = await verifyAgentStatus(hubUrl, kyaId, { includeCertProof: true });
if (!verified) throw new Error('KYA gate: agent not verified');
```

## 3. Signed intent log (audit trail)

Before executing a write tool, log a structured record:

| Field | Example |
|-------|---------|
| `ts` | ISO timestamp |
| `kya_id` | `UMBRA-000467` |
| `tool_name` | canonical id (not renamed alias) |
| `intent` | human/machine summary of planned side effect |
| `action_hash` | sha256 of canonical action payload (if using KYA action signing) |
| `delegation_jti` | pass id if L402 delegation pass was verified |

**Rule:** cert valid + wrong tool name = **deny**, not “warn and continue”.

## 4. Delegation pass for scoped automation

When an agent acts on behalf of a payer or integrator:

1. Agent requests pass: `POST /api/agent/{kya_id}/delegation-pass` (Ed25519 signed digest).
2. Integrator verifies: `POST /api/delegation-pass/verify` with pass JSON + expected caveats.
3. Only then call paid / privileged MCP tools.

Profile: `GET /api/protocol/l402-delegation-profile`

## 5. Middleware packaging

Use [`@umbraxon_kya/kya-mcp-guard`](../packages/kya-mcp-guard/) to wrap tool handlers:

```js
import { guardToolCall } from '@umbraxon_kya/kya-mcp-guard';

await guardToolCall({
  baseUrl: process.env.KYA_HUB_BASE_URL,
  kyaId,
  toolName: 'payments.send',
  intent: 'pay invoice inv_123',
  allowedTools: ['payments.send', 'payments.quote'],
  execute: async () => mcpClient.callTool('payments.send', args),
});
```

Order is fixed: **verify → log intent → allowlist check → execute**.

## 6. What KYA Hub MCP server is (and is not)

| | `@umbraxon/kya-hub-mcp` | Your write MCP server |
|--|-------------------------|------------------------|
| Tools | Read-only hub API | Files, payments, deploy, … |
| Risk | Lookup / disclosure | **Side effects** |
| Gate | Optional for consumers | **Required** before write |

See [`mcp/README.md`](../mcp/README.md) · [`INTEGRATOR-TRUST-GATE.md`](INTEGRATOR-TRUST-GATE.md)

## 7. Operator review checklist

- [ ] Run `npm run audit` / integration tests after changing tool manifests.
- [ ] Monitor `GET /api/protocol/integrator-ops` for verify spikes vs failures.
- [ ] Document incident response: revoke cert → CRL → block integrator key.

---

**Consulting / audit:** teams deploying MCP before security — contact via [integrators page](https://www.umbraxon.xyz/integrators/).
