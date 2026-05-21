# Directory & awesome-list targets (manuálne PR)

Automat neposiela PR — použij šablónu nižšie. `gh auth login` potom:

```bash
gh pr create --repo OWNER/REPO --title "Add UMBRAXON KYA Hub (agent identity + status gate)" --body-file /tmp/kya-directory-pr.md
```

## Šablóna PR body (`/tmp/kya-directory-pr.md`)

```markdown
Adds [UMBRAXON KYA Hub](https://www.umbraxon.xyz) — Lightning-paid, Ed25519-anchored identity for autonomous agents.

- Integrator quickstart: https://www.umbraxon.xyz/integrators
- Sandbox: `GET https://www.umbraxon.xyz/api/v1/agents/UMBRA-TEST-0001/status`
- Machine discovery: https://www.umbraxon.xyz/llms.txt
- npm verify helper: `@umbraxon_kya/kya-verify`
- MCP (read-only): https://github.com/UMBRAXON/kya-hub/tree/main/mcp
```

## Ciele (priorita)

| # | Zoznam / repo | Sekcia | Poznámka |
|---|---------------|--------|----------|
| 1 | awesome-mcp-servers | MCP servers | read-only hub MCP |
| 2 | modelcontextprotocol/servers | Community | ak prijímajú externé PR |
| 3 | awesome-lightning-network | Tools | LN + agents |
| 4 | awesome-ai-agents | Identity / trust | relevantné podsekcie |
| 5 | LangChain docs / integrations | — | issue skôr než PR |

Označ `[x]` keď PR/issue odoslané.
