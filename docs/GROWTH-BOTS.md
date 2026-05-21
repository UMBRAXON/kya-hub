# Growth boty a automatizácia

## PM2: prečo `kya-pr-*` ukazuje **stopped**

Procesy s `cron_restart` a `autorestart: false` **medzi behmi nie sú online** — PM2 ich označí ako `stopped`. To **nie je** vypnutá konfigurácia.

| Proces | Cron (UTC) | Čo robí |
|--------|------------|---------|
| `kya-pr-agent` | `0 10 * * *` | Denný Moltbook post |
| `kya-pr-engage` | `15 */3 * * *` | Moltbook komentáre |
| `kya-pr-nostr` | `0 14 * * 1,3,5` | Nostr note |
| `kya-growth-cycle` | `0 8 * * *` | Scout + community + demo witness |

Overenie posledného behu:

```bash
tail -30 /root/.pm2/logs/kya-pr-agent-out.log
tail -30 /root/.pm2/logs/kya-growth-cycle-out.log
```

**Problém v logoch (má 2026):** `kya-pr-engage` → `moltbook_auth_failed` — treba obnoviť `MOLTBOOK_API_KEY` v `agents/umbraxon-pr-agent/.env`.

Zapnutie po reštarte servera (ak cron nebeží):

```bash
cd /root/kya-hub
pm2 start ecosystem.config.js --only kya-pr-agent,kya-pr-engage,kya-pr-nostr,kya-growth-cycle
pm2 save
```

---

## GitHub (`gh`) vs `GITHUB_TOKEN`

| Nástroj | Stav na serveri | Použitie |
|---------|-----------------|----------|
| `gh` CLI | **Nie je prihlásený** — `gh auth login` | PR, issues, Discussions ty alebo ja po login |
| `GITHUB_TOKEN` v `agents/umbraxon-pr-agent/.env` | Voliteľné | Vyšší rate limit pre scout (`integrator-scout-issues.py`) |

Ja (Cursor agent) **nemôžem** robiť `gh pr create` kým neurobíš `gh auth login` na tomto stroji (alebo nezadáš token).

---

## Čo už beží bez nového bota

| Funkcia | Kde |
|---------|-----|
| Key-request → Telegram | `POST /api/v1/integrator/key-request` + `notifications.notifyIntegratorKeyRequest` |
| GitHub repo scan | `cd agents/umbraxon-pr-agent && python3 main.py github-scan` |
| PR denný cyklus | `python3 main.py run-cycle` |

---

## Nový balík `scripts/growth/`

| Skript | Úloha | Auto-post? |
|--------|--------|------------|
| `integrator-scout-issues.py` | GitHub issues (verify, Sybil, L402…) → draft komentár + curl | **Nie** — len súbory v `logs/growth/scout/` |
| `community-listener.sh` | HN Algolia + Reddit search → `logs/growth/community-*.json` | Nie |
| `demo-witness.sh` | `integrate-in-5min.sh` → `demo-witness-latest.txt` | Nie |
| `run-cycle.sh` | Všetko vyššie + voliteľne PR `github-scan` | Nie |

GSC: [`gsc-manual-checklist.md`](../scripts/growth/gsc-manual-checklist.md) — API vyžaduje OAuth projekt; zatiaľ manuálne v UI.

Directory: [`directory-targets.md`](../scripts/growth/directory-targets.md) — zoznam MCP/awesome listov + šablóna PR.

---

## Env

```bash
# Voliteľné pre scout (vyšší limit)
export GITHUB_TOKEN=ghp_...

# Growth cycle notifikácia pri zlyhaní demo witness (ak máš Telegram v hub .env)
# používa rovnaký mechanizmus ako hub notifikácie — pozri demo-witness.sh
```
