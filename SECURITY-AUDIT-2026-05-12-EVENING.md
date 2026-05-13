# UMBRAXON KYA-Hub — Security Audit (2026-05-12, evening, red-team / adversarial)

Audit window: 2026-05-12 17:30 – 18:45 UTC, on `kya-node-01` (Hetzner / Ubuntu 24.04).
Scope: external-facing API surface, filesystem, payment / webhook paths, certificate
issuance, anchor wallet, hub keys, NWC subscription, abuse-tracker, retention, new D
endpoints, new C invoice generator, R2 backup pipeline.

> **Status summary**
> - 1× P0 found — **fixed in this sprint** + PoC verifies the fix.
> - 2× P1 found — both **fixed in this sprint**.
> - 7× P2 documented with operator follow-ups; none gate continued operations.
> - No P0/P1 known to remain unmitigated at the close of this sprint.

The audit was conducted as a single-operator red-team pass (no external pen-test
firm). All findings below were derived from source review + live filesystem and
listening-port inspection.

---

## 1. Attack-surface map

### 1.1 External-facing (post-fix)
| Path / port | Behind | Auth | Notes |
| ----------- | ------ | ---- | ----- |
| `443/tcp` (nginx → 127.0.0.1:3000) | nginx | per-route (PoW / Ed25519 / X-Admin-Key) | only public entry |
| `443/tcp` (nginx → BTCPay docker) | nginx | API token | tested |
| `80/tcp`  → `443/tcp` redirect    | nginx | n/a | OK |
| `22/tcp`                          | sshd  | key auth | operator-only |
| `8080/tcp` (alby-hub)             | docker-bind | passwd | bound `*:8080` but UFW denies — verified |

**P0-1 fixed**: prior to this sprint, `app.listen(cfg.PORT, '0.0.0.0', ...)`
combined with UFW `ALLOW 3000/tcp` exposed the kya-hub Express server directly
on the public interface, **bypassing nginx, its rate-limits, and the public CSP
boundary**. An external attacker could have hit `/api/admin/*` directly with
a guessed `X-Admin-Key`.

Mitigation applied in this sprint:
- `server.js` now `app.listen(cfg.PORT, process.env.BIND_ADDR || '127.0.0.1', ...)`.
- `ufw delete allow 3000/tcp` (v4 + v6).
- PoC script `audits/2026-05-12/poc/p0-1-nginx-bypass.sh` verifies the fix
  (loopback still works, public-interface probe is refused).

### 1.2 Internal-facing
| Path / port | Listener bind | Process |
| ----------- | ------------- | ------- |
| `5432/tcp`  | `127.0.0.1` / `[::1]` | postgres |
| `3000/tcp`  | `127.0.0.1` (post-fix) | kya-hub |
| `19999/tcp` | `127.0.0.1` / `[::1]` | netdata |
| `8332/tcp`  | not listening externally | bitcoind RPC |
| Alby NWC    | outbound only | Alby NWC SDK over relay |

### 1.3 Filesystem
Sensitive paths inspected:

| Path | Mode | Owner | Notes |
| ---- | ---- | ----- | ----- |
| `/root` | **`755` → fixed to `700`** | root:root | P1-2 fixed |
| `/root/.bash_history` | `600` | root:root | OK |
| `/root/kya-hub/.env` | `600` | root:root | OK |
| `/root/kya-hub/.secrets/*` | `600` | root:root | OK |
| `/root/kya-hub/invoices/*.pdf` | `600` (new) | root:root | OK by design |
| `/root/backups` | `700` | root:root | OK |
| `/root/backups/<kind>` | **`755` → fixed to `700`** | root:root | P1-3 fixed |
| `/root/backups/postgres/*.dump.gz.enc` | `600` | root:root | OK |
| `lib/file-perm-watcher.js` | active, watches `.env` | — | OK |

---

## 2. Threat-by-threat findings

### 2.1 Webhook replay (BTCPay + Alby NWC)
- BTCPay: HMAC-SHA256 verified **before** `JSON.parse(req.body)` and before
  any DB mutation. ✓
- Idempotency: `webhook_deliveries (source, delivery_id)` UNIQUE constraint.
  Duplicate webhook returns `200 Duplicate (idempotent)` without re-processing.
- `recordWebhookDelivery` is called BEFORE `registerAgent` → safe even if the
  worker crashes mid-processing. ✓
