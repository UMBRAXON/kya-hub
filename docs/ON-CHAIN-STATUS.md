# On-chain & transparency status (operator honesty)

What is **live in production** vs **planned** or **simulated**. Update this file when workers change.

| Capability | Status | Notes |
|------------|--------|--------|
| Lightning registration (BASIC/ELITE) | **Live** | Alby / BTCPay per intent |
| Ed25519 certificates + CRL | **Live** | HTTP + DB |
| CRL JSON files `/crl/` | **Live** | PM2 `kya-crl-worker` |
| CRL broadcast to Bitcoin | **Gated** | Requires `CRL_WORKER_BROADCAST_ENABLED=true` + wallet balance; see UMBRAXON.md |
| ELITE per-agent OP_RETURN anchor | **Partial** | Worker exists; confirm `kya-anchor-worker` + bitcoind sync |
| Merkle batch anchor (all agents) | **Planned / legacy sim** | `lib/anchor.js` — verify before claiming „anchored on Bitcoin“ in marketing |
| Integrator verify metrics | **Live** | `GET /api/protocol/integrator-ops` |
| Public economics disclosure | **Live** | `GET /api/protocol/economics` |

**Marketing rule:** Say „Lightning-paid identity + public CRL“ unless you have confirmed today's anchor tx in logs.

**Verify yourself (operator):**

```bash
pm2 status kya-anchor-worker kya-crl-worker
curl -fsS https://www.umbraxon.xyz/api/health | jq .
ls -la /root/kya-hub/public/crl/ | tail
```
