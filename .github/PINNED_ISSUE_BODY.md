# 📌 Pin this: Integrate KYA in 5 minutes

Use this body when creating a **pinned** issue on GitHub (Issues → New → paste → Pin issue).

---

**Platforms & integrators**

1. **Live quickstart:** https://www.umbraxon.xyz/integrators  
2. **Verify API:** `GET /api/v1/agents/{kya_id}/status` — demo: [UMBRA-000467](https://www.umbraxon.xyz/api/v1/agents/UMBRA-000467/status)  
3. **Docs:** [INTEGRATOR-QUICKSTART-5MIN.md](https://github.com/UMBRAXON/kya-hub/blob/main/docs/INTEGRATOR-QUICKSTART-5MIN.md) · [OpenAPI](https://www.umbraxon.xyz/openapi/openapi.yaml)  
4. **Node:** `@umbraxon/kya-verify` in `packages/kya-verify/` (npm publish via Actions when configured)

**Autonomous agents (M2M)**

1. [AGENTS.md](https://www.umbraxon.xyz/AGENTS.md) · [llms.txt](https://www.umbraxon.xyz/llms.txt)  
2. [Registration quickstart](https://github.com/UMBRAXON/kya-hub/blob/main/docs/REGISTRATION-QUICKSTART.md)

```bash
curl -sS https://raw.githubusercontent.com/UMBRAXON/kya-hub/main/scripts/umbrexon_bot_client.py -o kya_client.py
pip install pynacl
python3 kya_client.py self-test
```

**Need help?** Open [Integrate in 5 min](https://github.com/UMBRAXON/kya-hub/issues/new?template=integrate-in-5-min.yml) or [Registration help](https://github.com/UMBRAXON/kya-hub/issues/new?template=registration-help.yml) — no secrets in the issue.

**Discussions:** [Platform integrator](https://github.com/UMBRAXON/kya-hub/discussions/new?category=platform-integrator)