- Alby NWC: `payment_hash` is the natural delivery ID and is also the
  unique payment hash on the network. Re-delivery is rejected. ✓
- **No replay vector found** in the current handler shape.

### 2.2 HMAC failure flood / signature DoS
- `BAD_HMAC_SIGNATURE` is severity **critical** in `lib/abuse-tracker.js`
  (auto-IP-ban after 20 violations in 10 min).
- `/api/webhook/btcpay` is **exempt** from the IP-ban middleware. That is
  intentional so a misconfigured BTCPay IP cannot be banned, but it means
  an attacker can keep firing 401s indefinitely. **Mitigation cost
  per request is negligible** (single sha256 + 256kb body limit).
- **P2-A** — accepted residual risk; documented for the operator.

### 2.3 Cert reissue race
- Reissue handler holds `BEGIN` + `UPDATE certificates SET is_current=FALSE
  ... WHERE kya_id=$1 AND is_current=TRUE RETURNING serial`. Postgres
  row-locks the old cert. New cert serial computed via `COUNT(*)` inside
  the same TX. ✓
- Strategic Sprint §30 P-1 (P-2 verified) closed this in 011_phase5b — no
  new race introduced by this sprint.

### 2.4 Anchor wallet drain
- Wallet `kya-anchor` lives inside bitcoind on localhost. RPC not exposed
  externally.
- `lib/anchor.js` checks ANCHOR_FEE_TARGET_BLOCKS + ANCHOR_MAX_FEERATE_SAT_VB.
  Hardcoded ceiling stops a maliciously high fee.
- `anchor-wallet-monitor` PM2 process not currently running (`stopped`) —
  operator follow-up.
- **P2-B** — restart `kya-anchor-wallet-monitor` if you want continuous low-
  balance alerts.

### 2.5 Hub key compromise
- Hub keys (BASIC / ELITE / ROOT) live in `hub_keys` table, encrypted at rest
  with HUB_KEY_ENCRYPTION_KEY (32-byte AES-GCM master). ROOT key is required
  for CRL signing only and is not used in the hot-cert path. ✓
- `lib/hubkeys.js` rotation flow exists (`scripts/rotate-hub-key.js`).

### 2.6 DB tampering / privilege model
- App user `kyahub_app` was introduced in 001_phase1 and uses limited DML
  perms. Migration 014 + 015 now explicitly `GRANT SELECT, INSERT, UPDATE,
  DELETE` (deny_list) / `GRANT SELECT, INSERT, UPDATE` (invoices). ✓
- DB user has **no** DROP / CREATE rights. Audit table updates only via
  `INSERT`.

### 2.7 Sybil via mfr signature
- Migration 010 introduced `manufacturers + manufacturer_attestations`.
- Attestation is one-shot (`consumed_at`); reuse fails idempotently. ✓
- `lib/sybil-resistance.js` provides age + tier + circle weighting. ✓

### 2.8 Reputation farming / review circle
- `detectReviewCircle()` weights reciprocal peer reports by 0.10× (90 %
  discount) for the last 30 days.
- Combined with Strategic Sprint §31 D no-custody penalty system, a banned
  pubkey now also costs 3× / 9× to re-register. ✓

### 2.9 NWC compromise
- NWC URI lives in `.env` + `.secrets/alby-nwc.txt` (both `600`). ✓
- Spending budget capped in Alby Hub side (operator-set).

### 2.10 Timing-attack on admin auth
- `lib/security.js#safeCompareTokens` uses `crypto.timingSafeEqual`. ✓
- `verifyHmacSignature` uses `timingSafeEqual` with length pre-check. ✓

### 2.11 DoS via CPU
- `/api/health` does a live BTCPay round-trip **on every hit**. An attacker
  flooding `/api/health` (which is IP-ban-exempt) could DoS BTCPay.
- **P2-C** — replace with cached upstream check (60 s TTL).

### 2.12 Log poisoning
- `pino` JSON logger does not interpolate user input as template strings;
  user-controlled values appear as JSON-encoded values. ✓

### 2.13 TLS / cert pinning
- nginx terminates TLS. Let's Encrypt rotation via certbot.
- Hub does NOT pin BTCPay's cert. Acceptable on a managed Hetzner host with
  trusted CA store; documented as **P2-D** for future hardening.

### 2.14 Time drift
- `chronyd` running with default NTP pool. `timestamp_skew` tolerance is
  +/- 5 min in `TIMESTAMP_SKEW_MS`. ✓

### 2.15 New D endpoints (pricing + deny-list)
- `/api/registration/quote` — read-only, no PII written to response besides
  what caller already had. Rate-limited via `phase2Limiter`.
- `/api/admin/agents/:kya_id/ban` — `X-Admin-Key` only, audited in
  `reputation_events` + bumps deny-list `ban_count`. Reason length capped at
  500 bytes.
- `/api/admin/agents/:kya_id/unban` — clears cooldown only; `ban_count` is
  intentionally **persistent** so the multiplier stays in force for next ban.
- `/api/admin/deny-list` — pubkey is **truncated to 16 chars** in the
  response (`pubkey_prefix`). Full pubkey only via direct DB access.

### 2.16 New C endpoints (PDF invoices)
- PDFs on disk at `chmod 600`. Directory `chmod 700`. ✓
- `/api/admin/invoices/:invoice_number/pdf` is admin-auth only.
- `/api/agent/:kya_id/invoice` is Ed25519-signed (5-min window) — same
  pattern as `/api/agent/:kya_id/data-export`. No CSRF possible (no cookie
  auth).
- R2 mirror uses the existing `BACKUP_S3_*` credentials. PDFs are NOT
  encrypted at rest in R2 — invoice contents include only `kya_id`,
  agent name, amount, and a public QR. Acceptable for these data classes
  per operator policy.

### 2.17 Webhook handler memory bound
- `express.raw({ type: 'application/json', limit: '256kb' })` on
  `/api/webhook/btcpay` + `64kb` on `/api/webhook/alby` caps the body. ✓
- Std JSON body parser is `100kb`. ✓

---

## 3. Findings table (consolidated)

| ID | Severity | Title | Status | Fix |
| -- | -------- | ----- | ------ | --- |
| P0-1 | P0 | Express on `0.0.0.0:3000` + UFW open → bypass nginx | **FIXED** | `BIND_ADDR=127.0.0.1` + UFW rule deleted |
| P1-2 | P1 | `/root` chmod `755` | **FIXED** | `chmod 700 /root` |
| P1-3 | P1 | `/root/backups/<kind>` subdirs `755` | **FIXED** | `chmod 700 /root/backups/*` |
| P2-A | P2 | Webhook endpoints IP-ban-exempt → unbounded HMAC-fail load | accepted | residual; cost per req trivial |
| P2-B | P2 | `kya-anchor-wallet-monitor` PM2 stopped | follow-up | `pm2 restart` when monitoring desired |
| P2-C | P2 | `/api/health` calls BTCPay live every request | follow-up | cache 60 s |
| P2-D | P2 | No outbound TLS pinning for BTCPay | follow-up | optional hardening |
| P2-E | P2 | `pdf_r2_uri` stored in invoices table — leaks bucket name to admin DB user | accepted | bucket itself is also in `.env` |
| P2-F | P2 | `/api/health` error messages include raw DB driver error | follow-up | mask before logging |
| P2-G | P2 | Multi-page rendering risk on long agent names | accepted | test rendered 1 page for realistic inputs |

---

## 4. Operator follow-ups (post-sprint)

1. Restart `kya-anchor-wallet-monitor` (currently stopped) for low-balance
   alerts.
2. Cache `/api/health` upstream probes (60 s TTL) to prevent DoS amplification.
3. Mask DB driver error in `/api/health` JSON (return generic `FAIL` + log
   the detail server-side only).
4. Decide whether to TLS-pin BTCPay (optional).
5. Confirm VAT treatment for AI-agent recipients before mass invoice
   issuance (note already in PDF footer).
6. Confirm R2 lifecycle in the Cloudflare dashboard per `UMBRAXON.md`
   section "R2 lifecycle (manual UI steps)" — the Bearer token shipped to
   this sprint could not manage lifecycle rules programmatically.

---

## 5. PoC inventory

`audits/2026-05-12/poc/`
- `p0-1-nginx-bypass.sh` — reproduces the pre-fix bypass (now refuses
  public-interface connections).

---

## 6. P0-2 — Reverse-proxy reachability after BIND_ADDR hardening (2026-05-12 ~19:40 UTC)

Follow-up to P0-1. Documented in detail in `UMBRAXON.md` §32.F. Terse summary:

**Symptom**: After P0-1 bound `kya-hub` to `127.0.0.1:3000`, public
`https://umbraxon.xyz/api/*` returned 503/timeout. Static `/terms` was
unaffected (alias-served by nginx).

**Root cause**: `kya-hub-proxy` runs on the user-defined Docker bridge
`generated_default` (`172.18.0.0/16`, gw `172.18.0.1`), not `docker0`
(`172.17.0.0/16`). With `kya-hub` on `127.0.0.1:3000`, no container on a
non-`docker0` bridge could reach it via `host.docker.internal` (mapped to
`172.17.0.1`).

**Fix**:
1. `.env`: `BIND_ADDR=0.0.0.0` (line 297; backup at
   `/root/kya-hub/.env.bak.p0fix.1778614741`).
2. UFW: `ufw allow from 172.18.0.0/16 to any port 3000 proto tcp comment
   'Docker generated_default → kya-hub'`. Default INPUT policy remains DROP.
3. `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
   && pm2 restart kya-hub --update-env`.

**Verification (2026-05-12 ~19:35 UTC, parent agent)**:

```bash
# 1. Public reachability — OK
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://umbraxon.xyz/api/health
#  → 200  ~0.030s
curl -sS -o /dev/null -w '%{http_code}\n' https://umbraxon.xyz/api/whitelist
#  → 200
#  (2026-05-13) ELITE entries additionally require listing state LISTED for
#  inclusion; BASIC rows unchanged — see UMBRAXON.md §26.5 / `lib/elite-listing.js`.
curl -sS -o /dev/null -w '%{http_code}\n' https://umbraxon.xyz/terms
#  → 200

# 2. Port 3000 still NOT reachable from internet:
#    - External probe at yougetsignal.com → "Port 3000 is closed on 46.225.170.80".
#    - Host-side  tcpdump -n -i any 'tcp port 3000' for 5 s during the external probe
#      captured 0 external SYNs (only loopback 127.0.0.1 ↔ 127.0.0.1 and
#      172.18.0.1 ↔ 172.18.0.3 = nginx-proxy → kya-hub).

# 3. UFW rule persists across boot:
ufw status numbered | grep -E '17(2\.17|2\.18)\.0\.0/16'
#  → ACCEPT IN  3000/tcp from 172.17.0.0/16
#  → ACCEPT IN  3000/tcp from 172.18.0.0/16   ← new (this fix)
grep -A1 '172.18.0.0/16' /etc/ufw/user.rules
#  → rule persisted (auto-saved by ufw allow).
systemctl is-enabled ufw
#  → enabled
```

**Persistence proof**:
- UFW rule → `/etc/ufw/user.rules` (auto-saved).
- `BIND_ADDR=0.0.0.0` → `/root/kya-hub/.env` (loaded by `server.js` on boot).
- PM2 process list → `pm2 save` ⇒ `/root/.pm2/dump.pm2` (so the post-fix
  kya-hub + 3 just-restarted cron workers survive reboot).

**Resolves** the P0 gate row #10 added to the §32.D table in `UMBRAXON.md`.

### 6.1 Updated findings-table delta

| ID | Severity | Title | Status | Fix |
| -- | -------- | ----- | ------ | --- |
| P0-2 | P0 | Reverse-proxy unable to reach `kya-hub` after P0-1 bind to 127.0.0.1 (all `/api/*` returned 503 from internet) | **FIXED** | `BIND_ADDR=0.0.0.0` + UFW allow `172.18.0.0/16 → :3000` + `pm2 restart kya-hub --update-env` |

P0-1's `BIND_ADDR=127.0.0.1` original intent (no public listen on `:3000`)
is preserved by UFW — port is still firewalled at the kernel from the
internet; only the two Docker bridges can reach it.

---

## 7. Infrastructure delta (2026-05-13, append-only)

- **PostgreSQL `PGDATA`** moved from `/var/lib/postgresql/16/main` to the Hetzner
  Cloud Volume at `/mnt/HC_Volume_105621586/postgresql/16/main` (`postgresql.conf`
  `data_directory`; logical backup before move under `/mnt/.../pg-insurance/`).
  **Rollback:** see `UMBRAXON.md` §22.11.
- **`/root/backups` + `/var/log`** already symlinked onto the same volume (Phase A).
- **Optional UFW hardening** after Cloudflare proxy is enabled: `scripts/ufw-restrict-http-to-cloudflare.sh`
  — documented in `UMBRAXON.md` §22.12–22.13 (`--dry-run` first).

