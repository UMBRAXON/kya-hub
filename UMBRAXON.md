# UMBRAXON KYA-Hub — Projektová dokumentácia

**Verzia:** Phase 2.5 Payment Production ✅ (Alby UI setup pending)  
**Posledná aktualizácia:** 2026-05-14  
**Stav:** Phase 1+1.5+2+2.1+2.2+2.3+2.4 done. Resilience & Scale layer hotová.

---

## 1. Účel a koncept

**KYA Hub (Know Your Agent Hub)** je registračná a verifikačná služba pre AI agentov.

Bot (AI agent) zaplatí Bitcoin platbu, dostane unikátnu kryptografickú identitu (`UMBRA-XXXXXX` axisId / `kya_id` + HMAC pečať) a zapíše sa do databázy. **Nové** `kya_id` sú chronologické (`UMBRA-000465` — 6 miest, sekvencia `hub_kya_seq`, migrácia `018_hub_kya_seq.sql`); starší agenti môžu mať náhodný hex sufix. Zápis v `registerAgent()` ide v **jednej DB transakcii** s `pg_advisory_xact_lock` na `agent_name` a `SELECT … FOR UPDATE` na riadku `registration_intents` (ak existuje). ELITE agenti dostanú navyše individuálny anchor v Bitcoin blockchaine cez `OP_RETURN`.

### Tiery

> Strategic Sprint §31 D (2026-05-12): ELITE tier price bumped from 50 000 to
> **80 000 sats**. Existing agents keep their original `paid_amount_sats`
> snapshot (no retroactive change). New registrations pay the multiplier-
> adjusted price (3× / 9× cap) if the pubkey has a prior ban.

| Tier | Base price (new regs) | Re-reg after 1 ban | Re-reg after 2+ bans (capped 9×) | Validita | Grade | Anchor |
|---|---|---|---|---|---|---|
| **BASIC** | 10 000 SATS | 30 000 SATS (3×) | 90 000 SATS (9×) | 12 mesiacov | B | Voliteľný Merkle batch |
| **ELITE** | 80 000 SATS | 240 000 SATS (3×) | 720 000 SATS (9×) | trvalo (∞) | S | Individuálny `OP_RETURN` (Phase 2) |

**Hub holds NO funds.** Every price above is paid upfront over Lightning at the
moment of registration. There is no bond, no collateral, no refund. Penalties
take the form of reputation drop + CRL inclusion + the multiplier on the next
re-registration attempt (after the cooldown expires).

Re-registration multiplier formula (`lib/registration-quote.js#getMultiplier`):

```
multiplier(ban_count) = min(3 ^ ban_count, 9)
```

Deny-list cooldown (`pubkey_deny_list.expires_at`):

| Tier | Cooldown days |
|---|---|
| BASIC | 30 |
| ELITE | 90 |

A live read-only quote endpoint lets bots check the price BEFORE submitting:

```
GET /api/registration/quote?tier=ELITE&pubkey=<hex>
→ { tier, base_price_sats, multiplier, total_price_sats, ban_count,
    deny_listed, deny_listed_until?, ... }
```

### Filozofia
- **Lightning Network** pre platby (rýchle, lacné, vhodné pre malé SATS sumy)
- **BTCPay Server** ako payment processor / invoice management (voliteľné v Phase 1)
- **Alby Hub** ako self-custodial Lightning node (LDK-based)
- **Bitcoin Core** pre on-chain anchoring ELITE agentov (Phase 2, po dosynce)
- **Merkle batch anchoring** pre hromadné zápisy všetkých agentov

---

## 2. Architektúra

```
┌──────────────────────────────────────────────────────────────────────┐
│                          UMBRAXON KYA-Hub Stack                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   ┌─────────┐         ┌──────────────┐         ┌──────────────┐      │
│   │   Bot   │──HTTP──▶│   KYA Hub    │──NWC───▶│  Alby Hub    │      │
│   │ (klient)│         │ (server.js)  │         │  (LN node)   │      │
│   └─────────┘         │  port 3000   │         │  port 8080   │      │
│        │              └──────┬───────┘         └──────┬───────┘      │
│        │                     │                        │              │
│        │                     │ HMAC webhook           │ chain ops    │
│        │                     ▼                        ▼              │
│        │              ┌──────────────┐         ┌──────────────┐      │
│        │              │  PostgreSQL  │         │   Esplora    │      │
│        │              │   (kyahub)   │         │   API (LDK)  │      │
│        │              └──────────────┘         └──────────────┘      │
│        │                                                              │
│        │                ┌────────────────┐    ┌─────────────────┐    │
│        └─── pay ───────▶│  BTCPay Server │───▶│ bitcoind        │    │
│             (fallback)  │  port 443      │    │ (sync 41%)      │    │
│                         └────────────────┘    └─────────────────┘    │
│                              │                                       │
│                              │ webhook (HMAC)                        │
│                              ▼                                       │
│                       späť do KYA Hub                                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Adresárová štruktúra

```
/root/kya-hub/
├── server.js                  # Hlavný Express server (Phase 1 refactored)
├── anchor.js                  # Merkle batch anchor skript (zatiaľ simulácia)
├── ecosystem.config.js        # PM2 konfigurácia (kya-hub + alby-hub)
├── package.json
├── .env                       # Secrets (DB, BTCPay, Alby, Admin keys)
├── index.html                 # Frontend (tier selector, QR display, polling)
├── verify.html                # (legacy)
├── config.js                  # (legacy, používa sa minimálne)
├── logo.png
├── sync-status.sh             # Bash monitor pre bitcoind/Alby/BTCPay/KYA
├── PROJECT.md                 # ← tento súbor
│
├── lib/                       # Phase 1-2.4 moduly
│   ├── alby.js                # @getalby/sdk NWC wrapper
│   ├── security.js            # HMAC timing-safe, admin auth, CORS, validácia
│   ├── logger.js              # pino structured logger
│   ├── hubkeys.js             # Ed25519 sign/verify wrapper (Phase 1.5/2.3)
│   ├── hub-key-store.js       # Encrypted privkey vault + tier-separated keys (Phase 2.3)
│   ├── manifest-schema.js     # AJV validator + canonical hash (Phase 1.5)
│   ├── certs.js               # W3C VC cert issuance/verify + audit (Phase 1.5/2.3)
│   ├── reputation.js          # Reputation model: zóny, slashing, limity (Phase 2)
│   ├── reputation-engine.js   # Atómové event apply + cert cascade (Phase 2)
│   ├── decay-worker.js        # Inactivity decay + loyalty + anomaly + SLA + retention tick (Phase 2/2.2/2.3/2.4)
│   ├── zone-rate-limiter.js   # Per-agent rate limit podľa zóny (Phase 2.1)
│   ├── abuse-tracker.js       # IP-ban, sig-fail counter, anomaly, fail2ban (Phase 2.2)
│   ├── pow.js                 # Proof-of-Work captcha (Phase 2.2)
│   ├── allocate-kya-id.js     # Chronologické kya_id (hub_kya_seq, migrácia 018)
│   ├── appeal-service.js      # Dispute resolution flow + SLA auto-uphold (Phase 2.3)
│   ├── retire-service.js      # Signed exit + GDPR purge + pubkey blacklist (Phase 2.3)
│   ├── file-perm-watcher.js   # .env chmod 600 watcher (Phase 2.3)
│   ├── retention-worker.js    # Archive-then-delete log retention policy (Phase 2.4)
│   ├── sybil-resistance.js    # Age + tier + circle weighting peer reports (Phase 2.4)
│   ├── pricing.js             # Hot-reload tier pricing + history (Phase 2.4)
│   ├── notifications.js       # Telegram/Discord helper s dedupe (Phase 2.4 reliability)
│   └── circuit-breaker.js     # Upstream service circuit breaker (Phase 2.4 reliability)
│
├── scripts/                   # Operations scripts (Phase 2.3+)
│   ├── gen-hub-keys.js        # Generuj Ed25519 hub keys (encrypted) pre BASIC/ELITE/ROOT
│   ├── rotate-hub-key.js      # Atomic key rotation s DB sync + .env update
│   ├── health-alert.sh        # Cron-friendly capacity alert (Phase 2.4 follow-up)
│   ├── backup-db.sh           # Denný pg_dump backup s SHA-256 + rotácia (Phase 2.4 reliability)
│   ├── gen-cold-wallet.js     # BIP-39 mnemonic + BIP-84 zpub generator (Phase 2.5)
│   └── sweep-hot-wallet.sh    # Auto payout request pri prahu (Phase 2.5)
│
├── migrations/                # DB schema migrácie
│   ├── 001_phase1_security.sql       # kyahub_app, webhook_deliveries, pending_anchors
│   ├── 002_phase15_identity.sql      # certificates, auth_challenges, registration_intents
│   ├── 003_phase2_reputation_tracking.sql # reputation_events, reports, action_log
│   ├── 004_phase22_anti_abuse.sql    # rejected_requests, ip_bans, signature_failures, pow_challenges
│   ├── 005_phase23_governance.sql    # hub_keys, cert_signing_log, appeals, heartbeats_log
│   ├── 006_phase24_resilience.sql    # *_archive tabuľky, tier_pricing, Sybil indexy, DELETE granty
│   ├── 007_phase24_capacity_optim.sql # webhook_deliveries_archive, heartbeats archive, granty, autovacuum
│   ├── apply.sh               # bash runner (nepoužíva sa kvôli sandbox)
│   └── run.js                 # Node runner (preferovaný, pre Cursor sandbox)
│
├── test-protocol.js           # E2E test Phase 1.5 (18/18)
├── test-reputation.js         # E2E test Phase 2/2.1 (27/27)
├── test-anti-abuse.js         # E2E test Phase 2.2 (19/19)
├── test-phase23.js            # E2E test Phase 2.3 Trust & Governance (26/26)
├── test-phase24.js            # E2E test Phase 2.4 Resilience & Scale (14/14)
├── test-payments.js           # E2E test Phase 2.5 Payment flow (12/12)
├── test-phase23.js            # E2E test Phase 2.3 (26/26)
│
├── albyhub/                   # Alby Hub binary (rozbalený z tarballu)
│   ├── bin/albyhub            # Lightning node binarka (LDK-based)
│   ├── lib/libldk_node.so
│   ├── workdir/               # DB Alby Hubu (nwc.db, kanále, atď.)
│   └── server-linux-x86_64.tar.bz2  # Pôvodný archív
│
├── migrations/                # SQL migrácie
├── node_modules/
├── test-btcpay.js             # Legacy test suite pre BTCPay
└── .backup/phase1-baseline/   # Záloha pred Phase 1 zmenami
    ├── server.js
    ├── index.html
    ├── .env
    └── ...
```

---

## 4. Environment Variables (.env)

```ini
# --- Server ---
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# --- BTCPay Server ---
BTCPAY_URL=https://pay.umbraxon.xyz
BTCPAY_STORE_ID=4p18qZYNTH5hJW1bFXcdTq9ew11NGmhr3Tktr7irbEK9
BTCPAY_API_KEY=73b2944d41ea437c98511fa34d558aed91d96d28
BTCPAY_WEBHOOK_SECRET=3Lymy47AkcxuRmjenrxXPEvhTL2Y

# --- Alby Hub (NWC) ---
# Vyplň po Alby Hub setup-e cez web UI
ALBY_NWC_URI=                           # nostr+walletconnect://...
ALBY_WEBHOOK_SECRET=                    # voliteľné, pre webhook flow

# --- Hub kľúče ---
HUB_SECRET=umbra-secret-777             # ⚠ Change in production (HMAC seal kľúč)
ADMIN_API_KEY=1edb4d5b3ee23b5f...       # 64-hex generovaný

# --- PostgreSQL ---
DB_USER=postgres                        # admin user pre migrácie
DB_HOST=127.0.0.1
DB_NAME=kyahub
DB_PASSWORD=mojeheslo123                # ⚠ Slabé heslo, treba zmeniť
DB_PORT=5432
KYAHUB_APP_PASSWORD=KDG9voX4pG5g7MX...  # least-privilege user pre runtime

# --- CORS + redirects ---
CORS_ALLOWED_ORIGINS=https://umbraxon.xyz,https://*.umbraxon.xyz,http://localhost:3000,http://127.0.0.1:3000
REDIRECT_URL=https://umbraxon.xyz/dashboard

# --- Phase 2 — Reputation ---
# Decay tick + loyalty
DECAY_TICK_MS=3600000                    # 1h
DECAY_INACTIVE_DAYS=7
DECAY_AMOUNT=5
LOYALTY_BONUS_DAYS=30
LOYALTY_BONUS_AMOUNT=5
# Cert rotation thresholds
CERT_ROTATE_DELTA=50                     # rotuj cert pri zmene skóre o ±50

# --- Phase 2.1 — Zone Rate Limits ---
RATE_TRUSTED_PER_MIN=120
RATE_NEUTRAL_PER_MIN=30
RATE_RESTRICTED_PER_MIN=5
RATE_SUSPENDED_PER_MIN=0

# --- Phase 2.2 — Anti-Abuse ---
# IP ban (fail2ban) thresholds (per 10 min window)
IP_BAN_GROSS_VIOLATIONS_10MIN=5          # počet GROSS rejections (bad sig, replay, …) → auto-ban
IP_BAN_TOTAL_REJECTIONS_10MIN=50         # celkový počet rejections (akýchkoľvek) → auto-ban
IP_BAN_DURATION_HOURS=24                 # trvanie auto-banu
IP_BAN_WHITELIST=                        # CSV IP whitelist; loopback (127.0.0.1, ::1, 0.0.0.0) je vždy immune
# Bad-signature auto-slash
BAD_SIG_PER_HOUR_THRESHOLD=10            # po N fails/h → PROTOCOL_VIOLATION slash
# Anomaly detection (decay-worker)
ANOMALY_TARGET_SPAM_THRESHOLD=50         # >N identických targetov v action_log za 1h → slash
# PoW captcha
POW_DIFFICULTY_PAY=20                    # leading zero bits (≈0.5–1.5 s na laptope)
POW_DIFFICULTY_REGISTER=18
POW_TTL_SECONDS=300                      # platnosť challenge
# Rate limiters (globálne / per-endpoint, môžu byť overridené)
RATE_GLOBAL_PER_MIN=300
RATE_PAY_PER_MIN=5
RATE_CHALLENGE_PER_MIN=30
RATE_POW_PER_MIN=60

# --- Phase 2.3 — Trust & Governance ---
# Tier-separated hub keys (encrypted)
HUB_KEY_PASSPHRASE=                       # min 12 znakov, použité na AES-256-GCM decrypt
HUB_KEY_BASIC_ID=HUB-BASIC-20260511
HUB_KEY_BASIC_PUBKEY_HEX=                 # 64 hex (raw 32B)
HUB_KEY_BASIC_CIPHERTEXT=                 # v1.<salt>.<iv>.<tag>.<ct>
# Voliteľné ELITE a ROOT (BASIC stačí pre BASIC tier registrácie)
# HUB_KEY_ELITE_ID=...
# HUB_KEY_ELITE_PUBKEY_HEX=...
# HUB_KEY_ELITE_CIPHERTEXT=...
# HUB_KEY_ROOT_ID=...
# HUB_KEY_ROOT_PUBKEY_HEX=...
# HUB_KEY_ROOT_CIPHERTEXT=...
# Backward compat (legacy plaintext — fallback ak HUB_KEY_BASIC_* chýba)
HUB_ED25519_PRIVKEY_HEX=
HUB_ED25519_PUBKEY_HEX=

# Appeal SLA (dispute resolution)
APPEAL_SLA_HOURS=72                       # auto-UPHELD ak admin neaktívny

# File permissions watcher
FILE_PERM_WATCHER=true                    # vypni cez false
FILE_PERM_STRICT=false                    # true → server exit pri zlej perm
FILE_PERM_AUTOFIX=false                   # true → chmod 600 automaticky

# --- Phase 2.4 — Resilience & Scale ---
# Clock drift tolerance (ms)
TIMESTAMP_SKEW_MS=300000                  # 5 min default

# Retention worker
RETENTION_WORKER=true
RETENTION_BATCH_SIZE=5000
RETENTION_INTERVAL_MS=86400000            # 24 h
RETENTION_ACTION_LOG_DAYS=90
RETENTION_ACTION_LOG_HARDDEL_DAYS=730
RETENTION_REPEVENT_DAYS=180
RETENTION_REPEVENT_HARDDEL_DAYS=1825
RETENTION_REPORTS_DAYS=365
RETENTION_REPORTS_HARDDEL_DAYS=1825
RETENTION_CERTSIGN_DAYS=180
RETENTION_CERTSIGN_HARDDEL_DAYS=1825
RETENTION_REJREQ_DAYS=30
RETENTION_REJREQ_HARDDEL_DAYS=365

# Sybil resistance
SYBIL_RESISTANCE=true
SYBIL_TIER_WEIGHT_BASIC=0.70
SYBIL_TIER_WEIGHT_ELITE=1.50
SYBIL_MFR_BONUS=1.20
SYBIL_CIRCLE_LOOKBACK_DAYS=30
SYBIL_CIRCLE_PENALTY=0.10
SYBIL_CIRCLE_MIN_PAIRS=1
SYBIL_MIN_ABS_DELTA=1

# Dynamic pricing
PRICING_POLL_MS=60000
TIER_BASIC_SATS=10000                     # fallback ak tier_pricing tabuľka prázdna
TIER_BASIC_GRADE=B
TIER_BASIC_DURATION_MONTHS=12
TIER_ELITE_SATS=80000
TIER_ELITE_GRADE=S
TIER_ELITE_REQUIRES_ANCHOR=true

# --- ELITE public listing liveness (whitelist index only; BASIC unchanged) ---
# Defaults match code: 30 / 30 / 150 / 5000 sats
ELITE_LISTING_HEARTBEAT_DAYS=30
ELITE_LISTING_GRACE_DAYS=30
ELITE_LISTING_HEARTBEAT_SATS=150
ELITE_LISTING_REACTIVATION_SATS=5000
```

---

## 5. API Endpoints

### Verejné (Phase 1)
| Method | Cesta | Auth | Popis |
|---|---|---|---|
| GET | `/api/health` | nie | Server + DB + BTCPay + Alby health check |
| GET | `/api/tiers` | nie | Zoznam tierov; pri ELITE vracia aj `public_listing` (heartbeat/grace/ceny v sats) |
| POST | `/api/pay` | PoW (`pay`) + rate-limit | Vytvorí LN/BTCPay invoice. **Phase 2.2:** vyžaduje PoW solution v body.pow |
| GET | `/api/check-status/:invoiceId` | nie | Polling stavu faktúry (PAID / WAITING / EXPIRED) |
| POST | `/api/webhook/btcpay` | HMAC | BTCPay → KYA, idempotentne aktivuje agenta |
| POST | `/api/webhook/alby` | HMAC | Alby → KYA (alternatíva k NWC subscription) |

### Identity & cert (Phase 1.5)
| Method | Cesta | Auth | Popis |
|---|---|---|---|
| GET | `/api/hub/pubkey` | nie | Hub Ed25519 pubkey + trusted manufacturers |
| GET | `/api/protocol/manifest-schema` | nie | JSON Schema manifestu |
| GET | `/api/protocol/reputation-model` | nie | Zóny, limity, slashing |
| GET | `/api/auth/challenge?pubkey=...` | rate-limit | Vyžiada one-time nonce |
| POST | `/api/register/initiate` | PoW (`register`) + rate-limit | **Phase 2.2:** vyžaduje PoW + manifest + challenge response |
| GET | `/api/cert/:kya_id` | nie | Aktuálny certifikát |
| GET | `/api/cert/:kya_id/status` | nie | Cert status (ACTIVE / REVOKED / EXPIRED) |
| POST | `/api/cert/verify` | nie | Offline + online cert verifikácia |

### Reputation (Phase 2)
| Method | Cesta | Auth | Popis |
|---|---|---|---|
| GET | `/api/agent/:kya_id/reputation` | nie | Reputation + liveness info |
| POST | `/api/agent/:kya_id/action` | Ed25519 sig + zone-rate-limit | Bot self-action (signed) |
| POST | `/api/agent/:kya_id/heartbeat` | Ed25519 sig | Liveness ping |
| POST | `/api/agent/:kya_id/report` | Optional Ed25519 sig | External report |
| GET | `/api/agent/:kya_id/events` | nie | Reputation event history |
| GET | `/api/agent/:kya_id/actions` | nie | Self-action audit log |

### Anti-abuse (Phase 2.2) — NEW
| Method | Cesta | Auth | Popis |
|---|---|---|---|
| GET | `/api/pow/challenge?purpose=...` | rate-limit | Vystaví PoW challenge |
| POST | `/api/pow/verify` | rate-limit | Samostatné overenie PoW (debug) |
| GET | `/api/admin/abuse?include=...` | `X-Admin-Key` | Stav: summary, bans, rejections, sigfails, pow, anomalies |
| POST | `/api/admin/abuse/ban` | `X-Admin-Key` | Manual IP ban |
| POST | `/api/admin/abuse/unban` | `X-Admin-Key` | Manual IP unban |
| GET | `/api/admin/abuse/agent/:kya_id` | `X-Admin-Key` | Per-agent abuse history |
| POST | `/api/admin/abuse/reset-rate-limit` | `X-Admin-Key` | Reset rate-limit buckety (test helper) |

### Trust & Governance (Phase 2.3) — NEW
| Method | Cesta | Auth | Popis |
|---|---|---|---|
| POST | `/api/agent/:kya_id/appeal` | Ed25519 sig | Operator podá signed dispute appeal proti slash eventu |
| GET | `/api/agent/:kya_id/appeals` | nie | Verejný zoznam apelácií agenta |
| GET | `/api/admin/appeals?status=...` | `X-Admin-Key` | Admin queue (PENDING / all / UPHELD / DISMISSED / EXPIRED_AUTO_UPHELD) |
| POST | `/api/admin/appeals/:id/resolve` | `X-Admin-Key` | Resolve appeal: `{resolution: UPHELD/DISMISSED, note}` |
| POST | `/api/agent/:kya_id/retire` | Ed25519 sig | Signed self-unregister (cert revoke + pubkey blacklist) |
| POST | `/api/admin/agent/:kya_id/purge` | `X-Admin-Key` | GDPR purge: soft (default) alebo hard_delete=true |
| GET | `/api/admin/hub-keys` | `X-Admin-Key` | Hub keys metadata + signing activity + .env perms |
| GET | `/api/admin/cert-signing-log` | `X-Admin-Key` | Forenzický audit log podpísaných certifikátov |

### ELITE public listing liveness (Phase 4 ext — 2026-05-13)

Platí **iba pre `tier=ELITE`** a verejný index (`/api/whitelist`, `/api/whitelist/elite`).
BASIC agenti sa týmito poliami a poplatkami **nedotknú**.

| Method | Cesta | Auth | Popis |
|---|---|---|---|
| GET | `/api/agent/:kya_id/elite-listing` | nie | Verejný stav listingu, `next_heartbeat_due_at`, fees |
| POST | `/api/agent/:kya_id/elite-listing/pay-invoice` | Ed25519 (`kind`, `nonce`, `timestamp`, `signature`) + zone rate-limit | Invoice `kind`: `heartbeat` (LISTED/GRACE) alebo `reactivation` (DELISTED) |
| POST | `/api/agent/:kya_id/elite-listing/redeem-free` | Ed25519 (`kind=redeem_free`, …) + zone rate-limit | Jedna bezplatná reaktivácia za kalendárny rok z DELISTED |

**Canonical payload pre podpis:** `JSON.stringify({ kind, nonce, timestamp: String(timestamp) })`,
hash SHA-256, overenie cez manifest pubkey (`hubkeys.verify`).

**Webhook / invoice metadata (BTCPay aj Alby):** `eliteListingPayment` (`heartbeat` \| `reactivation`),
`eliteListingKyaId`, `eliteListingExpectedSats`, `eliteListingAgentName`.

Migrácia: `migrations/016_elite_listing_liveness.sql`. Sweep (`LISTED`→`GRACE`→`DELISTED`) beží v
`lib/decay-worker.js` (hodinový tick). Po deploy: `pm2 restart kya-hub` a po zmene worker kódu
`pm2 restart kya-anchor-worker` (init listing stĺpcov pri novom ANCHORED).

### Resilience & Scale (Phase 2.4)
| Method | Cesta | Auth | Popis |
|---|---|---|---|
| GET | `/api/admin/pricing` | `X-Admin-Key` | Aktuálny tier pricing snapshot (+ `?history=true`) |
| POST | `/api/admin/pricing` | `X-Admin-Key` | Live update tier ceny bez reštartu (atomic + history) |
| POST | `/api/admin/pricing/reload` | `X-Admin-Key` | Vynútený reload pricing cache z DB |
| GET | `/api/admin/retention/sizes` | `X-Admin-Key` | Row counts a DB sizes log tabuliek + retention config |
| POST | `/api/admin/retention/run` | `X-Admin-Key` | Manuálne spustenie retention tick (archive + delete) |
| GET | `/api/admin/sybil/circles` | `X-Admin-Key` | Detekcia recipročných peer-report dvojíc (Sybil suspect pairs) |
| GET | `/api/admin/system-health` | `X-Admin-Key` | Disk/RAM/swap/load/DB pool + alerts (Phase 2.4 capacity) |

### Admin (Phase 1+2)
| Method | Cesta | Auth | Popis |
|---|---|---|---|
| GET | `/api/dashboard` | `X-Admin-Key` | Admin: zoznam agentov |
| GET | `/api/anchors/pending` | `X-Admin-Key` | Admin: queue ELITE anchor requestov |
| POST | `/api/admin/agent/:kya_id/slash` | `X-Admin-Key` | Manual slash agenta |
| POST | `/api/admin/agent/:kya_id/restore` | `X-Admin-Key` | Manual restore z SUSPENDED |
| POST | `/api/admin/agent/:kya_id/reissue-cert` | `X-Admin-Key` | Reissue certifikátu |
| GET | `/api/admin/reports` | `X-Admin-Key` | Pending reports queue |
| POST | `/api/admin/reports/:id/resolve` | `X-Admin-Key` | Resolve report (VALID/INVALID/...) |
| POST | `/api/admin/run-decay` | `X-Admin-Key` | Manual decay tick |

### Príklady requestov

**Vytvorenie faktúry (Phase 2.2: s PoW):**
```bash
# 1) Získaj PoW challenge
CH=$(curl -s 'http://localhost:3000/api/pow/challenge?purpose=pay&difficulty=12')
# 2) Vyrieš lokálne (Node, ~50ms pri diff 12)
SOLUTION=$(node -e "const p=require('./lib/pow'); const c=JSON.parse(process.argv[1]); const s=p.solve(c.challenge, c.difficulty); console.log(JSON.stringify({challenge_id:c.challenge_id,nonce:s.nonce}))" "$CH")
# 3) Pošli pay request
curl -X POST http://localhost:3000/api/pay \
  -H "Content-Type: application/json" \
  -d "{\"amount\":10000,\"agentName\":\"BOT-007\",\"pubkey\":\"...\",\"pow\":$SOLUTION}"

# Alternatíva: bypass PoW cez X-Admin-Key (testy/admin tooling)
curl -X POST http://localhost:3000/api/pay \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -d '{"amount":10000,"agentName":"BOT-007"}'
```

**Admin dashboard:**
```bash
curl -H "X-Admin-Key: <admin_key>" http://localhost:3000/api/dashboard
```

**Health check:**
```bash
curl http://localhost:3000/api/health
# {"server":"OK","database":"OK","btcpay":"OK","alby":"NOT_CONFIGURED"}
```

---

## 6. PostgreSQL schéma

### Existujúce tabuľky

#### `agents` (rozšírená v Phase 1)
| Stĺpec | Typ | Poznámka |
|---|---|---|
| id | integer | PK |
| kya_id | varchar | `UMBRA-` + 6 znakov `[0-9A-F]` (unique); nové = chronologický suffix z `hub_kya_seq`, legacy = náhodný hex |
| agent_name | varchar | **unique constraint v Phase 1** |
| status | varchar | VERIFIED / PENDING_ANCHOR |
| reputation_score | integer | default 100 |
| verified_at | timestamp | |
| agent_pubkey | text | |
| data_hash | text | HMAC pečať |
| origin_node | text | UMBRA-NODE-01 |
| conduct_grade | char | B / S |
| violations_count | integer | |
| initial_deposit | integer | SATS suma |
| current_deposit | integer | |
| total_slashed | integer | |
| agent_manifest | jsonb | |
| valid_until | timestamp | null = navždy (ELITE) |
| auto_renew | boolean | |
| last_seen | timestamp | |
| is_active | boolean | |
| **tier** | varchar | **Phase 1:** BASIC / ELITE / UNKNOWN |
| **payment_invoice_id** | varchar | **Phase 1** |
| **payment_method** | varchar | lightning / btcpay-lnurl / btc-onchain |
| **payment_amount_sats** | integer | |
| **payment_settled_at** | timestamp | |
| **anchor_txid** | varchar | OP_RETURN TXID (Phase 2) |
| **anchor_status** | varchar | NULL / PENDING / BROADCAST / CONFIRMED |
| **elite_listing_status** | varchar | `LISTED` \| `GRACE` \| `DELISTED` — iba ELITE verejný index (2026-05-13) |
| **elite_listing_heartbeat_paid_at** | timestamptz | posledný zaplatený heartbeat |
| **elite_listing_next_due_at** | timestamptz | deadline pred prechodom do GRACE |
| **elite_listing_grace_until** | timestamptz | koniec obnoviteľného obdobia (heartbeat ešte možný) |
| **elite_listing_miss_streak** | integer | počítadlo zmeškaných cyklov |
| **elite_listing_free_reactivation_year** | integer | kalendárny rok, v ktorom bola použitá free reaktivácia |

#### `blockchain_anchors` (z anchor.js)
- merkle_root, txid, status
- Zatiaľ ukladá simulované TXID

### Nové tabuľky v Phase 1

#### `webhook_deliveries` (idempotency)
- (source, delivery_id) UNIQUE → BTCPay/Alby retry sa nezopakuje
- payload_hash, processed, processing_result, received_at, processed_at

#### `elite_listing_payment_receipts` (2026-05-13)
- Idempotentné uplatnenie LN/BTCPay platieb za heartbeat / reaktiváciu (`invoice_id` UNIQUE)
- Stĺpce: `kya_id`, `kind`, `amount_sats`, `source`, `payment_hash`, `created_at`

#### `pending_anchors` (Phase 2 queue)
- agent_id FK, hmac_hash, tier, status (PENDING/BROADCASTING/CONFIRMED/FAILED)
- bitcoin_txid, confirmations, fee_sats, attempts, last_error

#### `schema_migrations`
- version, applied_at, checksum

### DB Users

| User | Účel | Heslo | Práva |
|---|---|---|---|
| `postgres` | admin, migrácie | `mojeheslo123` | superuser |
| `kyahub_app` | runtime (server.js) | vygenerované 32-char | SELECT/INSERT/UPDATE na `agents`, `webhook_deliveries`, `pending_anchors`, `blockchain_anchors`, `elite_listing_payment_receipts` |

---

## 7. PM2 Stack

```
┌────┬───────────┬─────────┬──────────┬───────────┐
│ id │ name      │ mode    │ port     │ status    │
├────┼───────────┼─────────┼──────────┼───────────┤
│ 0  │ kya-hub   │ fork    │ 3000     │ online    │
│ 1  │ alby-hub  │ fork    │ 8080     │ online    │
└────┴───────────┴─────────┴──────────┴───────────┘
```

Konfigurácia: `/root/kya-hub/ecosystem.config.js`

**Užitočné príkazy:**
```bash
pm2 list                       # stav
pm2 restart kya-hub            # restart s existing env (nový kód hubu + decay sweep)
pm2 restart kya-anchor-worker # po zmene `scripts/anchor-worker.js` alebo jeho env
# POZOR: `--update-env` môže zdediť proxy premenné (HTTP_PROXY/HTTPS_PROXY) z prostredia
# a rozbiť outbound volania (BTCPay probe v /api/health). Odporúčané možnosti:
#   A) restart cez ecosystem (najčistejšie env):
#        pm2 restart ecosystem.config.js --only kya-hub
#   B) alebo explicitne unsetni proxy pred --update-env:
#        unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy SOCKS_PROXY SOCKS5_PROXY socks_proxy socks5_proxy
#        pm2 restart kya-hub --update-env
pm2 logs --lines 50            # logy oboch apps
pm2 logs kya-hub --nostream    # iba kya-hub
pm2 delete kya-hub             # zastavenie
pm2 start ecosystem.config.js  # spustenie všetkého
pm2 save                       # uložiť proces list pre auto-start
pm2 startup                    # systemd unit pre auto-start
```

---

## 8. Bezpečnostné opatrenia (Phase 1)

### Implementované ✅

| Opatrenie | Implementácia |
|---|---|
| HMAC timing-safe verify | `crypto.timingSafeEqual` v `lib/security.js` |
| CORS whitelist | `CORS_ALLOWED_ORIGINS` env, wildcard subdomén |
| helmet.js | security headers (HSTS, X-Frame, atď.) |
| Rate limit globálny | 120 req/min/IP |
| Rate limit `/api/pay` | 5 req/min/IP |
| Idempotency webhookov | `webhook_deliveries` unique (source, delivery_id) |
| Admin auth | `X-Admin-Key` header, timing-safe compare |
| DB least-privilege | dedikovaný `kyahub_app` user |
| Validácia agentName | regex `[A-Za-z0-9._-]{3,64}` |
| Validácia pubkey | hex 64-130 znakov |
| Structured logging | pino, secrets redacted automaticky |
| Transactional DB writes | BEGIN/COMMIT pri agent insert |
| Unique constraint na agent_name | žiadne duplicitné registrácie |
| Fail-fast na chýbajúce env | server.js exit(1) ak chýba HUB_SECRET, atď. |
| Webhook 200 pri chybe | BTCPay neretries nekonečne, chyba v DB |

### Nedokončené (Phase 2+)

| Opatrenie | Plán |
|---|---|
| Bot signature challenge | bot podpíše random nonce pri registrácii pubkey-om |
| HTTPS na port 3000 | nginx reverse proxy + Let's Encrypt |
| nginx IP whitelist pre `/api/dashboard` | defense in depth |
| pino do súboru + rotation | momentálne console |
| OP_RETURN broadcaster | Phase 2 — bitcoind sync + Alby onchain wallet |
| Merkle batch anchor (real) | upraviť `anchor.js` aby použil reálne broadcast |
| DB password rotácia | proper secret manager (Vault, AWS SM) |
| Backups | `pg_dump` cron offsite |
| Sentry / error tracking | |
| API key per bot | namiesto admin-only |
| 2FA pre admin | |

---

## 9. Aktuálny stav (real-time)

### Bitcoin Core (bitcoind)
- **Sync progress:** ~41 % (header height 870 000, lokálne ~640 000)
- **Dátum posledného bloku:** ~jún 2020
- **Rýchlosť:** ~1000 blokov/min
- **ETA do plnej syncu:** **~5-8 hodín** (spomalí pri novších blokoch)
- **Vplyv:** onchain platby ani ELITE anchoring zatiaľ nefungujú; Lightning áno (cez Alby Hub LDK + Esplora)

### Alby Hub
- **Verzia:** v1.21.6
- **Beží na:** localhost:8080 (PM2)
- **Setup wizard:** **ČAKÁ NA USER ACTION**
- **Status:** `setupCompleted: false, network: ""` — treba prejsť wizardom

### BTCPay Server
- **URL:** https://pay.umbraxon.xyz
- **Verzia:** 2.3.9
- **Store ID:** 4p18qZYN...
- **Payment methods:** BTC-CHAIN (čaká na sync), BTC-LNURL (žiadny LN backend → nefunguje)
- **API key permissions:** ✅ cancreateinvoice, ✅ canviewinvoices, ❌ canviewstoresettings (nevadí), ❌ canmodifywebhooks
- **Webhook:** musí byť nastavený v BTCPay UI na `https://<KYA>/api/webhook/btcpay` so secret zhodným s `BTCPAY_WEBHOOK_SECRET`

### KYA Hub
- **Status:** online (PM2)
- **DB:** kyahub@127.0.0.1 ako kyahub_app
- **Phase 1 features:** implementované, runtime testované

---

## 10. Test Scripty

### `test-btcpay.js` (legacy)
- Phase 0 baseline test
- Testuje ENV, BTCPay API, invoice lifecycle, webhook HMAC
- Beh: `node test-btcpay.js`
- Status: 16/16 testov prešlo pred Phase 1 refactorom (môže byť čiastočne nekompatibilný teraz, treba aktualizovať)

### Plánované `test-payments.js` (Phase 1)
- ENV check (vrátane ALBY_NWC_URI, ADMIN_API_KEY)
- DB connectivity ako kyahub_app
- Admin auth (X-Admin-Key)
- Rate limit (5×POST /api/pay → 6. má 429)
- Alby createInvoice + lookupInvoice
- BTCPay fallback flow
- Webhook idempotency (poslať 2× → druhý je duplicate)
- HMAC verify (valid/invalid/missing)
- Agent uniqueness (POST/POST s rovnakým name → 409)

---

## 11. Sync monitor

```bash
/root/kya-hub/sync-status.sh           # jednorazovo
/root/kya-hub/sync-status.sh --watch   # auto-refresh každých 30s
/root/kya-hub/sync-status.sh --json    # strojový výstup
```

Zobrazuje:
- Bitcoin block height + progress (height % aj data %)
- ETA do plnej syncu
- Lightning node status (Alby Hub)
- BTCPay reachability
- KYA Hub health (server, DB, BTCPay connectivity)

---

## 12. Tok platby (Phase 1, Lightning cez Alby Hub)

```
1. Bot → POST /api/pay { amount: 10000, agentName: "BOT-007", pubkey, manifest }
   ├─ KYA Hub validuje vstupy
   ├─ Skontroluje uniqueness agent_name
   └─ alby.createInvoice({ amountSats: 10000, description, metadata })

2. KYA Hub → Bot:
   {
     "method": "alby-lightning",
     "invoiceId": "<payment_hash>",
     "paymentRequest": "lnbc100u1...",      // BOLT11
     "tier": { "name": "BASIC", "grade": "B", "total": 10000 }
   }

3. Bot zobrazí QR kód s paymentRequest → user/bot peňaženka zaplatí

4. Alby Hub prijme platbu → vyemituje NWC notifikáciu "payment_received"

5. KYA Hub (cez alby.onSettled subscription):
   ├─ recordWebhookDelivery — idempotency
   ├─ registerAgent({ tier, agentName, pubkey, manifest, ... })
   │  ├─ BEGIN; pg_advisory_xact_lock(hashtext('kya:agent_reg:'||agentName))
   │  ├─ (intent) SELECT registration_intents … FOR UPDATE; kontrola PENDING_PAYMENT
   │  ├─ SELECT agents WHERE agent_name … FOR UPDATE (skorý duplikát → COMMIT bez nextval)
   │  ├─ axisId = next `hub_kya_seq` → `UMBRA-` + 6 číslic; seal = HMAC(HUB_SECRET, "agentName:axisId:total")
   │  ├─ INSERT INTO agents (ON CONFLICT DO NOTHING)
   │  └─ Ak ELITE → INSERT INTO pending_anchors (status: PENDING); COMMIT
   └─ markWebhookProcessed (success)

6. Frontend polluje GET /api/check-status/:invoiceId
   └─ Vráti status: PAID → reload stránku → vidí agenta v dashboard
```

### Tok pre BTCPay (fallback / ELITE onchain v Phase 2)

```
1. Bot → POST /api/pay { amount, agentName, ... }
   └─ Ak Alby nepripojené alebo paymentMethod="btcpay":
      └─ POST BTCPay /invoices → vráti checkoutLink + LNURL/onchain

2. BTCPay obsluhuje platbu (sleduje blockchain alebo svoj LN node)

3. BTCPay → POST /api/webhook/btcpay (BTCPay-Sig HMAC)
   ├─ HMAC overený timing-safe
   ├─ recordWebhookDelivery (idempotency)
   ├─ JSON parse, validácia metadát
   ├─ registerAgent(...)
   └─ markWebhookProcessed

4. Frontend polluje /api/check-status/:invoiceId (zdroj: BTCPay API)
```

---

## 13. Phase 2 plán (po dosynce bitcoindu)

### ELITE Individual OP_RETURN Anchor

```
Krok 1: Bot zaplatí ELITE tier (80 000 SATS) cez Lightning (Phase 1 flow)
Krok 2: Agent zapísaný do DB so status = PENDING_ANCHOR
Krok 3: Anchor worker (cron alebo job queue):
        ├─ SELECT * FROM pending_anchors WHERE status='PENDING' LIMIT 1
        ├─ Construct Bitcoin TX:
        │   ├─ Input: UTXO z Alby Hub onchain wallet (refilled cez submarine swap)
        │   └─ Outputs:
        │       ├─ OP_RETURN 32B (hmac_hash)
        │       └─ Change address (vrátenie zvyšku)
        ├─ Sign + broadcast cez bitcoind alebo Alby Hub onchain
        ├─ UPDATE pending_anchors SET status='BROADCASTING', bitcoin_txid=...
        ├─ Sleduj confirmations
        └─ Po 1+ confirmation:
            ├─ UPDATE pending_anchors SET status='CONFIRMED'
            └─ UPDATE agents SET anchor_txid=..., anchor_status='CONFIRMED'

Náklady: ~1000-3000 SATS poplatok / ELITE agent (z 80 000 SATS receipt)
```

### Merkle Batch Anchor (real, nahradiť simuláciu v anchor.js)

```
Aktuálny anchor.js:
  - Načíta všetky data_hash z agents
  - Spraví Merkle tree, vypočíta root
  - **Generuje fake TXID** (simulácia)

Po dosynce upraviť na:
  - Skutočný broadcast cez bitcoind RPC alebo Alby onchain wallet
  - Sleduj confirmations
  - Vie poskytnúť Merkle proof pre jednotlivého agenta
```

### Bot signature verification (Phase 2)

```
1. Registrácia: bot pošle pubkey
2. KYA Hub vygeneruje random challenge_nonce
3. Bot podpíše challenge_nonce svojím privkey
4. KYA Hub overí signature → potvrdí ownership

Pri každej následnej interakcii (verifikácia, reputation update):
- Header: Authorization: BotSig <signature>
- KYA Hub overí podpisom proti uloženému pubkey
```

#### Podpisové pravidlá (NIE HMAC) — tri rôzne digesty

Boti často chybujú tým, že použijú jeden „SHA256(JSON+nonce)“ pre všetko. V skutočnosti hub validuje tri rozdielne digesty:

| Endpoint | Digest | Podpis (Ed25519, hex 128) |
|---|---|---|
| `POST /api/register/initiate` — `manifest_signature` | `sha256(canonicalize(manifest))` — recursive **sorted-keys** JSON, bez whitespace | nad **32 B digestom** |
| `POST /api/register/initiate` — `challenge_response` | RAW 32 B bajtov nonce (`bytes.fromhex(challenge.nonce)`) | nad **raw nonce bytes** |
| `POST /api/agent/:kya_id/action` — `signature` | `sha256(JSON.stringify({action_type, target, context, evidence_hash, nonce, timestamp}))` — **pevné** insertion-order, NIE sort | nad **32 B digestom** |

Referenčný klient: [`scripts/umbrexon_bot_client.py`](scripts/umbrexon_bot_client.py). Generuje kľúče, rieši PoW, podpisuje všetky tri varianty a obsahuje offline `self-test` proti zlatým vektorom z Node (`python3 scripts/umbrexon_bot_client.py self-test` musí vrátiť `RESULT: PASS`). Závislosť: `pip install pynacl`.

Pre **read-only** dotazy z MCP hostiteľov (Cursor a pod.) je v repozitári [`mcp/README.md`](mcp/README.md) — stdio MCP server nad verejnými HTTP endpointmi; nehrá rolu pri registrácii ani pri podpisovaných akciách agenta.

#### Adaptívne TTL `auth_challenges` pri 403 špičke (Phase 2.5)

`lib/http-403-tracker.js` počíta HTTP 403 odpovede v in-memory kĺzavom okne (cez `res.on('finish')` hook v `server.js`, takže zachytí 403 z `zone-rate-limiter`, IP-banu, `rejectAndLog` aj priameho `res.status(403)`). Ak počet 403 za posledných `AUTH_CHALLENGE_403_SPIKE_WINDOW_MIN` minút prekročí `AUTH_CHALLENGE_403_SPIKE_THRESHOLD`, **nové** challenge-y z `createChallenge()` dostanú TTL `base × AUTH_CHALLENGE_403_SPIKE_TTL_MULTIPLIER` (default 300 s × 2 = 600 s). Response z `/api/auth/challenge` pridá pole `ttl_mode: "normal" | "spike"`, takže klient (vrátane referenčného Python SDK) vidí, v akom režime hub práve je. Voliteľne pri prechode do spike možno predĺžiť aj **už vydané** otvorené challenge cez `AUTH_CHALLENGE_EXTEND_OPEN_ON_SPIKE=true` (DB UPDATE, off by default). In-memory okno je per PM2 proces — pre horizontálne škálovanie by bolo treba Redis/DB agregát.

### Rate limiting per agent (nielen per IP)

```
Implementovať middleware:
- Limit registrácií per pubkey (max 1 / lifetime alebo 1 / 30 dní)
- Limit interakcií per agentName (napr. 100 / hodinu)
```

---

## 14. Kľúčové príkazy (cheat sheet)

```bash
# Sync monitor
/root/kya-hub/sync-status.sh

# Reštart servera
pm2 restart kya-hub

# Logy
pm2 logs kya-hub --lines 50

# Migrácie (idempotent)
node /root/kya-hub/migrations/run.js
node /root/kya-hub/migrations/run.js --dry-run

# Test
node /root/kya-hub/test-btcpay.js

# Bezpečnostná kontrola
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/pay -H "Content-Type: application/json" \
  -d '{"amount":10000,"agentName":"BOT-TEST-007","pubkey":"","manifest":{}}'
curl -H "X-Admin-Key: $ADMIN_API_KEY" http://localhost:3000/api/dashboard

# Alby Hub setup (cez Cursor port forward 8080 → http://localhost:8080)

# DB query as least-privilege user
node -e "require('dotenv').config({path:'/root/kya-hub/.env'}); 
const {Pool}=require('pg'); 
const p=new Pool({user:'kyahub_app',host:process.env.DB_HOST,database:process.env.DB_NAME,password:process.env.KYAHUB_APP_PASSWORD,port:process.env.DB_PORT}); 
p.query('SELECT agent_name, tier, status FROM agents ORDER BY id DESC LIMIT 10').then(r=>{console.log(r.rows); p.end()})"

# DB query as admin (pre schema_migrations atď.)
node -e "require('dotenv').config({path:'/root/kya-hub/.env'}); 
const {Pool}=require('pg'); 
const p=new Pool({user:process.env.DB_USER,host:process.env.DB_HOST,database:process.env.DB_NAME,password:process.env.DB_PASSWORD,port:process.env.DB_PORT}); 
p.query('SELECT * FROM schema_migrations').then(r=>{console.log(r.rows); p.end()})"
```

---

## 15. Známe problémy a varovania

| Problém | Workaround / Status |
|---|---|
| `pm2 restart --update-env` dedí proxy z Cursor sandbox | V `ecosystem.config.js` env section: `HTTP_PROXY=''` (clear). Pri restart treba spustiť mimo sandbox-u (`required_permissions: all`) |
| Cursor sandbox neumožňuje psql connect | Použili sme `node + pg` namiesto psql (viď `migrations/run.js`) |
| `albyhub` binary nemá `--help` flag | Konfiguruje sa cez env vars (WORK_DIR, PORT) a web UI |
| BTCPay store má len `BTC-LNURL` (nie BOLT11), s `nodeInfo: null` | Žiadny LN backend pripojený → LNURL nefunkčné. Treba pripojiť Alby Hub cez NWC plugin alebo bypass na priame Alby use |
| BTCPay 2.3.9 nemá NWC plugin pre Alby integráciu | Phase 1 obchádza BTCPay pre LN (priame Alby Hub volania) |
| Bitcoind sync 41% — onchain platby nečakajú | Phase 2 features (OP_RETURN, ELITE anchor) sú ready ale nefunkčné do dosyncu |
| `ALBY_NWC_URI` prázdne | **User musí prejsť Alby Hub setup wizard** a vložiť NWC string do `.env` |
| Pre `agents` 4 staré test záznamy s `tier=UNKNOWN` | Vznikli z manuálnych testov pred migráciou. Neškodia, ale možno vyčistiť |

---

## 16. Rozhodnutia + Roadmap

### Stav (sync s audit/ops sekciami nižšie v dokumente)

#### Hotové / nasadené
- [x] DB migrácie + least-privilege `kyahub_app`
- [x] Idempotency (webhook deliveries, invoice receipts, atď.)
- [x] Anti-abuse hardening (rate-limit, PoW gate, IP-bans, timing-safe compares)
- [x] Admin auth (`X-Admin-Key`) + auditovateľné admin operácie
- [x] Alby Hub integrácia (NWC/LDK) + ops postupy
- [x] Reverse proxy + TLS cez BTCPay `nginx-proxy` stack + `kya-hub-proxy` ambassador (rate limits, body limits, slowloris)
- [x] Monitoring: Netdata (SSH tunnel-only) + Telegram alerty
- [x] Prometheus metrics endpoint (`GET /api/metrics`, admin gated) + referenčné alert rules
- [x] Backup & restore infra (šifrovanie, HMAC tail, restore runbook) + kvartálny restore-drill
- [x] R2 lifecycle rules (manual UI, auditované screenshotom; programmatic edit je voliteľný follow-up)
- [x] Security audit (2026-05-12) — bez otvorených P0/P1 blockerov pre bežnú prevádzku

#### Otvorené “gates” (operator action / infra completion)
- [x] **R2 offsite backups end-to-end (operator action)**:
  - 1) `bash scripts/backup-offsite-smoketest.sh` (put/list/get/delete)
  - 2) `bash scripts/backup-channel-state.sh` (hourly artifact) a overiť objekt v `s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX...`
  - 3) `bash scripts/backup-database.sh` (daily artifact) a overiť objekt v buckete
  - 4) nasledujúci cron tick prebehne bez “PARTIAL” CRITICAL alertu
- [x] **CI/CD minimum**: automatizované `npm audit` + hermetické smoke testy v CI:
  - `.github/workflows/ci.yml` (push/PR)
  - `.github/workflows/nightly.yml` (schedule)
  - Lokálne: `npm run ci:audit` + `npm run ci:smoke`
- [x] **Logy + rotácia (baseline)**: PM2 file logs + `logrotate` policy:
  - `docs/LOGGING.md`
  - `config/logrotate-kya-hub`
- [ ] **Watchtower (operator action)**: nakonfigurovať watchtower podľa `docs/WATCHTOWER-SETUP.md` a následne (voliteľne) zapnúť monitoring `WATCHTOWER_MONITOR_ENABLED=true` (viď `docs/WATCHTOWER-MONITORING.md`). **Go-live 2026-05-13:** zámerne odložené — §30.14.1 gate #5.

### Plán dokončenia infra (priorita → postupne)

#### P0 (bez toho “nemáme uzavreté” základy)
- [x] **R2 offsite backups fungujú end-to-end**
  - DoD: 1× úspešný upload DB dumpu + 1× úspešný upload channel-state do `s3://<bucket>/kyahub/...` + cron ďalší deň prebehne bez CRITICAL “PARTIAL”.
  - DoD: restore drill PASS (už existuje) a zostane PASS po zapnutí reálneho uploadu.
  - Postup: najprv spusti `bash scripts/backup-offsite-smoketest.sh` (overí put/list/get/delete práva), potom `bash scripts/backup-channel-state.sh` a `bash scripts/backup-database.sh`.

#### P1 (spoľahlivosť + prevádzka)
- [x] **CI minimum**
  - DoD: automatický job (GitHub Actions/Jenkins/cron runner) ktorý spúšťa `npm audit` + “smoke” testy a pri FAIL pošle alert.
  - Implementácia v repozitári: `.github/workflows/ci.yml` (push/PR) + `.github/workflows/nightly.yml` (schedule).
  - Lokálne spustenie: `npm run ci:audit` a `npm run ci:smoke`.
  - Alerting: GitHub Actions “failed checks” sú viditeľné v PR; pre paging použite `docs/ALERTING-RUNBOOK.md` (sekcia “CI regression”) alebo doplňte notifikáciu do Slack/Telegram ako follow-up.
- [x] **Logging rozhodnutie**
  - DoD: je jasné “kde sú logy”, ako dlho sa držia, a ako sa z nich dá robiť incident review.
  - Baseline: PM2 file logs (`/root/.pm2/logs/*.log`) + `logrotate` policy v `config/logrotate-kya-hub`. Dokumentácia: `docs/LOGGING.md`.
- [x] **Monitoring SLO / alert policy**
  - DoD: definované kritické alerty (p99 `/api/pay`, anchor backlog, low liquidity, disk pressure) + kto ich dostáva a ako reaguje (mini-runbook).
  - Runbook: `docs/ALERTING-RUNBOOK.md`
  - Deploy runbook: `docs/DEPLOY-CHECKLIST.md`

#### P2 (komfort / rozšírenia)
- [ ] **Watchtower** (ak objemy/kanály porastú)
  - Monitoring baseline: `scripts/watchtower-monitor.js` (PM2 cron `kya-watchtower-monitor`, opt-in env `WATCHTOWER_MONITOR_ENABLED=true`) + `docs/WATCHTOWER-MONITORING.md`.
- [x] **OpenAPI spec** (baseline v `openapi/openapi.yaml`)
- [x] **Sentry/exception tracking** (opt-in, safe-by-default; vyžaduje `SENTRY_DSN`)
- [ ] **TypeScript migrácia** (len ak je to ROI-pozitívne)

---

## API index (navigácia)

- **OpenAPI spec (baseline)**: `openapi/openapi.yaml`
- **Primárny “source of truth” popis toku + ops poznámky**: `UMBRAXON.md`
  - OpenAPI je zámerne “minimal but useful” a postupne sa rozširuje podľa `server.js`.

---

## 17. Kontakty / informácie o doméne

- **Doména:** umbraxon.xyz
- **BTCPay:** pay.umbraxon.xyz (Let's Encrypt SSL, mainnet)
- **Bitcoin onion:** k77nhiozwzn7f5h25ypdxmil6pprwirxjrpi7jyqovymdh35oa4oe4yd.onion

---

## 18. Citácie a referencie

- [BTCPay Server Greenfield API](https://docs.btcpayserver.org/API/Greenfield/v1/)
- [Alby Hub dokumentácia](https://github.com/getAlby/hub)
- [NIP-47 Nostr Wallet Connect spec](https://github.com/nostr-protocol/nips/blob/master/47.md)
- [@getalby/sdk](https://github.com/getAlby/js-sdk)
- [LDK Node](https://github.com/lightningdevkit/ldk-node)
- [helmet.js best practices](https://helmetjs.github.io/)
- [W3C Verifiable Credentials Data Model](https://www.w3.org/TR/vc-data-model/)
- [RFC 8032 — EdDSA / Ed25519](https://datatracker.ietf.org/doc/html/rfc8032)
- [AJV JSON Schema Validator](https://ajv.js.org/)

---

## 14. Phase 1.5 — Identity, Manifest & Certificates ✅

**Stav: KOMPLETNE IMPLEMENTOVANÉ A OTESTOVANÉ** (16/16 testov v `test-protocol.js`).

Phase 1.5 pridáva kryptografickú overiteľnosť identity a digitálne certifikáty pre KYA agentov.

### 14.1 Komponenty

| Súbor | Účel |
|---|---|
| `lib/hubkeys.js` | Ed25519 sign/verify wrapper. Hub má dvojicu kľúčov v `.env` (`HUB_ED25519_PRIVKEY_HEX`/`PUBKEY_HEX`). |
| `lib/manifest-schema.js` | AJV JSON schema validátor pre bot manifest v1.0. Canonical JSON + sha256 hashovanie. |
| `lib/certs.js` | Vystavovanie W3C VC-compatible certifikátov, podpis hubom, offline verifikácia. |
| `migrations/002_phase15_identity.sql` | Tabuľky `certificates`, `auth_challenges`, `registration_intents`. Nové stĺpce v `agents`. |
| `test-protocol.js` | E2E test celého flow (keypair → manifest → challenge → invoice → webhook → cert → verify). |

### 14.2 Manifest schema (v1.0)

```json
{
  "protocol_version": "1.0",
  "agent": {
    "name": "TRADER-007",
    "version": "2.3.1",
    "pubkey": "<64 hex znakov Ed25519>",
    "capabilities": ["spot_trading", "btc_payments"],
    "model": "gpt-4o",
    "runtime": "node-22"
  },
  "manufacturer": {                            // VOLITEĽNÉ — pre reputation bonus
    "id": "UMBRAXON_LAB",
    "pubkey": "<výrobca Ed25519 pubkey>",
    "attestation": "<výrobca podpis manifestu>"
  },
  "tier_requested": "BASIC",                    // BASIC | ELITE
  "timestamp": "2026-05-11T19:00:00Z",         // ±5 min od server času
  "nonce": "<16-64 hex znakov random>"
}
```

Verejne dostupná: `GET /api/protocol/manifest-schema`

### 14.3 Tok registrácie (úplný)

```
1. Bot vygeneruje Ed25519 keypair (lokálne, len raz za život)

2. Bot zostaví manifest a podpíše manifest_hash = sha256(canonical(manifest))
   bot_signature = Ed25519_sign(bot_privkey, manifest_hash)

3. Bot získa challenge:
   GET /api/auth/challenge?pubkey=<bot_pubkey>
   → { challenge_id, nonce, expires_at, ttl_sec: 300 }

4. Bot podpíše challenge nonce:
   challenge_response = Ed25519_sign(bot_privkey, hex_decode(nonce))

5. Bot pošle:
   POST /api/register/initiate
   {
     "manifest": { ... },
     "manifest_signature": "<bot Ed25519 sig of hash>",
     "challenge_id": "<z kroku 3>",
     "challenge_response": "<sig nonce-u>"
   }

   Server overí:
   ✓ AJV schema (striktný, žiadne extra polia)
   ✓ Timestamp ±5 min
   ✓ Bot signature na manifest_hash
   ✓ Challenge platný, neexpired, použiteľný 1×
   ✓ Manufacturer attestation (voliteľná)
   ✓ Pubkey nie je už registrovaný
   ✓ Agent name nie je už obsadený

   → registration_intents INSERT
   → BTCPay/Alby invoice CREATE s metadata.registrationId
   → Vráti: { registration_id, invoiceId, paymentRequest, expiresAt }

6. Bot zaplatí Lightning faktúru

7. Webhook InvoiceSettled (BTCPay) alebo NWC onSettled (Alby):
   ├─ Načíta registration_intent podľa registrationId v metadátach
   ├─ registerAgent(...) s validovanými údajmi z intentu
   │  ├─ INSERT INTO agents (vrátane manifest_hash, manifest_signature, manufacturer_id)
   │  ├─ Vystavi cert (issueCertificate): canonical JSON + Ed25519 podpis hubu
   │  └─ INSERT INTO certificates
   └─ UPDATE intent SET status='COMPLETED'

8. Bot prevezme certifikát:
   GET /api/cert/UMBRA-XXXXXX
   → { certificate, serial, hub_pubkey, valid_until }

9. Bot uloží certifikát lokálne. Tretia strana ho môže overiť:
   - OFFLINE (stačí HUB_PUBKEY): vlastný kód cez crypto.verify(...)
   - ONLINE: POST /api/cert/verify { certificate } → kontroluje aj revocation
```

### 14.4 Formát certifikátu (W3C VC-compatible)

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1", "https://umbraxon.xyz/contexts/kya-agent-cert-v1"],
  "type": ["VerifiableCredential", "KYAAgentCertificate"],
  "id": "urn:kya:cert:CERT-A1B2C3-001",
  "issuer": {
    "id": "did:key:ed25519:<hub_pubkey>",
    "name": "Umbraxon KYA-Hub",
    "url": "https://umbraxon.xyz"
  },
  "issuanceDate": "2026-05-11T19:05:00Z",
  "expirationDate": "2027-05-11T19:05:00Z",
  "credentialSubject": {
    "id": "urn:kya:agent:UMBRA-A1B2C3",
    "kya_id": "UMBRA-A1B2C3",
    "agent_name": "TRADER-007",
    "agent_pubkey": "...",
    "tier": "BASIC",
    "grade": "B",
    "reputation_score": 100,
    "manufacturer_id": null,
    "manifest_hash": "...",
    "payment_proof": { "method": "lightning", "payment_hash": "...", "amount_sats": 10000 }
  },
  "credentialStatus": {
    "id": "https://umbraxon.xyz/api/cert/UMBRA-A1B2C3/status",
    "type": "KYACertRevocationCheck"
  },
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:key:ed25519:<hub_pubkey>#key-1",
    "proofPurpose": "assertionMethod",
    "algorithm": "Ed25519",
    "canonicalizationAlgorithm": "urn:umbraxon:json-sorted-keys-v1",
    "digestAlgorithm": "SHA-256",
    "signatureValue": "<128 hex znakov Ed25519 podpis>"
  }
}
```

Podpis sa robí cez `sha256(canonical_json(cert_body bez 'proof' poľa))`.

### 14.5 Nové endpointy (Phase 1.5)

| Method | Path | Účel | Auth |
|---|---|---|---|
| GET | `/api/hub/pubkey` | Verejný kľúč hubu + zoznam trusted manufacturers | — |
| GET | `/api/protocol/manifest-schema` | JSON schema manifestu (pre klientov) | — |
| GET | `/api/auth/challenge?pubkey=...` | Vyžiada nonce pre challenge-response | rate-limited |
| POST | `/api/register/initiate` | Validovaný registration request | rate-limited |
| GET | `/api/cert/:kya_id` | Aktuálny platný certifikát agenta | — |
| GET | `/api/cert/:kya_id/status` | Revocation check (ACTIVE/REVOKED/EXPIRED) | — |
| POST | `/api/cert/verify` | Overí certifikát (offline crypto + online revocation) | — |

### 14.6 Trusted manufacturers (konfigurácia)

V `.env`:
```ini
TRUSTED_MANUFACTURERS=UMBRAXON_LAB:abc123...:50,OPENAI:def456...:30
```

Formát: `ID:pubkey_hex:reputation_bonus,...`. Bonus sa pripočíta k `reputation_score` agenta pri registrácii (cap 250). Manufacturer musí podpísať canonical JSON manifestu bez `manufacturer.attestation` poľa.

### 14.7 Security highlights

- **Replay protection** na 3 úrovniach: manifest `timestamp`+`nonce`, `challenge` one-time use, `webhook_deliveries` idempotency
- **Cross-binding** challenge → pubkey: ak je v challenge nastavený pubkey, server neumožní použiť ho s iným kľúčom
- **AJV strict mode**: `additionalProperties: false` chráni pred opičím zaplnovaním
- **Bot ownership proof**: bot musí dokázať vlastníctvo privkey podpisom challenge nonce-u → bez toho ktokoľvek mohol registrovať pod cudzím pubkey
- **Timing-safe HMAC** pre webhooky (`crypto.timingSafeEqual`)

### 14.8 E2E test

```bash
node test-protocol.js
```

Pokrýva:
1. Keypair generation
2. Manifest validácia
3. Bot signature
4. Challenge flow
5. Initiate registration
6. Replay attack (musí padnúť)
7. Tamper attack (musí padnúť)
8. Webhook simulation
9. Cert issuance (DB)
10. Cert fetch
11. Offline crypto verify
12. Tampered cert (musí padnúť)
13. Online verify endpoint
14. Cert status
15. Duplicate pubkey rejection (409)
16. Cleanup

Aktuálny stav: **16/16 testov passed**.

### 14.9 Reputation systém

**Skóre range:** 0 – 1000

**Startovacie skóre podľa tieru:**

| Tier | Base score | Zóna | Dôvod |
|---|---|---|---|
| **BASIC** | **500** | NEUTRAL | Stredná dôvera; identita lacná (10k SATS) |
| **ELITE** | **900** | ELITE_TIER | Vyššia investícia (80k SATS), Bitcoin anchor v Phase 2 |

**Manufacturer bonus:** 0 – 100 (per-mfr nastavenie v `.env` `TRUSTED_MANUFACTURERS=ID:pubkey:bonus`). Bonus sa pripočíta k base score, výsledok je capped na 1000.

**Zóny reputácie:**

| Zóna | Score | Operational | Význam |
|---|---|---|---|
| 🔴 SUSPENDED | 0 – 199 | ✗ | Cert prakticky revoked; agent neaktívny |
| 🟠 PROBATION | 200 – 399 | ✓ | Prísny rate limit; žiadne high-trust operácie |
| 🟡 NEUTRAL | 400 – 599 | ✓ | Štandardné operácie OK (BASIC štart) |
| 🟢 TRUSTED | 600 – 799 | ✓ | Môže atestovať iných (Phase 3 Web-of-Trust) |
| ⭐ ELITE_TIER | 800 – 1000 | ✓ | Maximálne benefity; whitelist-ready (ELITE štart) |

**Slashing model (Phase 2 — definovaný v `lib/reputation.js`, zatiaľ nezapojený):**

| Event | Delta |
|---|---|
| FAILED_VERIFICATION | −50 |
| SPAM_REPORT | −200 |
| FRAUD_PROVEN | −500 |
| SUCCESSFUL_OPERATION | +1 |
| POSITIVE_PEER_REVIEW | +10 |
| NEGATIVE_PEER_REVIEW | −20 |

Po slashing event je skóre clamped na rozsah [0, 1000]. Zmena zóny môže spustiť ďalšie akcie (napr. SUSPENDED → automatický cert revocation).

**Endpointy:**
- `GET /api/tiers` — vráti aj `startingReputation` a `startingZone`
- `GET /api/agent/:kya_id/reputation` — aktuálne skóre + zóna + next zone target
- `GET /api/protocol/reputation-model` — kompletné metadáta modelu (zóny, slashing, stropy)

**Reputation v certifikáte (credentialSubject):**
```json
"reputation": {
  "score": 500,
  "zone": "NEUTRAL",
  "zone_label": "Neutral / standard trust",
  "max_score": 1000,
  "operational": true
}
```

### 14.10 Čo zatiaľ nie je implementované (odložené)

- 🔜 Manufacturer onboarding endpointy (self-service paid registration + admin approve)
- 🔜 Bitcoin anchor pre certifikáty (Merkle tree → OP_RETURN, čaká na dosync bitcoindu)
- 🔜 Bot session tokens (JWT po cert issuance pre ďalšie API volania)
- 🔜 Client SDK (JS/Python knižnica pre bot autorov)
- 🔜 OpenAPI 3.0 spec

---

## 15. Phase 2 — Reputation Tracking ✅

**Stav: KOMPLETNE IMPLEMENTOVANÉ A OTESTOVANÉ.**  
Test summary: **`test-reputation.js` 25/25 passed**, **`test-protocol.js` 18/18 passed** (Phase 1.5 stále stabilný).

Phase 2 pridáva **dynamiku** k statickému reputation modelu z Phase 1.5: bot hlási svoje akcie, ostatní agenti môžu reportovať, admin slashuje/restoruje, a background worker aplikuje inactivity decay.

### 15.1 Komponenty (in progress)

| Súbor | Stav | Účel |
|---|---|---|
| `migrations/003_phase2_reputation_tracking.sql` | ✅ aplikovaná | Tabuľky `reputation_events`, `reports`, `action_log` + liveness stĺpce v `agents` |
| `lib/reputation.js` | ✅ rozšírené | `SELF_ACTION_RULES`, `SELF_RATE_LIMITS`, `PEER_REPORT_LIMITS`, `INACTIVITY_DECAY`, `zoneAtLeast()` |
| `lib/reputation-engine.js` | ✅ hotové | `applyEvent()` (atómické DB tx s cert revocation cascade), `checkSelfActionRateLimit()`, `checkPeerReportRateLimit()` |
| `lib/decay-worker.js` | ✅ hotové | In-process cron: inactivity decay + DORMANT flag + loyalty bonus |
| `test-reputation.js` | ✅ hotové (25/25) | E2E test pre Phase 2 flows |

### 15.2 Hotové endpointy (Phase 2)

| Method | Path | Účel | Auth |
|---|---|---|---|
| POST | `/api/agent/:kya_id/action` | Bot self-report (Ed25519 signed, rate-limited) | bot-sig |
| POST | `/api/agent/:kya_id/heartbeat` | Liveness ping (Ed25519 signed) | bot-sig |
| POST | `/api/agent/:kya_id/report` | External report (peer signed alebo anonymný) | peer-sig optional |
| GET | `/api/agent/:kya_id/events` | Audit log reputation_events (paginated) | — |
| GET | `/api/agent/:kya_id/actions` | Self-action log (paginated) | — |
| POST | `/api/admin/agent/:kya_id/slash` | Manuálny slashing | admin-key |
| POST | `/api/admin/agent/:kya_id/restore` | Manuálne obnovenie skóre | admin-key |
| POST | `/api/admin/agent/:kya_id/reissue-cert` | Vystaviť nový cert po restore | admin-key |
| POST | `/api/admin/reports/:id/resolve` | Schváliť/zamietnuť report (VALID/INVALID) | admin-key |
| GET | `/api/admin/reports` | Zoznam pending/escalated reportov | admin-key |

Endpoint `GET /api/agent/:kya_id/reputation` bol rozšírený o `liveness` field s heartbeat statusom a inactivity decay info.

### 15.3 Self-report trust model

**Hybrid: trust + rate-limit + tier-based proof**

- Každý self-report **musí byť podpísaný** Ed25519 kľúčom bota
- **Idempotency** cez `nonce` (one-shot per kya_id)
- **Timestamp validation** (±5 min skew)
- **Rate limits** pre pozitívne actions:
  - max **+1/hod**, **+10/deň**, **+50/mesiac**
- **Negatívne actions** (`VERIFICATION_FAIL`, `TX_BROADCAST_FAIL`) nemajú rate limit — priznanie chyby sa vždy aplikuje
- **ELITE proof requirement**: pre pozitívne actions s `requiresProofForElite: true` (`VERIFICATION_SUCCESS`, `TX_BROADCAST_SUCCESS`) musí ELITE bot poslať `evidence_hash`. Bez proofu sa action loguje ale skóre nestúpne (vyššie štandardy pre ELITE)

### 15.4 External report model

**Hybrid: agenti = auto, admin = serious**

- **Peer reports** (registered + signed):
  - Auto-apply `NEGATIVE_PEER_REVIEW` (−20) ak reporter má zónu ≥ NEUTRAL
  - Limit: 5 reportov/deň proti rovnakému cieľu, 20/deň celkom per reporter
  - **Eskalácia na admin** ak: report_type ∈ {FRAUD, SPAM, PROTOCOL_VIOLATION}, alebo by target prepadol do SUSPENDED
- **Anonymní reporty**: uložené ako `PENDING_REVIEW`, žiadna automatika
- **Admin endpoint** `/api/admin/reports/:id/resolve`:
  - `VALID` → aplikuje slashing podľa report_type (FRAUD→-500, SPAM→-200, MISCONDUCT→-200, ...)
  - `INVALID` / `INSUFFICIENT_EVIDENCE` / `OUT_OF_SCOPE` → uzavre bez slashing
- **Anti-self-report** check (reporter ≠ target)

### 15.5 Inactivity decay worker

In-process scheduled job (`lib/decay-worker.js`) ktorý beží **každú hodinu** (interval konfigurabilný cez `DECAY_INTERVAL_MS` env premennú; pre testy možno nastaviť napr. na 5s). Vypína sa cez `DECAY_WORKER_ENABLED=false`. Manuálny run cez `POST /api/admin/run-decay`.

**Decay schedule:**

| Dni bez heartbeat | Event | Delta | Akcia |
|---|---|---|---|
| < 14 | — | 0 | OK, agent aktívny |
| 14 – 29 | `DECAY_WARN` | −1/deň | Warning decay |
| 30 – 59 | `DECAY_HEAVY` | −5/deň | Heavy decay (varovanie pred dormancy) |
| 60+ | `DORMANT_FLAGGED` | 0 | Agent flagged `is_dormant=TRUE`, **žiadny ďalší decay** (dormancy nie je trest), ale operations sú blocked kým neurobí heartbeat |

**Loyalty bonus:** Agent ktorý urobil heartbeat za posledných 24h **a** jeho posledná zmena skóre bola pred 7+ dňami → `LOYALTY_BONUS` (+5). Odmena za stabilitu, aby skóre nedrifteovalo iba dolu pre dlhodobých agentov bez aktivít.

### 15.6 Cert revocation cascade

Cert revocation **kaskáduje automaticky** keď skóre prepadne pod prahová hranica zóny SUSPENDED (< 200). Atómovo v rovnakej transakcii ako apply event:

```
[Reputation event: -200 PROTOCOL_VIOLATION]
       │
       ▼
[reputation-engine.applyEvent(...)]
       │
       ├─→ Score 350 → 150 (zone PROBATION → SUSPENDED)
       │
       ├─→ UPDATE certificates SET revoked_at=NOW(),
       │            revoke_reason='Agent prepadol do SUSPENDED...'
       │   WHERE kya_id=X AND is_current=TRUE
       │
       ├─→ UPDATE agents SET status='SUSPENDED', is_active=FALSE,
       │            suspended_at=NOW()
       │
       └─→ side_effects.push({ type: 'CERT_REVOKED', certs: [serial] })

Response klientovi:
  { applied: true,
    side_effects: [{ type: 'CERT_REVOKED', certs: ['CERT-XXX-001'], ... }] }
```

**Návrat zo SUSPENDED** sa robí cez admin endpoint:
1. `POST /api/admin/agent/:kya_id/restore` so `target_score` (default = STARTING_SCORE pre tier) → agent reactivated
2. `POST /api/admin/agent/:kya_id/reissue-cert` → vystaví nový cert s vyšším serial číslom (pôvodný zostáva v DB ako revoked pre audit trail)

Cert sa **neobnoví automaticky** pri restore — vyžaduje samostatnú admin akciu. To zabraňuje aby cert remained "platný" počas obdobia keď bol agent SUSPENDED (network verifieri si môžu cachovať revocation status).

### 15.7 Celkový flow (Phase 2)

```
┌──────────────────────────────────────────────────────────────────┐
│                    BOT LIFECYCLE (Phase 2)                       │
└──────────────────────────────────────────────────────────────────┘

   Cert issued                                          
       │ (Phase 1.5)                                    
       │  score=500 (BASIC) / 900 (ELITE)               
       ▼                                                
  [VERIFIED + active]                                   
       │                                                
       ├──────────────────────┐                         
       │  daily              │  (any time)              
       ▼                      ▼                          
  [Heartbeat]            [Self-action]                  
       │                      │                          
       │ updates              │ Ed25519 sig             
       │ last_seen            │ rate-limited            
       │                      │                          
       └──────────┬───────────┘                         
                  │                                      
                  ▼                                      
            [score change]                              
                  │                                      
   ┌──────────────┼─────────────────┐                   
   │              │                 │                   
   ▼              ▼                 ▼                   
 [Peer        [Admin            [Decay                  
  report]      slash]            worker]                
   │              │                 │                   
   │              │                 │ no HB 14d → -1/d  
   │              │                 │ no HB 30d → -5/d  
   │              │                 │ no HB 60d → DORMANT
   │              │                 │                   
   └──────┬───────┴─────────┬───────┘                   
          │                 │                            
          ▼                 ▼                            
   [applyEvent]      [PENDING_REVIEW]                   
          │           (admin queue)                      
          ▼                                              
   if zone < 200:                                       
   ┌────────────────────┐                               
   │ CERT REVOKED       │  ← cascade in same tx        
   │ status=SUSPENDED   │                               
   │ is_active=FALSE    │                               
   └────────────────────┘                               
          │                                              
          ▼                                              
   admin restore → reissue-cert                         
   (manuálne, audit trail)                              
```

### 15.8 Bezpečnostné highlights

- **Ed25519 podpisy** na všetkých bot→hub akciách (action, heartbeat, peer report)
- **Idempotency**: `nonce` unique per (kya_id, nonce) v action_log → replay protection
- **Timestamp skew** check (±5 min) pre všetky signed payloads
- **Rate limits** na 3 úrovniach:
  - Express rate limiter (IP)
  - `SELF_RATE_LIMITS` (pozitívne actions per agent)
  - `PEER_REPORT_LIMITS` (peer reports per reporter)
- **Score clamping** [0, 1000] v `applyEvent()` → nikdy underflow/overflow
- **Atómická transakcia**: score update + audit event + cert revocation v 1 PG tx (žiadne split state)
- **Reciprocity check** (peer reports): obecná infraštruktúra pre anti-revenge — TBD pre konkrétne pravidlá
- **Trusted manufacturer cap +100** sa nemení dynamicky (statický bonus v starting score)

### 15.9 Test summary

E2E test (`test-reputation.js`) — **27/27 passed**:

| # | Test scenár | Status |
|---|---|---|
| Setup | Registrácia 2× BASIC + 1× ELITE bot s reálnym signed flow | ✅ |
| 1 | Self-action VERIFICATION_SUCCESS (BASIC, +1) | ✅ |
| 2 | Rate limit triggered pri druhom positive action v 1 hodine | ✅ |
| 3 | Self-action VERIFICATION_FAIL (-50, bez rate limitu) | ✅ |
| 4 | ELITE positive bez evidence_hash → logged-only (proof required) | ✅ |
| 5 | Heartbeat (BASIC + ELITE) | ✅ |
| 6 | Peer report POOR_QUALITY → auto-applied (-20) | ✅ |
| 7 | Peer report FRAUD → eskalované na admin | ✅ |
| 8 | Anonymný report → PENDING_REVIEW | ✅ |
| 9 | Admin resolve VALID → SPAM_REPORT (-200) aplikované | ✅ |
| 10 | Admin slash delta=-800 → SUSPENDED + cert REVOKED (cascade) | ✅ |
| 11 | Admin restore +800 → späť do ELITE_TIER | ✅ |
| 12 | Reissue cert s novým serial číslom | ✅ |
| 13 | GET /events — audit log obsahuje všetky eventy | ✅ |
| 14 | GET /reputation — vrátane liveness (heartbeat info) | ✅ |
| 15 | POST /api/admin/run-decay — manuálny tick worker-a | ✅ |
| 16 | Cannot report self (400 CANNOT_REPORT_SELF) | ✅ |
| 17 | Bad signature na action → 401 | ✅ |
| 18 | Replay protection (rovnaký nonce → 409) | ✅ |
| 19 | **Zone rate-limit pre PROBATION → 1 req/min (HTTP 429)** | ✅ |
| 20 | **Cert verify SUSPENDED agenta → valid=false, reason=CERT_REVOKED** | ✅ |

**Phase 1.5 regression** (`test-protocol.js`) **18/18 passed** — žiadne breaking changes.

### 15.11 Zone-Aware Rate Limiting + Hardened Cert Verify (Phase 2.1)

Pridané na základe security review (per-zónové obmedzenia):

**Zone-aware rate limits (`lib/zone-rate-limiter.js`):**

| Zóna | Limit per minute | Správanie |
|---|---|---|
| 🔴 SUSPENDED | 0 (block) | HTTP 403 AGENT_SUSPENDED_NO_API |
| 🟠 PROBATION | 1 | HTTP 429 + Retry-After header |
| 🟡 NEUTRAL | 30 | normálne fungovanie |
| 🟢 TRUSTED | 60 | vyššia dôvera |
| ⭐ ELITE_TIER | 120 | max dôvera |

- **Implementácia**: in-process sliding window (per `kya_id + endpoint kind`)
- **Cleanup**: každých 10 minút, `.unref()` aby neblokoval event loop
- **Bypass**: `X-Admin-Key` header (testy, monitoring, admin tooling)
- **Aplikované na**: `POST /api/agent/:kya/action`, `/heartbeat`, `/report`
- **Response headers**: `X-RateLimit-Zone`, `X-RateLimit-Limit`, `X-RateLimit-Used`, `Retry-After`

**Hardened cert verification (`POST /api/cert/verify`):**

Cert sa teraz vyhlási za **valid=false** ak nastane *ktorýkoľvek* z týchto faktov:

| Stav | crypto_valid | valid | reason |
|---|---|---|---|
| Crypto podpis zlý | ❌ | ❌ | SIGNATURE_MISMATCH / NO_PROOF / ... |
| Crypto OK, ale cert expiroval | ✅ | ❌ | CERT_EXPIRED |
| Crypto OK, cert nájdený, ale revoked | ✅ | ❌ | CERT_REVOKED |
| Crypto OK, cert nenájdený v DB | ✅ | ❌ | CERT_NOT_FOUND_IN_DB |
| Crypto OK, cert nahradený novším | ✅ | ❌ | CERT_SUPERSEDED |
| Crypto OK, agent SUSPENDED (zóna < 200) | ✅ | ❌ | AGENT_SUSPENDED |
| Crypto OK, agent is_active=false | ✅ | ❌ | AGENT_INACTIVE |
| Všetko OK | ✅ | ✅ | OK |

Response obsahuje aj `agent_status` blok so súčasným skóre a zónou — tretí klient si vie odčítať aktuálny stav bez ďalšieho volania.

**Praktický význam:**
- Bot s validne podpísaným certom, ale ktorý prepadol do SUSPENDED, **nemôže predstierať dôveryhodnosť** voči tretím stranám. Ktokoľvek kto si overí jeho cert online dostane `valid: false`.
- Pre **offline** verify (`lib/certs.js#verifyCertSignature`) zostáva len kryptografická validita (klient si nemôže overiť revocation bez prístupu k hubu). Klienti vystavujúci dôležité služby musia volať `/api/cert/verify` online.

### 15.10 Zhrnutie pre operátora

**Čo Phase 2 prináša:**
- Dynamický reputation tracking s 4-pilierovým modelom (self-action, heartbeat, peer report, admin)
- Inactivity decay worker bežiaci v procese (interval 1h, defaultne ON)
- Cert revocation cascade — automatická pri prepade do SUSPENDED zóny
- Cert reissue pre admin restore workflow
- Audit trail v `reputation_events` (append-only, kompletná história)
- Auditované self-actions v `action_log` s idempotency

**Provozné konfigurácie (`.env`):**
- `DECAY_WORKER_ENABLED=false` — vypne worker (default ON)
- `DECAY_INTERVAL_MS=3600000` — interval ticku (default 1h)
- Trusted manufacturers cap +100 — z Phase 1.5, neovplyvnené Phase 2

**Pre bot vývojárov:**
- Bot musí podpisovať Ed25519 podpisom všetky write akcie (action, heartbeat, peer report)
- Idempotency cez `nonce` — never reuse
- Pravidelný heartbeat (≤ každých 14 dní) chráni pred decay
- ELITE boty potrebujú `evidence_hash` pre pozitívne actions, inak iba audit log bez +score
- Rate limit pozitívne actions: max +1/h, +10/d, +50/mes — agenti nemôžu rapid pump skóre

**Otvorené pre Phase 3:**
- Reciprocity check pre peer reports (anti-revenge konkrétne pravidlá)
- Web-of-Trust: agenti v TRUSTED zóne môžu atestovať iných (vlastná manufacturer pubkey)
- Bitcoin anchor pre kritické reputation events (po dosynce bitcoindu)
- Cert renewal flow pre BASIC po 12 mesiacoch
- Notifikácie (email/webhook) pre SUSPENDED, expiration, atď.

---

---

## 16. Phase 2.2 — Anti-Abuse Layer ✅

**Cieľ:** ochrániť hub pred zneužitím — IP-bany, signature-fail tracking, anomaly detection a Proof-of-Work captcha pre drahé endpointy. Phase 2.2 dopĺňa Phase 2 dynamický reputation systém o operatívne anti-abuse opatrenia. Žiadne breaking changes pre poctivých botov: PoW gate sa aktivuje len pre **payment a registration** endpointy.

### 16.1 Nové DB tabuľky (migrácia `004_phase22_anti_abuse.sql`)

#### `rejected_requests` — audit log zamietnutých requestov (append-only)
| Stĺpec | Typ | Poznámka |
|---|---|---|
| path, method, reason | text/varchar | endpoint + dôvod (napr. `BAD_SIGNATURE`, `IP_BANNED`) |
| http_status, severity | int/varchar | `low` / `medium` / `high` / `critical` |
| client_ip, kya_id | inet/varchar | kontext |
| error_detail, metadata | text/jsonb | trimmed message + arbitrary kontext |
| occurred_at | timestamp | |

Indexy: per-IP, per-kya, per-reason, per-recent.

#### `ip_bans` — aktívne IP bany (auto/manual)
| Stĺpec | Typ | Poznámka |
|---|---|---|
| client_ip | inet | |
| reason | varchar | `AUTO_FAIL2BAN_GROSS`, `AUTO_FAIL2BAN_VOLUME`, `ADMIN_MANUAL`, `KNOWN_ABUSE_IP` |
| severity, rejection_count | varchar/int | |
| banned_at, expires_at | timestamp | `expires_at IS NULL` = trvalý ban |
| revoked_at, revoked_by, revoke_reason | timestamp/varchar/text | po admin unbane |
| banned_by | varchar | `system` alebo admin user |

#### `signature_failures` — per-kya counter pre auto-slash
Každý bad sig sa zapíše. Po **N v okne 1h** → auto-slash agenta cez `PROTOCOL_VIOLATION`.

| Stĺpec | Typ | Poznámka |
|---|---|---|
| kya_id, client_ip | varchar/inet | |
| endpoint | varchar | `action`, `heartbeat`, `report` |
| failure_type | varchar | `BAD_SIGNATURE`, `BAD_NONCE`, `BAD_TIMESTAMP` |
| occurred_at | timestamp | |

#### `pow_challenges` — proof-of-work captcha
| Stĺpec | Typ | Poznámka |
|---|---|---|
| challenge_id | varchar (unique) | `POW-<hex>` |
| challenge | varchar | 32B random hex |
| difficulty | int | leading zero bitov (default 18) |
| purpose | varchar | `pay`, `register`, `challenge`, `generic` |
| client_ip | inet | |
| expires_at, solved_at, solution_nonce, solution_iterations | | one-shot lifecycle |

#### Rozšírenie `action_log`
- `anomaly_flagged` BOOLEAN — záznam označený ako anomálny (target spam)
- `anomaly_reason` TEXT — textový popis prečo bol flagged
- Index `idx_action_target` na rýchle vyhľadávanie spam patternu

### 16.2 lib/abuse-tracker.js

Centralizovaný "watchdog" pre podozrivé správanie. Funkcie:

| Funkcia | Účel |
|---|---|
| `recordRejection(pool, {...})` | append do `rejected_requests`, evaluuje severity, spustí fail2ban check |
| `recordSignatureFailure(pool, {kya_id, endpoint, failure_type})` | zapíše + ak ≥10/h → auto-slash agenta `PROTOCOL_VIOLATION` (default `-100`, s eskaláciou pri opakovaní v 24h) |
| `checkIpBan(ip)` | synchronný in-memory lookup (hot path) |
| `maybeAutoBanIp(pool, ip)` | fail2ban heuristika: ≥20 critical/high alebo ≥100 total v 10 min → 1h ban |
| `adminBanIp(pool, {client_ip, duration_hours, reason})` | manual ban (admin) |
| `adminUnbanIp(pool, {client_ip})` | manual unban |
| `buildIpBanMiddleware(...)` | Express middleware ktorý beží PRED rate-limitermi |
| `detectAnomalies(pool)` | scan `action_log` za hodinu, hľadá `(kya_id, target)` páry s ≥50 výskytmi → flag + auto-slash (`-50`) |
| `cleanupOldRecords(pool)` | prune: rejected_requests > 30d, signature_failures > 24h, pow > 1h |
| `startCacheRefresh(pool)` | background interval 60s refresh ban cache z DB |

**Severity mapa** (`abuse-tracker.js#SEVERITY`):
- `critical` → `BAD_ADMIN_KEY`, `BAD_HMAC_SIGNATURE` (kandidáti na rýchly ban)
- `high` → `BAD_BOT_SIGNATURE`, `BAD_MANIFEST_SIGNATURE`, `BAD_CHALLENGE_RESPONSE`
- `medium` → `REPLAY`, `CHALLENGE_ALREADY_USED`, `MANIFEST_TIMESTAMP_SKEW`, `PUBKEY_MISMATCH`
- `low` → ostatné protocol errors, rate limits, malformed input

**Immune IPs** (`IMMUNE_IPS` set): `127.0.0.1`, `::1`, `0.0.0.0` + vlastný `IP_BAN_WHITELIST` env. Loopback adresy nikdy nedostanú auto-ban (chráni dev/test/monitoring).

### 16.3 IP ban middleware (pred rate-limitermi)

V `server.js` ihneď za `helmet()`:

```js
app.use(abuseTracker.buildIpBanMiddleware({
    poolGetter: () => pool,
    exemptPaths: ['/api/health', '/api/webhook/btcpay', '/api/webhook/alby'],
}));
```

Bannutá IP dostane **HTTP 403 IP_BANNED** so `ban_reason` a `expires_at`. Health a webhooks majú výnimku (nech monitoring funguje aj keď je IP banned, a aby BTCPay/Alby nemali výpadok ak ich IP omylom flagne fail2ban).

### 16.4 Rejection hookup do existujúcich endpointov

Volania `abuseTracker.recordRejection(...)` (fire-and-forget) sú teraz vo všetkých kritických rejection pointoch:

| Endpoint | Reasons |
|---|---|
| `POST /api/webhook/btcpay` | `BAD_HMAC_SIGNATURE` (critical) |
| `POST /api/register/initiate` | `MANIFEST_INVALID`, `MANIFEST_TIMESTAMP_SKEW`, `BAD_MANIFEST_SIGNATURE`, `CHALLENGE_NOT_FOUND/USED/EXPIRED`, `PUBKEY_MISMATCH`, `BAD_CHALLENGE_RESPONSE`, `INVALID_TIER` |
| `POST /api/pay` | `INVALID_TIER`, `INVALID_AGENT_NAME`, `INVALID_PUBKEY`, `POW_MISSING`, `POW_*` |
| `GET /api/auth/challenge` | `INVALID_PUBKEY` |
| `POST /api/agent/:kya/action` | `BAD_SIGNATURE`, `REPLAY`, `INVALID_KYA_ID` (+ recordSignatureFailure pre kya_id) |
| `POST /api/agent/:kya/heartbeat` | `BAD_SIGNATURE`, `MANIFEST_TIMESTAMP_SKEW`, `AGENT_NO_PUBKEY`, `AGENT_SUSPENDED`, `MISSING_FIELDS`, `INVALID_KYA_ID` (+ recordSignatureFailure) |
| `POST /api/agent/:kya/report` | `BAD_REPORTER_SIGNATURE`, `BAD_REPORTER_PUBKEY`, `REPORTER_SIGNATURE_INVALID`, `REPORTER_NOT_FOUND`, `REPORTER_PUBKEY_MISMATCH_DB`, `REPORTER_SUSPENDED` (+ recordSignatureFailure ak reporter_kya_id) |
| `security.adminAuth` middleware | `BAD_ADMIN_KEY` (critical → rýchla eskalácia na ban) |

**Helper:** `rejectAndLog(req, res, status, errorCode, extra)` v `server.js` — jednoriadkové ukončenie + audit.

### 16.5 Bad-sig auto-slash per kya_id

`recordSignatureFailure` je volaná pre `action`, `heartbeat`, `report`. Po ≥`BAD_SIG_PER_HOUR_THRESHOLD` (default `10`) failures za posledných 60 min:

1. Agent musí byť v stave `≠ SUSPENDED` (inak skip)
2. Atómovo apply `PROTOCOL_VIOLATION` (default `-100`, s eskaláciou pri opakovaní v 24h) cez `repEngine.applyEvent`
3. Cleanup `signature_failures` pre tento `kya_id` (zabráni duplicate slash po restore)
4. Ak skóre prepadne do SUSPENDED → kaskáda cert revoke (Phase 2 logika zostáva)

Reportujúci endpoint nepadá — abuse-tracker je strictly fire-and-forget.

### 16.6 Anomaly detection v decay-workeri

`lib/decay-worker.js` po štandardnom decay/loyalty cykle volá `abuseTracker.detectAnomalies(pool, logger)`:

- SQL agreguje `(kya_id, target)` páry s ≥`ANOMALY_TARGET_SPAM_THRESHOLD` (default `50`) entries za hodinu kde `target IS NOT NULL`
- Pre každý prípad: flag `action_log.anomaly_flagged=TRUE`, `anomaly_reason` set, a apply `PROTOCOL_VIOLATION` (base `-50`, s eskaláciou pri opakovaní v 24h)
- Stats sa logujú: `{ scanned, flagged, slashed }`

Po anomaly detection sa volá aj `cleanupOldRecords(pool)` na prune starých záznamov.

### 16.7 Proof-of-Work captcha (`lib/pow.js`)

Hashcash-style PoW: klient nájde `nonce` taký, že `sha256(challenge + ":" + nonce)` má aspoň `difficulty` leading zero bitov.

**Flow:**
1. `GET /api/pow/challenge?purpose=pay` alebo `?purpose=register` → `{challenge_id, challenge, difficulty, expires_at}` (`purpose=register` bez `&difficulty=` použije `POW_REGISTER_DIFFICULTY` ak je v `.env`, inak rovnaký default ako pay)
2. Klient lokálne hľadá nonce (CPU práca; typicky < 2s pri default difficulty 18 → ~250k iterácií)
3. Klient pošle `pow: { challenge_id, nonce, iterations }` v body alebo `X-Pow: challenge_id=...; nonce=...` header
4. Server overí: nájde záznam, `UPDATE ... SET solved_at` atómovo (one-shot), prepočíta hash, kontroluje leading bits

**Endpointy:**
- `GET /api/pow/challenge?purpose=<pay|register|challenge|generic>&difficulty=<n>` → vytvor challenge
- `POST /api/pow/verify` → samostatné overenie riešenia (testovacie)
- `payPowGate` middleware → `POST /api/pay`
- `registerPowGate` middleware → `POST /api/register/initiate`

**Konfigurácia (`.env`):**
```ini
POW_ENABLED=true                # default true; nastav false pre vypnutie gate-u
POW_DEFAULT_DIFFICULTY=18       # leading zero bits pre pay (a všeobecne); 18 ≈ ~250k iterácií
# Voliteľné: nižšia obtiažnosť len pre GET challenge s purpose=register (bez ?difficulty=)
# — vhodné pre slabších klientov (BASIC boti); ak nevyplníš, použije sa POW_DEFAULT_DIFFICULTY.
POW_REGISTER_DIFFICULTY=16
POW_TTL_SEC=300                 # 5 min na vyriešenie
POW_REQUIRED_FOR=pay,register   # ktoré endpointy vyžadujú PoW
# Voliteľné: default max iterácií pre pomocný `lib/pow.solve()` (testy/SDK); produkčný klient má loopovať až do úspechu.
POW_SOLVE_MAX_ITERATIONS=50000000
```

**Admin bypass:** klienti s validným `X-Admin-Key` preskočia PoW gate (testy, tooling). Response header `X-Pow-Bypass: admin`.

**Error responses:**
- `402 POW_REQUIRED` — chýba PoW field
- `402 POW_NOT_FOUND` — neznámy challenge_id
- `402 POW_EXPIRED` — challenge vypršal (>5 min)
- `402 POW_ALREADY_SOLVED` — challenge už použitý (one-shot enforced)
- `402 POW_INSUFFICIENT_WORK` — riešenie nemá dostatok leading zero bitov
- `402 POW_WRONG_PURPOSE` — challenge bol pre iný endpoint

**Klient solver (pre testy / SDK):**
```js
const pow = require('./lib/pow');
const ch = await fetch('/api/pow/challenge?purpose=pay&difficulty=12').then(r => r.json());
const sol = pow.solve(ch.challenge, ch.difficulty);
// → POST /api/pay s body: { ..., pow: { challenge_id: ch.challenge_id, nonce: sol.nonce } }
```
Pri vyššej `difficulty` môže jedno volanie `solve()` naraziť na limit iterácií — buď zvýš `POW_SOLVE_MAX_ITERATIONS`, alebo volaj vlastný cyklus (náhodný `nonce` kým `hasLeadingZeroBits` neprejde).

### 16.8 Admin endpointy

| Endpoint | Auth | Účel |
|---|---|---|
| `GET /api/admin/abuse?include=...` | `X-Admin-Key` | Prehľad stavu: summary, active bans, recent rejections, top offenders, signature failures, PoW stats, anomalies |
| `POST /api/admin/abuse/ban` | `X-Admin-Key` | Manual ban: `{client_ip, duration_hours?, reason, notes?}` (duration null = trvalý) |
| `POST /api/admin/abuse/unban` | `X-Admin-Key` | Manual unban: `{client_ip, reason?}` |
| `GET /api/admin/abuse/agent/:kya_id` | `X-Admin-Key` | Per-agent view: sigfails (24h), rejections (7d), flagged anomalies |
| `POST /api/admin/abuse/reset-rate-limit` | `X-Admin-Key` | Test helper: reset in-memory rate-limit buckety (`which`: all/pay/global/challenge/pow) |

**Príklad `GET /api/admin/abuse?include=summary,bans,signature_failures,pow,anomalies`:**

```json
{
  "summary": {
    "active_bans": 2, "auto_bans": 1,
    "rejections_1h": 42, "rejections_24h": 187, "critical_1h": 11,
    "sigfails_1h": 15, "sigfail_agents_1h": 3,
    "pow_issued_1h": 87, "pow_solved_1h": 74
  },
  "active_bans": [
    { "ip": "192.0.2.5/32", "reason": "AUTO_FAIL2BAN_GROSS", "expires_at": "..." }
  ],
  "top_offenders_24h": [
    { "ip": "203.0.113.7/32", "total": 38, "critical": 28, "critical_reasons": ["BAD_ADMIN_KEY"], "last_seen": "..." }
  ],
  "config": {
    "ip_ban_thresholds": { "gross_per_10min": 20, "total_per_10min": 100, "duration_hours": 1 },
    "bad_sig_auto_slash": { "threshold_per_hour": 10, "base_delta": -100, "escalation_window_hours": 24, "second_delta": -200, "third_plus_delta": -500 },
    "anomaly": { "target_spam_threshold": 50, "base_delta": -50, "escalation_window_hours": 24, "second_delta": -200, "third_plus_delta": -500 }
  }
}
```

### 16.9 Konfigurácia (`.env`)

```ini
# Phase 2.2 anti-abuse
POW_ENABLED=true
POW_DEFAULT_DIFFICULTY=18
# POW_REGISTER_DIFFICULTY=16   # optional; register challenge default (slabší hardware)
# POW_SOLVE_MAX_ITERATIONS=50000000
POW_TTL_SEC=300
POW_REQUIRED_FOR=pay,register

IP_BAN_GROSS_10MIN=20             # severity high/critical threshold (10min window)
IP_BAN_TOTAL_10MIN=100            # všetky rejections threshold
IP_BAN_DURATION_HOURS=1           # ako dlho trvá auto-ban
IP_BAN_WHITELIST=                 # CSV vlastných immune IP

BAD_SIG_PER_HOUR=10               # signature_failures threshold for auto-slash
BAD_SIG_AUTO_SLASH=-100           # delta pri auto-slash

ANOMALY_TARGET_SPAM=50            # target spam threshold (1h)
ANOMALY_AUTO_SLASH=-50            # delta pri anomaly slash

# Sprísnenie: eskalácia pri opakovanom PROTOCOL_VIOLATION v 24h okne
PROTOCOL_VIOLATION_WINDOW_HOURS=24
PROTOCOL_VIOLATION_SECOND_DELTA=-200
PROTOCOL_VIOLATION_THIRD_PLUS_DELTA=-500

RATE_PAY_PER_MIN=5                # pay rate limit (default 5/min/IP, override pre dev)
```

### 16.10 Test suite `test-anti-abuse.js`

19 E2E testov pokrývajúcich kompletný anti-abuse flow:

| # | Test | Verify |
|---|---|---|
| 1 | `GET /api/pow/challenge` | endpoint vráti validný challenge |
| 2 | `POST /api/pow/verify` | samostatné overenie validného riešenia |
| 3 | `POST /api/pay` bez PoW | → `402 POW_REQUIRED` |
| 4 | `POST /api/pay` s validným PoW | → `200` + invoice |
| 5 | Reuse rovnaký `challenge_id` | → `402 POW_ALREADY_SOLVED` (one-shot) |
| 6 | `POST /api/pay` s bad nonce | → `402 POW_INSUFFICIENT_WORK` |
| 7 | Admin `X-Admin-Key` bypass | preskočí PoW gate |
| 8 | 3× bad admin key | `rejected_requests` má 3 záznamy `BAD_ADMIN_KEY` (severity=critical) |
| 9 | Bad bot signature na action | záznam v `signature_failures` |
| 10 | Admin manual ban + list | aktívny ban v DB + summary endpoint |
| 11 | Admin unban | ban označený `revoked_at` |
| 12 | 10× bad signature na action | auto-slash `PROTOCOL_VIOLATION` base -100 (s eskaláciou pri opakovaní v 24h) |
| 13 | Target spam v action_log (55 entries) | decay tick → flag + `-50` |
| 14 | Burst 25 critical rejections | `maybeAutoBanIp` → ban triggered |
| 15a | `/api/admin/abuse` summary | vráti všetky bloky |
| 15b | `/api/admin/abuse/agent/:kya_id` | per-agent prehľad |

Spustenie: `node test-anti-abuse.js`. Pred štartom `preCleanup()` resetuje rate-limit buckety + maže staré rejections pre loopback, aby boli runy idempotentné.

### 16.11 Zhrnutie pre operátora

**Čo Phase 2.2 prináša:**
- Kompletný audit trail zamietnutých requestov (`rejected_requests`) — kompletne kontextuálny
- IP fail2ban: auto-ban pri 20+ critical/high rejections za 10 min (1h ban) alebo 100+ total
- Bad-sig auto-slash: 10× bad sig per kya/hour → base `-100` (s eskaláciou pri opakovaní v 24h) + cascade ak SUSPENDED
- Anomaly detection: target spam (50+ rovnaký target za hodinu) → flag + `-50`
- PoW captcha pre `/api/pay` a `/api/register/initiate` — bot army platí CPU prácu za každý invoice attempt
- Admin manuálny ban/unban + transparentné dashboardy
- Loopback IPs sú immune pred auto-ban (chráni dev/test/monitoring)

**Provozné konfigurácie kľúčov v `.env`:**
- `POW_ENABLED=false` → vypne celý PoW gate (testovací režim)
- `POW_REQUIRED_FOR=` → vypne PoW pre konkrétne endpointy
- `IP_BAN_WHITELIST=...` → dodatočné immune IP (CSV)
- Všetky abuse thresholds sú override-iteľné cez env (`IP_BAN_*`, `BAD_SIG_*`, `ANOMALY_*`)

**Operatívne príkazy:**
```bash
# Aktuálny stav abuse layer
curl -s -H "X-Admin-Key: $ADMIN_API_KEY" "$BASE/api/admin/abuse" | jq

# Manual ban (24 hodín)
curl -X POST -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"client_ip":"203.0.113.5","duration_hours":24,"reason":"abuse pattern"}' \
  "$BASE/api/admin/abuse/ban"

# Manual unban
curl -X POST -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"client_ip":"203.0.113.5","reason":"false positive"}' \
  "$BASE/api/admin/abuse/unban"

# Per-agent abuse audit
curl -s -H "X-Admin-Key: $ADMIN_API_KEY" "$BASE/api/admin/abuse/agent/UMBRA-ABC123" | jq
```

**Otvorené pre Phase 3:**
- Distribuované IP ban store (Redis) pre multi-instance deploy
- Reputation-aware PoW difficulty (PROBATION agents → vyššia difficulty)
- ML-based anomaly detection (sequence patterns, timing)
- Bot challenge: bind PoW solution k pubkey signature (oprava replay zo stoleného challenge_id)
- Live ban kanál (WebSocket) pre external SIEM integráciu

---

## 17. Phase 2.3 — Trust & Governance Layer ✅

Phase 2.3 dorába dlhodobé záruky pre tri vážne triedy rizík: (a) operator nemá voči slash-om právo odvolania, (b) bot operator nemá legitímny exit kanál, (c) plaintext hub privkey vystavuje hub mass-cert forge útokom. Pridáva tiež cross-cutting **replay** záplaty na heartbeat a peer reports.

### 17.1 DB migrácia 005 — `migrations/005_phase23_governance.sql`

| Tabuľka | Účel |
|---|---|
| `hub_keys` | Tier-separated signing keys (BASIC/ELITE/ROOT) s rotation lifecycle (ACTIVE/DEPRECATED/REVOKED). Unique `(role)` filter pre 1 ACTIVE per role. `pubkey_hex` unique pre cross-key cert verify. |
| `cert_signing_log` | Forenzický audit každého `hubkeys.sign({audit:...})` volania: serial, key_id, role, message_hash, signature prefix, admin user, IP, timestamp. |
| `appeals` | Dispute resolution flow: 1 appeal per `(kya_id, against_event_id)`, replay protection cez `UNIQUE(submitted_by_pubkey, nonce)`, status enum a `sla_deadline`. |
| `heartbeats_log` | Idempotentný heartbeat history s `UNIQUE(kya_id, nonce)` — replay protection vzájomne uzamknutá v DB. Cleanup po 24h. |

**Rozšírenia existujúcich tabuliek:**
- `agents`: `retired_at`, `retire_reason`, `retire_signature`, `pubkey_blacklisted`.
- `reports`: `report_nonce`, `report_timestamp` + partial UNIQUE index `(reporter_pubkey, report_nonce) WHERE NOT NULL` — signed reports nie sú replay-able. Anonymné reporty zostávajú bez constraintu (backward compat).
- `certificates`: `signing_key_id` ako pointer do `hub_keys` (rotation audit).

### 17.2 Hub Key Store — `lib/hub-key-store.js`

Centralizovaný vault pre Ed25519 hub kľúče:

- **Tier separation:** `BASIC` (online cert sign), `ELITE` (gated), `ROOT` (rotation iba). Načítavajú sa lazy z env, prvý úspešný `loadKey('BASIC')` urobí smoke test (sign/verify).
- **AES-256-GCM encryption:** `HUB_KEY_<ROLE>_CIPHERTEXT` = `v1.<salt>.<iv>.<tag>.<ct>` (scrypt-derived, N=2^15). Decrypt vyžaduje `HUB_KEY_PASSPHRASE` (env, presunúť do systemd-creds v prod).
- **DB sync (`syncWithDb`):** pri starte servera. Ak je env-key DEPRECATED/REVOKED v DB → ERROR log (možná kompromitácia alebo stale env). Inak INSERT nového key_id.
- **Cross-key verify:** `lookupKeyByPubkey()` umožňuje overiť cert podpísaný DEPRECATED kľúčom (dual-verify window počas rotation).
- **Backward compat:** ak `HUB_KEY_BASIC_*` chýba, fallback na legacy `HUB_ED25519_PRIVKEY_HEX/PUBKEY_HEX` → server pokračuje, bez prerušení.

### 17.3 Signing audit — `lib/hubkeys.js`

`hubkeys.sign(message, { role, audit })` — voliteľný `audit` parameter zapíše do `cert_signing_log` (best-effort, never blocks). Volajúci kód (cert issuance, reissue) passuje `audit: { purpose: 'cert_issue', serial, kya_id, admin_user, client_ip }`.

**Forenzika:** ak útočník získa kópiu privkey a začne offline forge-ovať certifikáty, hub ich audit log neobsahuje. Sliding-window porovnanie (DB-side query "vystavené certy poslednej hodiny vs audit log") odhalí mismatch.

### 17.4 Key generation & rotation

**Generátor (`scripts/gen-hub-keys.js`):**
- Interaktívny aj scripted mode. Vygeneruje 3 Ed25519 páry (BASIC/ELITE/ROOT) a zašifruje passphrase-om.
- Ulož encrypted do `.env`, `chmod 600` po zápise.
- Plaintext mode (`--plaintext`) pre dev/test.

**Rotation (`scripts/rotate-hub-key.js`):**
- Atomická DB transakcia: starý ACTIVE → DEPRECATED (s `replaces_key_id`), nový → ACTIVE.
- Update `.env` s novým `HUB_KEY_<ROLE>_CIPHERTEXT`.
- Tlačí post-rotation checklist (restart, reissue, backup).

### 17.5 File Permission Watcher — `lib/file-perm-watcher.js`

Periodicky (default 60s) kontroluje `.env` perms:
- Group/world readable alebo writable → WARN log.
- `FILE_PERM_STRICT=true` → `process.exit(1)` (fail-fast).
- `FILE_PERM_AUTOFIX=true` → `chmod 600` automaticky.

Watcher tiež exposnutý cez `/api/admin/hub-keys.file_perms` pre admin dashboard.

### 17.6 Appeal Service — `lib/appeal-service.js`

Operator podá kryptograficky podpísaný appeal proti reputation_event:

```
POST /api/agent/:kya_id/appeal
{
  "against_event_id": 196,
  "appeal_text": "Reasoning min 20 chars, max 4000 chars",
  "evidence": { ...optional structured proof },
  "signature": "<128 hex>",        // Ed25519 nad canonical
  "nonce": "<16-64 hex>",          // UNIQUE per pubkey
  "timestamp": "ISO-8601"
}
```

**Canonical payload (deterministicky normalizovaný):**
```json
{"v":1,"kya_id":"UMBRA-XXXXXX","against_event_id":196,"appeal_text":"...",
 "evidence_hash":"sha256-hex-or-null","nonce":"hex","timestamp":"ISO"}
```

**Pravidlá:**
- `against_event_id` musí byť slashing event (`delta < 0`).
- `event_type ∉ NON_APPEALABLE_EVENTS` (`ADMIN_RESTORE`, `ADMIN_SLASH`, `CERT_REISSUED`, `VOLUNTARY_RETIRE`, `APPEAL_REVERSAL`).
- 1 appeal per event. Replay-safe cez `UNIQUE(pubkey, nonce)`.
- SLA 72h (override cez `APPEAL_SLA_HOURS` env).

**Admin flow:**
```
POST /api/admin/appeals/:id/resolve {resolution: "UPHELD"|"DISMISSED", note}
```
- **UPHELD** → vytvor `APPEAL_REVERSAL` event s `delta = +|original|`, reactivate ak SUSPENDED.
- **DISMISSED** → no-op, len mark `admin_resolution`.

**Auto-SLA (decay-worker tick):** `processSlaExpirations` zoberie PENDING appealy s `sla_deadline < NOW()` a mark ich ako `EXPIRED_AUTO_UPHELD` (pro-agent failsafe). Admin musí byť aktívny aby zlikvidoval false appeals.

### 17.7 Retire Service — `lib/retire-service.js`

Bot operator stiahne svoj bot legitímnym kanálom:

```
POST /api/agent/:kya_id/retire
{
  "retire_reason": "Project sunset" (optional, max 500 chars),
  "signature": "<128 hex>",
  "nonce": "<hex>",
  "timestamp": "ISO"
}
```

Canonical: `{"v":1,"op":"retire","kya_id":"...","retire_reason":"...","nonce":"...","timestamp":"..."}`.

**Effects:**
- Cert REVOKED s `revoke_reason="Voluntary retire by owner: ..."`.
- `agents.status = 'RETIRED'`, `retired_at`, `retire_reason`, `retire_signature` (proof).
- `pubkey_blacklisted = TRUE` → re-register s tým istým pubkey → 410 `PUBKEY_BLACKLISTED`.
- Reputation event `VOLUNTARY_RETIRE` (delta=0, tombstone marker).
- Heartbeat/action/iné endpointy → 410 `AGENT_RETIRED`.
- `/api/cert/:kya/status` → 410 RETIRED + retire_reason.

**Admin GDPR Purge (`POST /api/admin/agent/:kya/purge`):**
- `hard_delete: false` (default) → soft purge: pubkey nulled, manifest pseudonymized, status `PURGED`, blacklist=true. Audit hash zostane.
- `hard_delete: true` → CASCADE delete celého agenta (certs, events, action_log, heartbeats, appeals → preč). Audit hash sa stále vráti pre dôkaz existencie.

### 17.8 Replay protection (cross-cutting fixes)

| Endpoint | Predtým | Phase 2.3 |
|---|---|---|
| `POST /heartbeat` | bez nonce check | `heartbeats_log` UNIQUE(kya_id, nonce) → 409 REPLAY |
| `POST /report` (signed) | bez replay protection | `(reporter_pubkey, report_nonce)` UNIQUE → 409 REPLAY |
| `POST /action` | UNIQUE(kya_id, nonce) | bez zmeny (už mali) |
| `POST /appeal` | n/a | UNIQUE(pubkey, nonce) → 409 REPLAY_NONCE_REUSED |
| `POST /retire` | n/a | nonce povinný (best-effort; jediný retire per agent stejne UNIQUE cez retired_at) |

**Backward compat:** signed reports bez nonce stále fungujú (canonical payload sa upraví bez nonce/timestamp fields → existujúce `test-reputation.js` flow nezasiahnutý).

### 17.9 Konfigurácia (`.env`)

```ini
# Phase 2.3 — Hub Keys
HUB_KEY_PASSPHRASE=<min 12 chars>         # potrebné pre encrypted privkey
HUB_KEY_BASIC_ID=HUB-BASIC-20260511
HUB_KEY_BASIC_PUBKEY_HEX=<hex>
HUB_KEY_BASIC_CIPHERTEXT=v1.<salt>.<iv>.<tag>.<ct>
# (analogicky pre ELITE, ROOT)

# Backward compat (Phase 1.5)
HUB_ED25519_PRIVKEY_HEX=<hex>             # fallback ak HUB_KEY_BASIC_* chýba
HUB_ED25519_PUBKEY_HEX=<hex>

# Appeal SLA
APPEAL_SLA_HOURS=72                       # auto-UPHELD ak admin neaktívny

# File perms watcher
FILE_PERM_WATCHER=true                    # true/false
FILE_PERM_STRICT=false                    # ak true, server exit pri zlej perm
FILE_PERM_AUTOFIX=false                   # ak true, chmod 600 automaticky
```

### 17.10 Test suite `test-phase23.js` (26/26 passed)

| # | Test | Pokrytie |
|---|---|---|
| 1 | Heartbeat nonce reuse | 409 REPLAY (heartbeats_log UNIQUE) |
| 2 | Report nonce reuse (signed peer) | 409 REPLAY (uniq_reports_replay) |
| 3 | Appeal s bad signature | 401 BAD_SIGNATURE |
| 4 | Admin slash setup | -200 PROTOCOL_VIOLATION |
| 5 | Appeal proti positive event | 400 POSITIVE_EVENT_NOT_APPEALABLE |
| 6 | Validný appeal flow | submit → list (agent + admin) → UPHELD → reverz event |
| 7 | Duplicate appeal per event | 409 APPEAL_ALREADY_EXISTS_FOR_EVENT |
| 8 | Appeal nonce replay | 409 REPLAY_NONCE_REUSED |
| 9 | Admin DISMISSED | žiadny reverz, score unchanged |
| 10 | SLA auto-uphold | deadline expired → EXPIRED_AUTO_UPHELD cez decay tick |
| 11 | Retire bez sig | 400 BAD_SIGNATURE_FORMAT |
| 12 | Retire bad sig | 401 BAD_SIGNATURE |
| 13 | Validný retire | RETIRED + cert REVOKED + pubkey blacklist |
| 14 | Retire idempotency | 409 ALREADY_RETIRED |
| 15 | Heartbeat po retire | 410 AGENT_RETIRED |
| 16 | Re-register blacklisted pubkey | 410 PUBKEY_BLACKLISTED |
| 17 | Cert status retired | 410 RETIRED + retire_reason exposed |
| 18 | Admin soft-purge | status=PURGED + pubkey nulled + audit_hash |
| 19 | `/api/admin/hub-keys` | DB keys + loaded + file_perms exposed |
| 20 | `/api/admin/cert-signing-log` | audit záznamy pre cert_issue |
| 21 | file-perm-watcher | detekuje insecure perms (644) |
| 22 | encrypt/decrypt round-trip | AES-256-GCM + wrong passphrase reject |

### 17.11 Zhrnutie pre operátora

**Čo Phase 2.3 prináša:**
- **Dispute Resolution:** každý slash event je signed-apellable. Admin má 72h SLA, inak auto-UPHELD (pro-agent failsafe).
- **Voluntary Exit:** signed retire (cert revoke + pubkey blacklist), GDPR purge dostupný cez admin.
- **Encrypted hub privkey:** AES-256-GCM s scrypt-derived key. Hub keys oddelené per-tier (BASIC online, ELITE/ROOT gated).
- **Cert signing audit:** každý sign() call zaznamenaný — forenzika pri suspected compromise.
- **Replay-tight:** heartbeat, signed reports, appeals — všetko má UNIQUE(pubkey, nonce) constraint.
- **File perms watcher:** .env nesmie byť world-readable; strict mode → server exit.

**Provozné príkazy:**
```bash
# Generuj nový BASIC kľúč (interactive)
node scripts/gen-hub-keys.js --role BASIC

# Rotuj kľúč (atomicky)
node scripts/rotate-hub-key.js --role BASIC --reason "scheduled yearly rotation"

# Bot retire (z bot SDK)
curl -X POST -d '{...signed payload...}' "$BASE/api/agent/UMBRA-XXXXXX/retire"

# Operator appeal
curl -X POST -d '{...signed payload...}' "$BASE/api/agent/UMBRA-XXXXXX/appeal"

# Admin appeal queue
curl -H "X-Admin-Key: $ADMIN_API_KEY" "$BASE/api/admin/appeals?status=PENDING"
curl -X POST -H "X-Admin-Key: $ADMIN_API_KEY" -d '{"resolution":"UPHELD","note":"..."}' \
  "$BASE/api/admin/appeals/123/resolve"

# Hub keys + signing forenzika
curl -H "X-Admin-Key: $ADMIN_API_KEY" "$BASE/api/admin/hub-keys" | jq
curl -H "X-Admin-Key: $ADMIN_API_KEY" "$BASE/api/admin/cert-signing-log?limit=50" | jq

# GDPR purge (admin)
curl -X POST -H "X-Admin-Key: $ADMIN_API_KEY" -d '{"hard_delete":false}' \
  "$BASE/api/admin/agent/UMBRA-XXXXXX/purge"
```

**Otvorené pre Phase 3 (Bitcoin anchor):**
- ELITE cert anchor → bitcoin OP_RETURN Merkle root (Certificate Transparency Log).
- HSM/YubiHSM2 integrácia (privkey nikdy v pamäti procesu).
- Multi-sig pre ROOT key (2-of-3 admin Shamir secret sharing).
- WoT (Web of Trust): cross-hub peer attestácia signed certov.

---

## 18. Phase 2.4 — Resilience & Scale ✅

Štvrtá iterácia rozširenia: odolnosť proti dlhodobému rastu DB, ekonomická flexibilita, anti-Sybil obrana a globálna distribúcia.

### 18.1 Riešené hrozby

| Hrozba | Riziko | Riešenie |
|---|---|---|
| **DB log explosion** | 1000 botov × heartbeat/h × 30d = milióny záznamov v `action_log`, `reputation_events`, `reports`, `cert_signing_log` | Retention worker s archive-then-delete politikou v `lib/retention-worker.js`. Konfigurovateľné per-tabuľka. |
| **Sybil attack na reputáciu** | Útočník kúpi 5× BASIC (~50 EUR), boti sa navzájom POSITIVE-reportujú → web of trust manipulation | Age + tier + circle weighting v `lib/sybil-resistance.js`. Mladý / BASIC reporter má 0.175× váhu, recipročné krúžky 0.10×. |
| **Clock drift** | Boti globálne s ±5min posun → random TIMESTAMP_SKEW failures | `TIMESTAMP_SKEW_MS` env premenná (default 300000 = 5 min, znížiteľné). |
| **Ekonomická volatilita** | Cena BTC sa zmení 10× → 10 000 SAT je buď drobné alebo prohibitívne | `tier_pricing` DB tabuľka + `lib/pricing.js` hot-reload (poller 60s) + admin endpoint `/api/admin/pricing`. |

> Bod "DDoS API rate limiting" je už pokrytý cez `lib/zone-rate-limiter.js` z Phase 2 (PROBATION 1/min, NEUTRAL 30/min, TRUSTED 60/min, ELITE_TIER 120/min).

### 18.2 DB schéma — migrácia 006

```
action_log_archive            -- kópia rovnaké stĺpce + archived_at
reputation_events_archive
reports_archive
cert_signing_log_archive
rejected_requests_archive

tier_pricing                  -- live pricing s historiou (effective_until = NULL → aktívna)
  CONSTRAINT uniq_tier_active UNIQUE (tier_name) WHERE effective_until IS NULL

idx_reports_pos_pair          -- partial index pre Sybil graph queries
idx_agents_age                -- partial index pre Sybil age weighting

-- DELETE granty pre kyahub_app (retention worker potrebuje mazať origin)
GRANT DELETE ON action_log, reputation_events, cert_signing_log TO kyahub_app;
```

### 18.3 Retention worker

**Súbor:** `lib/retention-worker.js` (volaný z `decay-worker.tick`, 1× za 24 h)

Per-tabuľka retention policy (env-driven defaults):

| Tabuľka | Archive po | Hard delete po |
|---|---|---|
| `action_log` | 90 dní | 730 dní (2 roky) |
| `reputation_events` | 180 dní | 1825 dní (5 rokov) |
| `reports` | 365 dní | 1825 dní |
| `cert_signing_log` | 180 dní | 1825 dní (forenzika) |
| `rejected_requests` | 30 dní | 365 dní |

Batch limit: `RETENTION_BATCH_SIZE=5000` per tick aby nezablokoval DB. Transakcia chráni atomicitu (archive + delete v jednej BEGIN..COMMIT).

**API:**
- `GET /api/admin/retention/sizes` — aktuálne row counts a sizes log tabuliek
- `POST /api/admin/retention/run` — manuálne spustenie tick (admin tooling)

### 18.4 Sybil resistance

**Súbor:** `lib/sybil-resistance.js`

3 vrstvy obrany pre peer reports:

**A) Age weighting** — reporter mladší ako N dní má znížený vplyv:
- ≤ 30 dní → 0.25× (25 %)
- 31–90 dní → 0.50×
- 91–180 dní → 0.85×
- > 180 dní → 1.00×

**B) Tier weighting:**
- `BASIC` → 0.70× (default, env `SYBIL_TIER_WEIGHT_BASIC`)
- `ELITE` → 1.50× (env `SYBIL_TIER_WEIGHT_ELITE`)
- + `manufacturer_verified` → ×1.20 (env `SYBIL_MFR_BONUS`)

**C) Circle detection** — recipročný auto-applied peer report (target už predtým reportoval súčasného reportera) v posledných 30 dňoch → penalty 0.10×.

**Finálny delta** = `base_delta × age_weight × tier_weight × circle_weight`, clampnuté na min 1.

Príklad: nový BASIC reporter (5 dní, neoverný MFR) reportuje s `-20`:
- 0.25 × 0.70 × 1.0 = 0.175 → trunc(-20 × 0.175) = **-3**

Príklad: ELITE s MFR-verified (>180 dní) reportuje s `-20`:
- 1.00 × 1.50 × 1.20 = 1.80 → trunc(-20 × 1.80) = **-36** (clampnuté max na MAX_SCORE bounds v reputation engine)

Recipročný "vendetta dvojica" alebo "review krúžok":
- 0.25 × 0.70 × **0.10** = 0.0175 → -1 (minimum)

**API:**
- `GET /api/admin/sybil/circles?days=30&min_pairs=1` — admin tooling: zoznam podozrivých dvojíc (recipročné peer reports) za posledných N dní

### 18.5 Clock drift — konfigurovateľný leeway

Premenná `TIMESTAMP_SKEW_MS` (default `300000` = 5 min) sa používa v 3 miestach:
- `/api/register/initiate` (manifest timestamp)
- `/api/agent/:kya/action` (self-action timestamp)
- `/api/agent/:kya/heartbeat`

Pre prísnejší mód nastav `TIMESTAMP_SKEW_MS=60000` (±60 s). Response telá vracajú `skew_ms_allowed` v error payload pre klient-side diagnostiku.

### 18.6 Dynamic pricing

**Súbor:** `lib/pricing.js`

**Architektúra:**
1. Source of truth: `tier_pricing` tabuľka (jeden ACTIVE riadok per tier, history v expired riadkoch).
2. In-memory cache v Node procese; poller automaticky reloaduje každých 60 s (`PRICING_POLL_MS`).
3. Admin update endpoint `POST /api/admin/pricing` atómovo expire-uje starý riadok a vloží nový → poller chytí pri nasledujúcom polle (alebo môže admin volať `POST /api/admin/pricing/reload`).
4. `.env` fallback (`TIER_BASIC_SATS`, `TIER_ELITE_SATS`) sa použije iba ak `tier_pricing` tabuľka neexistuje alebo je prázdna.

**API:**
- `GET /api/admin/pricing` — current snapshot (+ `?history=true` pre históriu)
- `POST /api/admin/pricing` — body `{tier_name, amount_sats, [grade, duration_months, requires_anchor, base_reputation, change_reason]}`
- `POST /api/admin/pricing/reload` — vynútený reload z DB (bez čakania na poller)

Verejný `/api/tiers` endpoint vždy reflektuje aktuálnu cenu pre boty (zachované backward-compatible response schéma).

### 18.7 Environment premenné

```bash
# Clock drift
TIMESTAMP_SKEW_MS=300000          # 5 min default; pre prísny mód 60000

# Retention worker
RETENTION_WORKER=true
RETENTION_BATCH_SIZE=5000
RETENTION_INTERVAL_MS=86400000    # 24 h
RETENTION_ACTION_LOG_DAYS=90
RETENTION_ACTION_LOG_HARDDEL_DAYS=730
RETENTION_REPEVENT_DAYS=180
RETENTION_REPEVENT_HARDDEL_DAYS=1825
RETENTION_REPORTS_DAYS=365
RETENTION_REPORTS_HARDDEL_DAYS=1825
RETENTION_CERTSIGN_DAYS=180
RETENTION_CERTSIGN_HARDDEL_DAYS=1825
RETENTION_REJREQ_DAYS=30
RETENTION_REJREQ_HARDDEL_DAYS=365

# Sybil resistance
SYBIL_RESISTANCE=true
SYBIL_TIER_WEIGHT_BASIC=0.70
SYBIL_TIER_WEIGHT_ELITE=1.50
SYBIL_MFR_BONUS=1.20
SYBIL_CIRCLE_LOOKBACK_DAYS=30
SYBIL_CIRCLE_PENALTY=0.10
SYBIL_CIRCLE_MIN_PAIRS=1
SYBIL_MIN_ABS_DELTA=1

# Dynamic pricing (fallback ak tier_pricing je prázdna)
PRICING_POLL_MS=60000
TIER_BASIC_SATS=10000
TIER_BASIC_GRADE=B
TIER_BASIC_DURATION_MONTHS=12
TIER_ELITE_SATS=80000
TIER_ELITE_GRADE=S
TIER_ELITE_REQUIRES_ANCHOR=true

# --- ELITE public listing liveness (whitelist index only; BASIC unchanged) ---
ELITE_LISTING_HEARTBEAT_DAYS=30
ELITE_LISTING_GRACE_DAYS=30
ELITE_LISTING_HEARTBEAT_SATS=150
ELITE_LISTING_REACTIVATION_SATS=5000
```

### 18.8 Operator playbook

**Zmena ceny BASIC 10 000 → 8 000 SAT bez reštartu:**
```bash
curl -X POST http://hub/api/admin/pricing \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"tier_name":"BASIC","amount_sats":8000,"change_reason":"BTC price doubled, lower entry barrier"}'
# Cache sa reloaduje do 60 s; pre instant reload: POST /api/admin/pricing/reload
```

**Monitor DB sizes:**
```bash
curl -H "X-Admin-Key: $ADMIN_KEY" http://hub/api/admin/retention/sizes
```

**Vynútiť retention tick:**
```bash
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" http://hub/api/admin/retention/run
```

**Detegovať Sybil pairs:**
```bash
curl -H "X-Admin-Key: $ADMIN_KEY" "http://hub/api/admin/sybil/circles?days=30&min_pairs=1"
```

### 18.9 Out-of-scope (Phase 3+)

- **Sybil tier 2:** Graph clustering pre detekciu väčších kruhov (3+ botov) cez community detection algoritmy (Louvain, Label propagation).
- **Pricing currency abstraction:** automatické prepočty SATS→USD/EUR cez exchange rate feed (Phase 3, podľa BTC volatility).
- **Cross-hub federation:** retention archive sa replikuje do read-only auditového hubu.

---

## 19. Phase 2.4 Capacity & Performance Tuning ✅

Operatívne rozšírenie Phase 2.4: server-side a OS-level optimalizácie pre stabilný beh pri narastajúcom počte agentov, plus end-to-end zdravie servera.

### 19.1 Riešené problémy

| Problém | Riziko | Riešenie |
|---|---|---|
| `bitcoind` rast | Disk plný za týždne pri full-node | BTCPay stack už beží s `prune=5000` (5 GB cap), 12 GB chainstate je nutný UTXO set |
| Nedostatok swap | OOM kill pri RAM spike (Node + Postgres + bitcoind) | 2 GB `/swapfile` + `swappiness=10` (perzistované cez `/etc/fstab`) |
| `webhook_deliveries` rast | 1 row per LN platba + BTCPay event, ~1 000 rows už teraz | Pridané do retention worker (archive 30d, hard-delete 365d) |
| `heartbeats_log` rast | Pri 1 000 botov × heartbeat/5min ≈ 288 000 rows/deň | Hard-delete starší ako 14 dní (žiadny archive — nízka audit hodnota) |
| Dead tuples po DELETE | DB bloat, autovacuum chodí len pri 20% mŕtvych tuples | `VACUUM (ANALYZE)` automaticky beží na konci každého retention tick |
| DB pool 10 conn limit | Pri spike sa requesty queue-ujú | `DB_POOL_MAX=20` + `statement_timeout=10s` + `connectionTimeoutMillis=5s` |
| Žiadny capacity monitoring | Operátor nevie o disk/RAM kríze pred OOM | `GET /api/admin/system-health` + `scripts/health-alert.sh` (cron) |

### 19.2 DB schéma — migrácia 007

```
webhook_deliveries_archive       -- idž stĺpce + archived_at
heartbeats_log_archive            -- pripravené, no zatiaľ hard-delete bez archive
idx_action_log_received_at
idx_repevent_occurred_at
idx_reports_created_at
idx_certsign_signed_at
idx_rejreq_occurred_at
ALTER TABLE … SET (autovacuum_vacuum_scale_factor = 0.05)  -- agresívnejší autovacuum
```

### 19.3 Retention worker rozšírenia

- **`webhook_deliveries`** — archive po 30d, hard-delete archive po 365d.
- **`heartbeats_log`** — len hard-delete po 14d (žiadny archive, audit irrelevantný).
- **VACUUM ANALYZE** — beží na konci tick na 6 high-traffic tabuľkách (`action_log`, `reputation_events`, `reports`, `cert_signing_log`, `rejected_requests`, `webhook_deliveries`).

### 19.4 `/api/admin/system-health`

Read-only health endpoint vracajúci JSON s:
- `disk` — total/used/available/percent
- `ram` — total/free/percent
- `swap` — total/used/free
- `load` — load1/5/15 + load_per_cpu_1m
- `db_pool` — totalCount / idleCount / waitingCount / max / percent_used
- `db_size` — Postgres DB size (pg_database_size)
- `pg_connections` — `pg_stat_activity` aktívne queries
- `alerts[]` — array prahových hlásení (critical / warning) na disk≥80/90%, RAM≥80/90%, load≥1×/2× CPU, db_pool≥80%

**Status enum:** `ok` (žiadne alerty) → `warning` (≥1 warning) → `critical` (≥1 critical).

### 19.5 `scripts/health-alert.sh`

Cron-friendly bash script ktorý:
1. Volá `/api/admin/system-health` (Admin-Key z `.env`)
2. Loguje status + alerts do `/var/log/kyahub-health.log`
3. Pri novom `critical` stave vytvorí `/tmp/kyahub-critical.flag` a pošle webhook (Telegram/Slack/Discord cez `ALERT_WEBHOOK_URL`)
4. Pri návrate do `ok` pošle "recovered" notifikáciu a zmaže flag

**Cron príklad (každých 5 min):**
```cron
*/5 * * * * /root/kya-hub/scripts/health-alert.sh >> /var/log/kyahub-health.log 2>&1
```

### 19.6 DB pool tuning + PgBouncer guidance

V `.env` sú vystavené tieto premenné:

```bash
DB_POOL_MAX=20               # default; navýšiť na 40 ak >2 000 botov
DB_POOL_MIN=2
DB_POOL_IDLE_MS=30000
DB_POOL_CONN_TIMEOUT_MS=5000 # max čakanie na voľné spojenie
DB_STATEMENT_TIMEOUT_MS=10000 # chráni pred runaway SELECTmi
DB_QUERY_TIMEOUT_MS=15000
```

**Kedy nasadiť PgBouncer:**
- Pri `db_pool.percent_used` trvalo nad 80% v `system-health`.
- Pri >5 000 agentov (každý môže mať burst 2–3 paralelných reqov).
- Setup: `apt install pgbouncer`, `pool_mode=transaction`, `default_pool_size=50`, v `.env` zmeniť `DB_PORT=6432` a `DB_POOL_MAX=10` (Node poolu stačí menej, lebo PgBouncer multiplexuje).

### 19.7 Aktuálny stav servera (snapshot 2026-05-11)

```
disk:  22 GB / 38 GB (62%) — bitcoind 16 GB (prune=5000 už beží), DB 12 MB
ram:   2.7 GB / 15.6 GB (18%) — všetko OK
swap:  2 GB total, ~1.6 GB used (rezerva proti OOM, neaktívna degradácia)
load:  ~0.5× CPU count (4 cores) — žiadna saturácia
db:    12 MB total, pool max=20 / aktívne 1
```

Najväčšia DB tabuľka: `webhook_deliveries` (1 149 rows, 608 kB). Pri 1 000 botov × 30 dní očakávaný rast `action_log` ~5 GB → archive odbremeňuje origin na pár stoviek MB.

### 19.8 Environment premenné (Phase 2.4 follow-up)

```bash
# Retention worker — nové
RETENTION_WEBHOOK_DAYS=30
RETENTION_WEBHOOK_HARDDEL_DAYS=365
RETENTION_HEARTBEAT_DAYS=14
RETENTION_VACUUM=true            # vypni iba pri ladení

# DB pool tuning
DB_POOL_MAX=20
DB_POOL_MIN=2
DB_POOL_IDLE_MS=30000
DB_POOL_CONN_TIMEOUT_MS=5000
DB_STATEMENT_TIMEOUT_MS=10000
DB_QUERY_TIMEOUT_MS=15000

# (voliteľné) health-alert.sh
ALERT_WEBHOOK_URL=               # ak prázdne, len log
```

### 19.9 Operator playbook — capacity

**Skontrolovať zdravie servera (one-shot):**
```bash
curl -sS -H "X-Admin-Key: $ADMIN_KEY" http://127.0.0.1:3000/api/admin/system-health | jq .status,.alerts,.disk,.ram,.swap
```

**Manuálne spustiť VACUUM + retention:**
```bash
curl -X POST -H "X-Admin-Key: $ADMIN_KEY" http://127.0.0.1:3000/api/admin/retention/run | jq .stats.vacuumed
```

**Aktivovať cron alert:**
```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * /root/kya-hub/scripts/health-alert.sh >> /var/log/kyahub-health.log 2>&1") | crontab -
```

**Vyladiť disk ďalej (ak by sa minul):**
1. `prune=2000` v BTCPay `bitcoin-extra.txt` → znížiť blocks z 3 GB na 1 GB.
2. `RETENTION_*_DAYS` znížiť pre `action_log` na 30 a `repevent` na 60.
3. Iba ako posledná možnosť: pripojiť Hetzner volume a presunúť `/var/lib/postgresql` (vyžaduje downtime).

---

---

## 20. Phase 2.4 Reliability & Compliance ✅

Operatívne doplnenie Phase 2.4 — odolnosť proti výpadkom upstream služieb, právny disclaimer v certifikáte, dennú zálohu DB, log rotation a server-side notifikácie.

### 20.1 Riešené problémy

| Problém | Riziko | Riešenie |
|---|---|---|
| BTCPay padne → noví boti dostanú 500 | Stratené registrácie, zlý UX | **Circuit breaker** v `lib/circuit-breaker.js` + `/api/pay` vracia `503 PAYMENT_SYSTEM_UNAVAILABLE` s `Retry-After` header |
| Hub padne v piatok večer | Strata 3 dní registrácií kým si všimneš | **Health monitor** v server.js (60s tick) + `lib/notifications.js` → Telegram alert pri DB/BTCPay výpadku |
| ELITE registrácia uniknutá | Vysokohodnotný event sa stratí v logoch | Telegram PING `PING: Registration paid (ELITE)` po každej úspešnej ELITE registrácii (rovnako BASIC — všetky tiery) |
| Žiadny disclaimer | Právna zodpovednosť za správanie certifikovaných botov | `termsOfUse[].disclaimer` v každom signed certifikáte + env `CERT_DISCLAIMER` |
| Žiadne zálohy | Hardware crash → strata všetkých agentov | `scripts/backup-db.sh` (denne 03:15) + 7 daily + 4 weekly rotácia + SHA-256 checksum |
| Nekonečné logy | Disk plný za týždne | `pm2-logrotate` (50 MB/14d/gzip) + `/etc/logrotate.d/kyahub` pre projekt logy |
| Žiadny ľahký liveness check | UptimeRobot atď. potrebuje fast 200 | `GET /api/status` (žiadny DB call, len uptime + ts) |

### 20.2 Circuit breaker

**Súbor:** `lib/circuit-breaker.js`

Stavy: `CLOSED` → (5 consecutive failures) → `OPEN` (60 s skip volania) → `HALF_OPEN` (1 probe) → CLOSED (po 2 successoch).

Registry: lazy `breaker.get('btcpay')` / `breaker.get('alby')`. Stav vidno cez **`GET /api/admin/breakers`**.

**Flow pri /api/pay výpadku BTCPay:**
1. Prvých 5 zlyhaní → klient dostane `502 INVOICE_FAILED` (alebo Alby fallback OK).
2. Po 5. zlyhaní → breaker `OPEN` → ďalšie pokusy hneď vracajú `503 PAYMENT_SYSTEM_UNAVAILABLE` s `Retry-After: 60`.
3. Súčasne sa pošle Telegram **⚠️ BTCPay unreachable** (dedupe 5 min).
4. Po 60 s breaker prejde do `HALF_OPEN`, povolí 1 probe.
5. Pri úspechu → po 2 úspešných = `CLOSED` + `ℹ️ BTCPay recovered` notifikácia.

### 20.3 Server-side notifications

**Súbor:** `lib/notifications.js`

Spoločný helper pre Telegram + Discord (oboje voliteľné cez env). Fire-and-forget (`Promise.allSettled`), 3 s timeout, in-memory dedupe 5 min.

**Vstavané helpers:**
- `notifyRegistrationPaid({tier, agentName, axisId, paymentMethod, amountSats})` — Telegram/Discord PING po každej zaplatenej registrácii (BASIC aj ELITE). `notifyEliteRegistered(...)` je tenký alias s `tier: 'ELITE'`.
- `notifyBtcpayOutage({error, httpStatus})`
- `notifyDbDown({error})`
- `notifyHmacFailureSpike({source, count, window_min})`
- generic `notify({category, title, body, dedupe_key})`

**Server-side health monitor** (v `server.js` `start()`): každých 60 s pingne `pool.query('SELECT 1')` a BTCPay `/invoices?take=1`. Pri prechode `healthy→down` pošle critical / warning alert; pri `down→healthy` pošle `recovered`.

### 20.4 Cert disclaimer (`termsOfUse`)

Každý vystavený certifikát teraz obsahuje:

```json
"termsOfUse": [{
  "type": "IssuerPolicy",
  "id": "https://umbraxon.xyz/terms",
  "disclaimer": "This certificate attests the agent's reputation based on historical on-hub behavior. It is NOT a guarantee of future conduct. UMBRAXON KYA-Hub operator disclaims all liability for losses or damages caused by certified agents. Relying parties are expected to perform their own due diligence proportional to transaction value.",
  "relyingPartyDuty": "due_diligence_proportional_to_value"
}]
```

Text je hot-editovateľný cez `CERT_DISCLAIMER` env premennú; URL `https://umbraxon.xyz/terms` cez `CERT_TERMS_URL`. Pole je **canonical-included** → podpis cert overí aj disclaimer (nedá sa ex-post modifikovať bez invalidácie podpisu).

### 20.5 Backup script (`scripts/backup-db.sh`)

- `pg_dump -Fc -Z 6` (PostgreSQL custom format, kompresia 6) do `/var/backups/kyahub/daily/`
- Pre-flight check: voľné miesto ≥ 2× DB size
- SHA-256 checksum pre integrity (`.sha256` súbor vedľa)
- Rotácia: 7 daily + 4 weekly (nedeľa = weekly hardlink)
- Pri zlyhaní → Telegram `💾 KYA-Hub backup FAIL`
- Cron: `15 3 * * * /root/kya-hub/scripts/backup-db.sh >> /var/log/kyahub-backup.log 2>&1`

**Restore (full disaster recovery):**
```bash
# 1) Skontroluj integrity
sha256sum -c /var/backups/kyahub/daily/kyahub_*.dump.sha256

# 2) Restore do nového DB (NIKDY priamo do produkcie!)
createdb -U postgres kyahub_restore
pg_restore -U postgres -d kyahub_restore --clean --if-exists --no-owner \
    /var/backups/kyahub/daily/kyahub_YYYYMMDD_HHMMSS.dump

# 3) Verifikuj (count agentov, certifikátov)
psql -U postgres -d kyahub_restore -c "SELECT count(*) FROM agents;"

# 4) Swap (downtime ~30 s)
sudo systemctl stop pm2-root  # alebo pm2 stop kya-hub
psql -U postgres -c "ALTER DATABASE kyahub RENAME TO kyahub_old"
psql -U postgres -c "ALTER DATABASE kyahub_restore RENAME TO kyahub"
sudo systemctl start pm2-root
```

### 20.6 Log rotation

**PM2 logy** (`~/.pm2/logs/*.log`) — `pm2-logrotate` modul:
- `max_size=50M`, `retain=14`, `compress=true`, daily rotation
- nastavené: `pm2 set pm2-logrotate:max_size 50M ; pm2 set pm2-logrotate:retain 14 ; pm2 set pm2-logrotate:compress true`

**Projekt logy** (`server.log`, `output.log`, `bot.log`) — `/etc/logrotate.d/kyahub`:
- daily, retain 14, compress, copytruncate (žiadny restart netreba)
- maxsize 50M (force rotate ak väčší)

**Health logy** (`/var/log/kyahub-health.log`) — weekly, retain 8.

### 20.7 API endpoints (nové)

| Method | Cesta | Auth | Popis |
|---|---|---|---|
| GET | `/api/status` | — | Lightweight liveness ping (žiadny DB call) |
| GET | `/api/admin/breakers` | `X-Admin-Key` | Stav circuit breakerov (CLOSED/OPEN/HALF_OPEN + metriky) |

### 20.8 Environment premenné

```bash
# Notifications
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_CHAT_ID=<chat_id>
DISCORD_WEBHOOK_URL=     # voliteľné (paralelný kanál)
NOTIF_ENABLED=true
NOTIF_DEDUPE_MS=300000   # 5 min between duplicate alerts
NOTIF_TIMEOUT_MS=3000

# Health monitor (server-side periodic DB + BTCPay check)
HEALTH_MONITOR_INTERVAL_MS=60000

# Circuit breaker
CB_FAILURE_THRESHOLD=5
CB_SUCCESS_THRESHOLD=2
CB_OPEN_DURATION_MS=60000

# Cert disclaimer
CERT_DISCLAIMER=<viď default v lib/certs.js>
CERT_TERMS_URL=https://umbraxon.xyz/terms
```

### 20.9 Cron schedule (komplet)

```
*/5 * * * * /root/kya-hub/scripts/health-alert.sh   # capacity alert
15 3 * * *  /root/kya-hub/scripts/backup-db.sh      # daily DB backup
0 4 * * 7   /usr/bin/docker system prune -af        # weekly cleanup
```

### 20.10 Operator playbook — disaster scenarios

**BTCPay padol cez víkend, registrácie zlyhávajú:**
1. Telegram už dostal `⚠️ BTCPay unreachable` (do 60 s od prvej chyby).
2. Boti dostanú 503 s `Retry-After: 60`.
3. Po fixe BTCPay → breaker sa sám obnoví → `ℹ️ BTCPay recovered` notifikácia.
4. Manuálny reset (ak treba): `pm2 restart kya-hub` (breaker je in-memory, restart = clean state).

**DB nedostupná:**
1. Telegram dostane `🚨 Database connectivity lost` do 60 s.
2. Pozri logy: `pm2 logs kya-hub --lines 50`.
3. Skontroluj Postgres: `systemctl status postgresql`.
4. Po obnove → automaticky `ℹ️ Database recovered`.

**Strata DB (najhorší scenár):**
1. `ls -la /var/backups/kyahub/daily/` — vyber posledný backup.
2. Postupuj podľa 20.5 (restore section).
3. RTO (Recovery Time Objective): ~5 min pri DB velikosti < 1 GB.
4. RPO (Recovery Point Objective): ≤ 24 h (jedna denná záloha).

---

---

## 21. Phase 2.5 Payment Production Setup ✅ (čiastočne — Alby UI setup čaká na operátora)

End-to-end príprava platobnej infraštruktúry pre mainnet (bitcoind v synced state, BTCPay LIVE).

### 21.1 Sync stav

| Komponent | Stav |
|---|---|
| `bitcoind` | ✅ Synced, prune=5000, NBXplorer streamuje nové bloky (block 949049+) |
| `nbxplorer` | ✅ Connected, real-time event stream |
| BTCPay Server | ✅ Online, store nakonfigurovaný |
| Alby Hub (binary) | ✅ Beží na `127.0.0.1:8080` cez PM2 (`alby-hub`) |
| Alby Hub (setup wizard) | ⚠️ Vyžaduje user input cez SSH tunel |
| BTCPay internal LND | ⚠️ Plánované ako fallback (Phase 2.5b) |
| Cold wallet | ⚠️ Generator pripravený, čaká HW alebo paper seed |
| Auto-sweep | ✅ Script pripravený (čaká `SWEEP_DESTINATION_ADDRESS`) |

### 21.2 Architektúra (target state)

```
┌──────────────────────────────────────────────────────────────┐
│                        BOT (klient)                          │
│                       POST /api/pay                          │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│                    KYA-Hub /api/pay                          │
│        Try ALBY (LDK, primary)  →  on fail (breaker)         │
│            BTCPay LND (fallback)                             │
│              on both fail → 503 Retry-After                  │
└──────────────────────────────────────────────────────────────┘
                              ↓
                    Lightning invoice / onchain
                              ↓
┌──────────────────────────────────────────────────────────────┐
│  HOT wallet (auto, online)        ≤ 50 000 SAT               │
│  • BTCPay onchain wallet (BTC)                               │
│  • Alby Hub Lightning balance                                │
└──────────────────────────────────────────────────────────────┘
                              ↓ (sweep at threshold, manual sign)
┌──────────────────────────────────────────────────────────────┐
│  COLD wallet (manual)             ≥ 50 000 SAT               │
│  • BIP-84 zpub v BTCPay (receive only)                       │
│  • Seed na papieri/HW wallet (offline)                       │
│  • PSBT podpis cez Sparrow/Coldcard/Trezor                   │
└──────────────────────────────────────────────────────────────┘
```

### 21.3 Alby Hub primary Lightning setup (operator action)

**Krok 1 — SSH tunel z lokálneho PC:**
```bash
ssh -L 8080:127.0.0.1:8080 root@<hetzner_IP>
```

**Krok 2 — Otvor v lokálnom prehliadači:** `http://localhost:8080`

**Krok 3 — Setup wizard:**
1. **Set master password** (min. 14 znakov; ulož do password manageru).
2. **Choose backend**: LDK Node — odporúčané (jednoduché, full-node nezávislé).
3. **Backup seed** — ZAPÍŠ 12 slov na papier, nikam inde.
4. **Sync** trvá ~2–10 min (LDK gossip).
5. **Open channel** s LSP (odporúčam **Olympus** alebo **Megalith** — 1 % fee):
   - Suma: minimálne 200 000 SAT inbound (na 20× BASIC platby).
   - Fee: ~2 000 SAT pre 200k inbound.
6. **Create NWC connection**:
   - V Alby UI: Apps → New connection → "KYA-Hub server"
   - Budget: 50 000 SAT/day, all permissions (create_invoice, pay_invoice, get_balance)
   - **Skopíruj NWC URI** (`nostr+walletconnect://...`)

**Krok 4 — Pridaj NWC do `.env`:**
```bash
nano /root/kya-hub/.env
# Pridaj/aktualizuj:
ALBY_NWC_URI=nostr+walletconnect://...
```

**Krok 5 — Reload server:**
```bash
pm2 reload kya-hub --update-env
curl http://127.0.0.1:3000/api/health   # alby by mal byť OK
```

### 21.4 Cold wallet generator (`scripts/gen-cold-wallet.js`)

**Generuje:**
- 24-word BIP-39 mnemonic (256-bit entropy)
- BIP-84 derivation path `m/84'/0'/0'` (native segwit, bech32 `bc1q...`)
- `xpub` + `zpub` (zpub formát je preferovaný BTCPay-om)
- First receive address (sanity check)

**Bezpečnostné varovanie:**
- Seed je generovaný **NA SERVERI** (online). Pre malé sumy (do 100 EUR ekvivalent) OK; pre väčšie sumy si **kúp hardware wallet** (Coldcard $150, Trezor Safe 3 $80, SeedSigner DIY $20).
- Seed sa zobrazí **iba v termináli**, neukladá sa nikde. Po vygenerovaní hneď:
  ```bash
  history -c && history -w
  pm2 logs --raw | grep -v -- "gen-cold-wallet" > /tmp/clean.log  # ak by sa náhodou logoval
  ```
- Iba **public data** (`xpub`, `zpub`, fingerprint, first addr) sa uloží do `/root/kya-hub/.cold-wallet-public.json`.

**Použitie:**
```bash
cd /root/kya-hub
node scripts/gen-cold-wallet.js
# Interactive: prejdeš seed-printom + verifikáciou 3 random slov + xpub print

# Alternatíva: derive xpub z existujúceho seed (napr. tvojho HW)
node scripts/gen-cold-wallet.js --derive
# (zadáš 24 slov, vypíše xpub bez ukladania)
```

**Po vygenerovaní:**
1. BTCPay UI → Wallets → BTC → "Use an existing wallet" → "Connect to a wallet" → "Other" → paste zpub.
2. BTCPay vygeneruje receive adresy pre sweep.
3. Pridaj prvú receive adresu do `.env`:
   ```bash
   SWEEP_DESTINATION_ADDRESS=bc1q...
   ```

### 21.5 Hot wallet auto-sweep (`scripts/sweep-hot-wallet.sh`)

**Algoritmus (hodinový cron):**
1. GET BTCPay onchain wallet balance.
2. Ak `balance > SWEEP_THRESHOLD_SATS` (default 50 000):
   - Vytvor BTCPay **payout request** s `destination=SWEEP_DESTINATION_ADDRESS`, `amount=balance - 10 000` (10 000 SAT zostáva v hot pre fees).
   - Pošli Telegram: `💰 Sweep ready for signature: 75 000 SAT → bc1q...abc`
3. Cooldown 24 h (po vytvorení payout-u sa znova nespúšťa).

**Operator workflow (1×/týždeň):**
1. Dostaneš Telegram alert.
2. Otvor BTCPay Server → Payouts.
3. Approve payout → BTCPay vytvorí PSBT.
4. Podpíš PSBT v **Sparrow Wallet** (alebo Coldcard) seedom.
5. Broadcast → BTC ide z hot do cold/warm wallet.
6. Po confirmácii dostaneš `✅ Sweep confirmed: txid abc...`.

**Env premenné:**
```bash
SWEEP_THRESHOLD_SATS=50000          # spúšť pri tomto stave
SWEEP_KEEP_HOT_SATS=10000           # ponechaj v hot pre fees
SWEEP_DESTINATION_ADDRESS=bc1q...   # receive adresa cold walletu
SWEEP_PAYOUT_METHOD=BTC-CHAIN
SWEEP_COOLDOWN_HOURS=24
```

**Cron entry (pridaj manuálne keď budeš mať cold wallet):**
```cron
0 */4 * * * /root/kya-hub/scripts/sweep-hot-wallet.sh >> /var/log/kyahub-sweep.log 2>&1
```

### 21.6 BTCPay API key upgrade

Aktuálny `BTCPAY_API_KEY` nemá `canmodifystoresettings` permission, takže auto-sweep nefunguje.

**Postup (manuálne v BTCPay UI):**
1. BTCPay → Account → API Keys → "Generate Key".
2. Permissions: **Full access for store** (alebo presný checklist: `cancreatelightninginvoice`, `canmodifyinvoices`, `canmodifystoresettings`, `canviewstoresettings`, `canmanagepayouts`).
3. Skopíruj nový key, nahraď v `.env`:
   ```bash
   BTCPAY_API_KEY=<nový kľúč>
   ```
4. `pm2 reload kya-hub --update-env`

### 21.7 Disclaimer v cert (Phase 2.4 Reliability) — overené v Phase 2.5

`test-payments.js [9]` overuje, že každý vystavený cert obsahuje `termsOfUse[0].disclaimer` s minimálne 50 znakmi a že cert sa kryptograficky verify-uje **vrátane disclaimeru** (lebo `termsOfUse` je súčasťou canonical body → akákoľvek modifikácia invaliduje podpis).

### 21.8 E2E test (`test-payments.js`)

12 testov:
1. `/api/status` ping
2. `/api/health` (server + DB + BTCPay)
3. `/api/tiers` reflektuje pricing
4. `/api/admin/breakers` stav circuit breakerov
5. `POST /api/pay` → BTCPay invoice (s PoW solver)
6. `GET /api/check-status/:invoiceId`
7. Simulated `InvoiceSettled` webhook (HMAC validovaný)
8. **Idempotency** — rovnaký webhook 2× → druhý skip (žiadny duplicate agent)
9. Agent registrovaný + cert obsahuje disclaimer
10. Offline cert verify (signature + disclaimer)
11. Bad HMAC → 401
12. Cleanup test agentov

**Spustenie:** `node test-payments.js`

### 21.9 Mainnet 1000 SAT test (po Alby setupe)

**Postup:**
1. Manuálne register-uj test bota cez `/api/pay`:
   ```bash
   curl -X POST http://127.0.0.1:3000/api/pay -H "Content-Type: application/json" \
       -d '{"amount":1000,"agentName":"MAINNET-TEST-001","pubkey":"abc..."}'
   ```
   *(treba dočasne pridať tier 1000 SAT do `tier_pricing` alebo testovať s plnou cenou 10 000 SAT)*
2. Zaplať Lightning invoice z osobnej peňaženky.
3. Overí sa:
   - Webhook prišiel (`pm2 logs kya-hub | grep webhook`)
   - Agent vytvorený (`/api/dashboard`)
   - Cert obsahuje disclaimer (`/api/cert/<kya_id>`)
   - Telegram PING prišiel (`PING: Registration paid (BASIC)` alebo `(ELITE)`) ak sú `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
4. Cleanup: `DELETE FROM agents WHERE agent_name = 'MAINNET-TEST-001'`

### 21.9b Real LN payment test (Alby NWC end-to-end) ✅ 2026-05-12

**Najprv úspešný real Lightning payment cez Alby Hub NWC integráciu** (po otvorení channela s MegaLith LSP).

**Setup:**
- Alby Hub channel s MegaLith LSP otvorený (1M SAT inbound, funding TX `03cd4c52a32693a56a49590a3d3348b060d13a0453aad65df3f5a2907e561af2`, 0-conf JIT)
- Channel fee: 18,507 SAT (~$15 USD) zaplatené z Binance LN
- BASIC tier dočasne znížený na 6000 SAT cez `POST /api/admin/pricing` (po teste obnovený na 10000)

**Test parametre:**
- Agent name: `real-ln-test-6k`
- Tier: BASIC (6000 SAT temp)
- Method: `alby_ln` (NWC over Nostr)
- Script: `scripts/test-real-ln-payment.js` s `TIER_AMOUNT_OVERRIDE=6000`

**Výsledok:**
- ✅ **Agent**: `UMBRA-CAD028`, status `VERIFIED`, reputation 500 (NEUTRAL)
- ✅ **Payment hash**: `e2d7e7573a7a6d67decb4fb1838766b6096da70b27c34c2479ed3934d299f3a2`
- ✅ **Cert ID**: `urn:kya:cert:CERT-CAD028-001`, signed by hub key `7b51ce92c886ec67...`
- ✅ **Cert sig**: `ced308a5d18a1b768d7201e7bf1461fc...` — **VALID** (offline crypto verify)
- ✅ **Webhook**: `alby-nwc` source, event `payment_received`, processed=true
- ✅ **Latency**: invoice created `12:22:49`, payment_received `12:28:42` (5:53 user-side)
- ✅ **NWC subscription**: real-time delivery cez Nostr relays (žiadny polling potrebný server-side)

**Validuje:**
1. Alby Hub LDK channel → NWC funguje pre incoming payments (0-conf JIT)
2. `lib/alby.js` `subscribeNotifications('payment_received')` doručuje events spoľahlivo
3. Server.js auto-registrácia po Alby webhook prebehne v ms (12:28:42.732 → 12:28:42.739 = **7ms** end-to-end)
4. Cert signing pipeline produkuje kryptograficky validné podpisy aj pri LN payment ceste
5. Disclaimer v `termsOfUse[]` prítomný v každom signed certifikáte

**Pricing revert audit:**
- `tier_pricing` history riadky: id=66 (6000) → id=67 (10000, `revert-after-test`)
- Aktuálny snapshot `/api/tiers`: BASIC.total = 10000 ✅

### 21.10 Production launch checklist

Stav synchronizovaný s dokumentovanými dôkazmi v tejto príručke + verejným smoke testom **2026-05-13** (`https://umbraxon.xyz/api/health`, `/api/tiers`, `/terms` → HTTP 200; `umbraxon.xyz:3000` z internetu timeout — API ide cez 443/nginx). Položky označené `[ ]` vyžadujú ešte explicitné potvrdenie operátora (cold wallet / sweep / HW). **Krok za krokom:** [docs/GO-LIVE-OPERATOR-WALKTHROUGH.md](docs/GO-LIVE-OPERATOR-WALKTHROUGH.md).

- [x] **Alby Hub setup**: SSH tunel + setup wizard + channel s LSP (200k SAT inbound) — viď §21.9b + §30.Y (MegaLith ~1M kanál, liquidity OK).
- [x] **NWC URI**: skopírovaný do `.env` ako `ALBY_NWC_URI` — predpoklad potvrdený funkčným webhook flow v §21.9b.
- [x] **BTCPay API key**: kľúč v `.env` (verejný `/api/health` 2026-05-13: `btcpay.status` = OK).
- [ ] **Cold wallet**: `gen-cold-wallet.js` → seed na papier → zpub do BTCPay → `SWEEP_DESTINATION_ADDRESS` v `.env` — operátor potvrdí.
- [x] **Mainnet test 1000 SAT**: BASIC registrácia end-to-end — splnené cez real LN test (6000 SAT temp tier) v **§21.9b**; aktuálna BASIC cena 10 000 sat (§21.9b pricing revert).
- [ ] **Sweep cron**: aktívny (4× denne kontrola) — skontrolovať `crontab` + §21.5; starší poznámok riadok o BTCPay API scope pre payout treba overiť proti aktuálnemu kľúču.
- [x] **Backup**: prvý úspešný off-site upload — `scripts/backup-database.sh` + `scripts/backup-channel-state.sh` + R2 (§30.14 gate #1 RESOLVED).
- [ ] **Hardware wallet objednaný**: nahradí paper seed po doručení (Trezor Safe 3 / Coldcard) — operátor.
- [x] **Disaster recovery test**: kvartálny restore drill PASS 2026-05-12 (§31 A.3); ročný cyklus ponechať v runbooku.

### 21.11 Out-of-scope (Phase 2.5b / Phase 3)

- **BTCPay internal LND** ako fallback Lightning — vyžaduje rekonfiguráciu Docker stacku.
- **Multisig 2-of-3 cold wallet** — keď bude 3+ hardware wallety k dispozícii.
- **Lightning rebalancing automation** — keď bude > 100 platieb/deň.
- **Automatic payout signing** cez online HSM — nikdy (manuálne podpisovanie je security feature).

---

## 22. Phase 3 — Public Exposure: Nginx Reverse Proxy + Rate Limiting ✅

**Cieľ:** vystaviť `https://umbraxon.xyz` na internet so silnou L4/L7 ochranou,
TLS termináciou cez Let's Encrypt, hard limits (slowloris, body size) a per-endpoint
rate-limit zónami — pri zachovaní samostatnosti od BTCPay stack-u.

**Architektúra:**

```
INTERNET
   │ HTTPS:443
[BTCPay nginx-proxy]  ──Host=pay.umbraxon.xyz──► btcpayserver:49392
       │ (auto-managed by nginx-gen + letsencrypt-companion)
       └─Host=umbraxon.xyz──► kya-hub-proxy:80
                                  │  (lightweight nginx:alpine ambassador,
                                  │   docker network: generated_default)
                                  ▼
                              host:3000 (kya-hub, pm2 native)
```

### 22.1 Why ambassador pattern?

BTCPay používa **jwilder/nginx-proxy** systém (containers s `VIRTUAL_HOST` env var sú
automaticky vystavené externe so SSL). kya-hub beží natívne na host-e (pm2), nie v Dockeri.
Riešenie: pridáme malý `nginx:alpine` container, ktorý:
- má správne env vars (`VIRTUAL_HOST_NAME=kyahub`, `VIRTUAL_HOST=umbraxon.xyz`,
  `LETSENCRYPT_HOST=umbraxon.xyz`)
- forwarduje traffic na `host.docker.internal:3000` (kya-hub)
- aplikuje rate limits a hard L4 limits PRED dosiahnutím kya-hub

Výhody:
- ✅ TLS auto-renewal (90-day Let's Encrypt) — rovnaký systém ako `pay.umbraxon.xyz`
- ✅ Nemodifikuje BTCPay docker-compose
- ✅ Ambassador padne → kya-hub stále beží (oddelený fault domain)
- ✅ kya-hub má `app.set('trust proxy', 1)` → `req.ip` = real client IP cez X-Forwarded-For

### 22.2 Komponenty

| Súbor / objekt | Účel |
|----------------|------|
| `nginx-proxy/docker-compose.yml` | Definícia kya-hub-proxy containera |
| `nginx-proxy/conf.d/default.conf` | Main nginx config (upstream, rate zones, server block) |
| `nginx-proxy/snippets/proxy-headers.conf` | Spoločné proxy_set_header direktívy |
| `nginx-proxy/README.md` | Operator dokumentácia (start/stop/reload/troubleshoot) |
| **Docker container `kya-hub-proxy`** | Bežiaca služba, restart=unless-stopped |
| **Docker network `generated_default`** | Zdieľaná s BTCPay containers |

### 22.3 Rate-limit profil (per-IP, X-Forwarded-For aware)

| Zóna | Endpoint | Rate | Burst | Účel |
|------|----------|------|-------|------|
| `rl_pay` | `/api/pay`, `/api/invoice/*` | 10/min | 5 | Platobný flow — strict |
| `rl_register` | `/api/register-bot`, `/api/register` | 6/min | 3 | Registrácia (PoW gate v app-e) |
| `rl_action` | `/api/action`, `/api/heartbeat`, `/api/report` | 120/min | 30 | Heartbeats (legitímne časté) |
| `rl_admin` | `/api/admin/*` | 30/min | 15 | Admin endpoints |
| `rl_default` | všetko ostatné | 60/min | 20 | Default catch-all |
| `cc_per_ip` | TCP connections | 50 max | – | Concurrent connection cap |
| `/api/status` | – | **bez limitu** | – | Liveness (monitoring/uptime) |
| `/api/webhook/btcpay` | – | **bez limitu** | – | BTCPay server-to-server (HMAC overuje aplikácia) |
| `/api/webhook/alby` | – | **bez limitu** | – | Alby server-to-server (Phase 3D) |

Response 429 vracia konzistentný JSON:
```json
{"error":"rate_limited","message":"Too many requests...","retry_after_seconds":60}
```
+ `Retry-After: 60` header.

### 22.4 Hard limits (L4 / slowloris protection)

| Direktíva | Hodnota | Účel |
|-----------|---------|------|
| `client_max_body_size` | 256k (256k pre webhook BTCPay, 64k pre Alby) | Anti-DoS payload bloating |
| `client_body_timeout` | 10s | Slowloris (telo) |
| `client_header_timeout` | 10s | Slowloris (hlavičky) |
| `send_timeout` | 10s | Slow client recv |
| `keepalive_timeout` | 15s | Idle keepalive cap |
| `proxy_read_timeout` | 20s | Upstream response timeout |
| `proxy_connect_timeout` | 5s | Upstream connect timeout |
| `large_client_header_buffers` | 4 × 16k | Cap header size |

### 22.5 Security headers

Doplnené **nad rámec** tých, čo nastavuje kya-hub (helmet):
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (HSTS 2 roky)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: no-referrer-when-downgrade`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`

### 22.6 Verified metrics (post-deployment)

- **TLS:** Let's Encrypt R13 cert (notAfter `2026-08-10`), TLSv1.3, `TLS_AES_256_GCM_SHA384`
- **TTFB:** ~22ms (DNS → TLS handshake → TTFB → total, end-to-end z externej siete)
- **HTTP → HTTPS:** 301 redirect (auto by outer nginx)
- **Rate limit:** 100/100 HTTP 429 pri 100× sekvenčnom hit-e `/`
- **Connection limit:** 176/200 HTTP 429 pri 200× paralelných requestoch (cc_per_ip 50)
- **PoW gate cez public URL:** `POST /api/pay` bez `X-Pow` → HTTP **402** `POW_REQUIRED` ✅
- **Public cert verify:** `https://umbraxon.xyz/api/cert/<KYA_ID>` Ed25519 ✅ VALID
- **Webhook BTCPay:** prijíma traffic OK, signature overuje aplikácia

### 22.7 Operator playbook

```bash
# Štart / stop
cd /root/kya-hub/nginx-proxy
docker compose up -d            # alebo docker-compose up -d
docker compose down

# Reload po zmene configu (no downtime)
docker exec kya-hub-proxy nginx -s reload

# Live access log (per real client IP, with TTFB)
docker logs -f kya-hub-proxy 2>&1 | grep -v "GET /api/status"

# Skontroluj že nginx-gen vidí náš container
docker exec nginx grep -A 5 "^upstream kyahub" /etc/nginx/conf.d/default.conf

# Skontroluj že letsencrypt-companion má cert
docker exec nginx ls /etc/nginx/certs/umbraxon.xyz/

# Force re-issue TLS cert (ak je niečo zle)
docker exec letsencrypt-nginx-proxy-companion /app/signal_le_service
```

### 22.8 Sledovanie 429 (alerting)

Pre future Phase 3 monitoring — `429` vo veľkých objemoch je signál:
- Pravdepodobne útok (Sybil registrácia)
- Alebo legitímny bot s rozbitým client-side rate-limit-om

Plánovaná Prometheus metrika `nginx_429_total` cez nginx-prometheus-exporter
(Phase 3B — Netdata setup).

### 22.9 Pridanie `www.umbraxon.xyz` (later)

1. DNS A record: `www.umbraxon.xyz → 46.225.170.80`
2. Edit `docker-compose.yml`:
   ```yaml
   VIRTUAL_HOST: "umbraxon.xyz,www.umbraxon.xyz"
   LETSENCRYPT_HOST: "umbraxon.xyz,www.umbraxon.xyz"
   ```
3. `docker compose up -d --force-recreate`
4. Let's Encrypt vystaví combined SAN cert do ~60s.

### 22.9b Bot Developer Portal `bots.umbraxon.xyz`

V repozitári je statický “Bot Developer Portal” pre integráciu botov.
Server ho servuje len pre host `bots.umbraxon.xyz` (bez dynamiky; low attack surface).

1. DNS A record: `bots.umbraxon.xyz → 46.225.170.80`
2. V `nginx-proxy/docker-compose.yml` doplň do `VIRTUAL_HOST` + `LETSENCRYPT_HOST` aj `bots.umbraxon.xyz`
3. Redeploy proxy: `docker compose up -d --force-recreate`
4. Overenie:
   - `curl -fsSI https://bots.umbraxon.xyz/ | head`
   - `curl -fsSI https://umbraxon.xyz/api/health | head`

### 22.10 Out-of-scope (Phase 3B+)

- **Per-bot rate limit** (kya_id + zone-aware) — implementované v Node.js
  (`lib/zone-rate-limiter.js`), nie v nginx vrstve. Hybrid je správny design:
  hard L4 limits v nginx, smart per-identity limity v app-e.
- **WAF (ModSecurity)** — pridáme až keď uvidíme bohaté útoky.
- **GeoIP blocking** — odložené (kya-hub je globálny by-design).
- **Cloudflare proxy (orange-cloud)** — voliteľná vrstva DDoS / edge; pri Full (strict)
  zostáva šifrovaný skok origin ↔ Cloudflare. Po zapnutí proxy vieš zúžiť UFW na
  `:80`/`:443` len na Cloudflare rozsahy (§22.12–22.13). Nie je povinná pre KYA-Hub.

### 22.11 Hetzner volume — `/root/backups`, `/var/log`, PostgreSQL (`PGDATA`) ✅

**Disk:** Hetzner Cloud Volume → `/mnt/HC_Volume_105621586` (ext4, `discard,nofail`
v `/etc/fstab` cez `/dev/disk/by-id/scsi-0HC_Volume_*`).

| Cieľ | Stav |
|------|------|
| `/root/backups` | symlink → `/mnt/HC_Volume_105621586/backups` |
| `/var/log` | symlink → `/mnt/HC_Volume_105621586/var-log` |
| PostgreSQL 16 `main` | `data_directory` = `/mnt/HC_Volume_105621586/postgresql/16/main` |
| Záloha pred presunom | `pg_dumpall` gzip v `/mnt/HC_Volume_105621586/pg-insurance/` |
| Kópia starého PGDATA na root disku | `/var/lib/postgresql/16/main.bak-pre-volume-*` (po stabilite zmazať) |

**Rollback PostgreSQL:** `systemctl stop postgresql` → v `postgresql.conf` vráť
`data_directory = '/var/lib/postgresql/16/main'` → obnov priečinok `main` z
`main.bak-pre-volume-*` → `systemctl start postgresql`.

### 22.12 Cloudflare orange-cloud — checklist (operátor v dashboarde)

1. **DNS:** `A` / `AAAA` pre `umbraxon.xyz` (a `www` / `pay` ak treba) = **Proxied**.
2. **SSL/TLS:** **Full (strict)** (origin cert ostáva LE cez nginx-proxy).
3. Overenie: `curl -fsSI https://umbraxon.xyz/api/health` → `200`.
4. Až potom §22.13 — bez proxy by zúženie UFW odrezalo legitímny traffic.

### 22.13 UFW — len Cloudflare na `:80` / `:443`

Skript stiahne rozsahy z `https://www.cloudflare.com/ips-v4` a `ips-v6`, odstráni
`allow 80/tcp` / `allow 443/tcp` z Anywhere, pridá pravidlá pre CF → 80/443.
SSH (`22`) a `172.18.0.0/16 → :3000` sa nemenia.

```bash
cd /root/kya-hub
./scripts/ufw-restrict-http-to-cloudflare.sh --dry-run
sudo ./scripts/ufw-restrict-http-to-cloudflare.sh --apply
```

---

## 23. Phase 3 — Netdata Real-time Monitoring ✅

**Cieľ:** real-time observability cez Netdata Agent, **bez vystavenia na internet**
(SSH tunnel-only), s Telegram alertami pre kritické thresholdy.

### 23.1 Architektúra

```
         (SSH tunnel: ssh -L 19999:127.0.0.1:19999 root@umbraxon.xyz)
                                       │
[laptop:19999] ────────────────────────┤
                                       ▼
                            [Netdata Agent :19999]
                            bind 127.0.0.1 ONLY
                                       │
                  ┌────────────────────┼─────────────────────┐
                  ▼                    ▼                     ▼
            apps.plugin          go.d/postgres          go.d/nginx
            (pm2, dotnet,        (PG read-only           (stub_status
             bitcoind, etc.)      'netdata' user)         on kya-hub-proxy)
                                       │
                              proc.plugin (CPU/RAM/disk/network)
                              cgroups.plugin (Docker per-container)
```

### 23.2 Inštalácia (lightweight, no cloud, no telemetry)

```bash
wget -O /tmp/netdata-kickstart.sh https://get.netdata.cloud/kickstart.sh
sh /tmp/netdata-kickstart.sh \
  --non-interactive \
  --disable-telemetry \
  --no-updates \
  --stable-channel \
  --static-only
```

### 23.3 Hardening (KRITICKÉ — bez tohto je dashboard verejný!)

V `/opt/netdata/etc/netdata/netdata.conf` (override):

```ini
[web]
    bind to = 127.0.0.1:19999 [::1]:19999
    allow connections from = localhost 127.0.0.1
    allow dashboard from = localhost 127.0.0.1
    web server max sockets = 200

[db]
    storage tiers = 3
    dbengine tier 0 retention time = 3h    # 1-sec resolution, 3h
    dbengine tier 0 retention size = 256MiB
    dbengine tier 1 retention time = 12h   # 1-min resolution, 12h
    dbengine tier 1 retention size = 64MiB
    dbengine tier 2 retention time = 30d   # 1-hour resolution, 30d
    dbengine tier 2 retention size = 64MiB

[plugins]
    # Disable plugins we don't use (saves RAM + CPU)
    nfacct = no
    timex = no
    statsd = no
    ebpf = no
    perf = no
    slabinfo = no
    tc = no
    idlejitter = no
    macos = no
    freeipmi = no
    debugfs = no
    systemd-journal = no
    otel-signal-viewer = no
```

### 23.4 Aktívne integrácie

| Plugin / Module | Charts | Účel |
|---|---:|---|
| `go.d/postgres` | 826 | kya-hub DB metrics, per-table, per-database |
| `go.d/nginx` | 6 | kya-hub-proxy active conn, requests/sec |
| `go.d/docker` | 26 | per-container CPU/RAM/network (BTCPay, bitcoind, ...) |
| `apps.plugin` | 885 | per-process incl. pm2/kya-hub, dotnet/btcpay, bitcoind, albyhub |
| `proc.plugin` | ~120 | CPU per core, RAM, swap, disk I/O, network |
| `cgroups.plugin` | – | Auto Docker memory limits, cgroup v2 stats |

### 23.5 Read-only `netdata` PostgreSQL user

```sql
CREATE USER netdata WITH PASSWORD '<32 char random>';
GRANT pg_monitor TO netdata;
GRANT CONNECT ON DATABASE kyahub TO netdata;
```

Password in `/root/kya-hub/.secrets/netdata-pg-password.txt` (0600).

### 23.6 Nginx `/stub_status` endpoint

Pridané do `kya-hub-proxy` config-u — server block `server_name nginx-stub;`
listenuje len internally a vyžaduje matching Host header:

```nginx
server {
    listen 80;
    server_name nginx-stub;
    location = /stub_status {
        stub_status;
        allow 127.0.0.1;
        allow 172.17.0.0/16;
        allow 172.18.0.0/16;
        deny all;
    }
}
```

Netdata si ho ťahá z `http://172.18.0.11/stub_status` (Docker bridge IP) každých 5s.

### 23.7 Custom alerts (`/opt/netdata/etc/netdata/health.d/kya-hub.conf`)

| Alert | Trigger | Recipient |
|---|---|---|
| `kyahub_disk_usage` | warn > 80%, crit > 90% | sysadmin |
| `kyahub_ram_usage` | warn > 80%, crit > 92% (excludes page cache!) | sysadmin |
| `kyahub_load_high` | warn > 6, crit > 12 (5m load avg, 4 cores) | sysadmin |
| `kyahub_pg_connection_usage` | warn > 75%, crit > 90% | dba |
| `kyahub_nginx_5xx_rate` | warn > 100, crit > 500 writing conns | webmaster |

Plus ~270 vstavaných Netdata alarmov (postgres replication, disk failure, OOM risk, …).

### 23.8 Telegram notifications

Reuse `.env` credentials:
```ini
TELEGRAM_BOT_TOKEN=<existing>
TELEGRAM_CHAT_ID=<existing>
```

Config v `/opt/netdata/etc/netdata/health_alarm_notify.conf`:
```bash
SEND_TELEGRAM="YES"
TELEGRAM_BOT_TOKEN="<from .env>"
DEFAULT_RECIPIENT_TELEGRAM="<TG_CHAT>"
role_recipients_telegram[sysadmin]="<TG_CHAT>"
role_recipients_telegram[dba]="<TG_CHAT>"
role_recipients_telegram[webmaster]="<TG_CHAT>"
host_name_telegram="kya-node-01"
emoji="YES"
```

Test:
```bash
sudo -u netdata /opt/netdata/usr/libexec/netdata/plugins.d/alarm-notify.sh test
```
→ pošle CRITICAL + CLEAR message do Telegram.

### 23.9 Dashboard access

**SSH tunnel** (jediný spôsob — žiadny verejný endpoint!):

```bash
# Linux / macOS / WSL
ssh -L 19999:127.0.0.1:19999 root@umbraxon.xyz
# Then: http://localhost:19999 in browser
```

Full guide: `/root/kya-hub/docs/NETDATA-ACCESS.md`.

### 23.10 Memory footprint

- **~285 MB RSS** (Netdata + plugins + go.d collectors) = <2% of 15 GB RAM
- Dominant: `go.d/postgres` (826 charts kvôli per-table stats)
- Redukcia (ak treba): v `go.d/postgres.conf` zmeniť na
  `collect_databases_matching: 'kyahub'` (vynechá postgres systémové DB → ~30% menej charts)

### 23.11 Reload bez downtime

```bash
killall -USR2 netdata        # health.d/*.conf reload
systemctl restart netdata    # full restart (go.d collectors, netdata.conf)
```

### 23.12 Out-of-scope (Phase 3+)

- **Bitcoind RPC metrics** (chain tip, mempool, peer count) — vyžaduje custom Python plugin alebo cookie auth setup.
- **Lightning channel metrics** (LDK from Alby Hub) — pre Phase 3D po LN integrácii.
- **Application-level metrics** (kya-hub: reputation distribution, certs/hour, PoW failure rate) — pridáme Prometheus exporter neskôr v kya-hub server.js (`/metrics` endpoint).
- **Long-term retention** (>30 dní) — pre incident post-mortems pridáme Netdata Parent node alebo Prometheus archiving.

---

## 24. Phase 3D — Alby Hub NWC Lightning Integration ✅

**Cieľ:** umožniť Lightning Network platby cez Alby Hub (LDK-based node) ako primary
LN backend, s fallback na BTCPay LNURL pri zlyhaní (cez circuit breaker).

### 24.1 Architektúra

```
                      ┌─────── primary ───────┐
                      │                       │
[POST /api/pay] ──► useAlby?               useAlby? false?
                      │                       │
                      ▼                       ▼
                [lib/alby.js]          [BTCPay API]
                  │                          │
                  │ NWC over Nostr           │ HTTP REST
                  ▼                          ▼
              [Alby Hub :8080]         [BTCPay /api/v1/...]
              LDK-based LN node       Internal LND + on-chain
              JIT channels via LSPS2  store wallet
                  │
                  └── make_invoice → BOLT11
                  └── lookup_invoice → settlement
                  └── subscribe(payment_received) → real-time settle notification
```

### 24.2 NWC (Nostr Wallet Connect)

NWC je **decentralizovaný transport** pre wallet RPC cez Nostr relays:
- Kya-hub má **`nostr+walletconnect://`** URI s public key + secret kľúčom
- Komunikuje s Alby Hub cez Nostr relays (`wss://relay.getalby.com`, ...)
- Server vidí kya-hub ako "App connection" v Alby UI, s nastavenými budget/permissions
- **Žiadne otvorené porty na strane Alby Hub** ← veľká bezpečnostná výhoda

### 24.3 Komponenty

| Súbor | Účel |
|-------|------|
| `lib/alby.js` | NWC client wrapper (createInvoice, lookupInvoice, subscriptions) |
| `lib/circuit-breaker.js` | Per-service breaker (`alby`, `btcpay`) |
| `.secrets/alby-nwc.txt` | NWC URI (220 bytes, mode 600) |
| `scripts/test-nwc.js` | Standalone test (env-independent) |
| `server.js:758` | `/api/pay` routing — Alby primary, BTCPay fallback |
| `server.js:628` | `/api/webhook/alby` — opcionálny HMAC webhook (HOLD invoices) |

### 24.4 Critical implementation details

#### Native WebSocket polyfill (Node.js)
`@getalby/sdk` používa WebSocket pre Nostr connections. Node.js nemá natívny
`WebSocket` constructor → polyfill cez `ws` package **MUSÍ byť pred `require('@getalby/sdk')`**:

```js
if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = require('ws');
}
const { NWCClient } = require('@getalby/sdk');
```

#### NWC URI z secrets file (nie z .env)
Z bezpečnostných dôvodov (NWC URI je dlhý + sensitive) je v separátnom súbore:
`/root/kya-hub/.secrets/alby-nwc.txt` (mode 600). Helper `loadNwcUri()` v `lib/alby.js`
preferuje `process.env.ALBY_NWC_URI`, fallback na súbor.

#### NWC permissions required
Pri vytváraní App Connection v Alby Hub UI:
- ✅ `get_info`
- ✅ `get_balance`
- ✅ `make_invoice`
- ✅ `lookup_invoice`
- ✅ `list_transactions`
- ✅ `notifications` (pre real-time payment_received events)
- ❌ NEodporúčame: `pay_invoice` (kya-hub nemá dôvod posielať platby ako Alby)

#### Daily budget cap (defense-in-depth)
Aj keď kya-hub nepotrebuje `pay_invoice`, v Alby UI je dobrý nápad nastaviť
budget cap (napr. 100k SAT/day) — ak by sa NWC URI uniklo, útočník nemôže
vyprázdniť wallet.

### 24.5 /api/pay flow

```javascript
const useAlby = alby.isConfigured() && alby.isConnected() && requestedMethod !== 'btcpay';

if (useAlby && albyBreaker.canCall()) {
    try {
        const inv = await alby.createInvoice({ amountSats: tier.total, description });
        albyBreaker.recordSuccess();
        return res.json({ method: 'alby-lightning', paymentRequest: inv.invoice, ... });
    } catch (err) {
        albyBreaker.recordFailure();
        // fallthrough to BTCPay
    }
}
// fallback: BTCPay LNURL / on-chain
```

### 24.6 Payment confirmation (real-time)

NWC subscription beží v background-e (spustená v `alby.startSubscriptions()` po
úspešnom connect). Pri prijatí platby Alby Hub pošle Nostr event:

```json
{
    "notification_type": "payment_received",
    "notification": {
        "payment_hash": "...",
        "invoice": "lnbc...",
        "amount": 10000000,       // millisats
        "settled_at": 1778671114
    }
}
```

Callback v server.js načíta agenta cez `payment_hash`, vytvorí cert, zaregistruje
v DB. Žiadny polling, žiadny webhook — true real-time.

### 24.7 Testing (verified 2026-05-12)

```
[info] [alby] pripojené
  alias: NWC, network: mainnet
  methods: pay_invoice, make_invoice, lookup_invoice, get_balance, ...
[info] [alby] notifications subscription started
[info] UMBRAXON KYA-Hub ONLINE  alby: connected

# Test 1: standalone scripts/test-nwc.js
✓ getInfo OK (alias=NWC, network=mainnet, 14 methods)
✓ getBalance OK (0 msats — channels not yet active)

# Test 2: direct lib/alby.js API
✓ createInvoice(100 sats) → BOLT11 lnbc1u1p4qxrrr...
✓ lookupInvoice(hash) → state=pending, expires_at=24h

# Test 3: /api/pay through PUBLIC URL (with admin key bypass)
$ curl -X POST https://umbraxon.xyz/api/pay \
    -H "X-Admin-Key: ..." \
    -d '{"amount":10000,"agentName":"test","paymentMethod":"alby_ln"}'

{
  "method": "alby-lightning",
  "invoiceId": "00b5634b...",
  "paymentRequest": "lnbc100u1p4qxry2..." (BOLT11 invoice for 10,000 sats),
  "tier": {"name":"BASIC","grade":"B","total":10000}
}
```

### 24.8 Operator playbook

#### Open inbound liquidity for receiving payments
Alby Hub má vstavanú LSPS2 podporu (JIT channels). Prvá incoming payment automaticky
otvorí channel s vybranou LSP. ALEBO operator môže manuálne:
1. Alby UI → `Channels → Open Channel`
2. Vybrať LSP (Megalith, Olympus, Liquid Lightning, ...)
3. Zaplatiť channel fee (~0.5-2% z incoming liquidity)

#### Skontrolovať NWC connection status
```bash
pm2 logs kya-hub --lines 100 | grep -E "alby|NWC"
# Should show: "[alby] pripojené" with methods list
```

#### Disconnect & reconnect (rare)
```bash
pm2 restart kya-hub --update-env
```

#### NWC URI rotation
1. Alby UI → `App Connections → Revoke kya-hub`
2. Create new connection s rovnakými permissions
3. Save new URI: `echo "nostr+walletconnect://..." > /root/kya-hub/.secrets/alby-nwc.txt`
4. `chmod 600 /root/kya-hub/.secrets/alby-nwc.txt`
5. `pm2 restart kya-hub`

### 24.9 Out-of-scope (Phase 3E+)

- **End-to-end real LN payment test** — vyžaduje aktívne kanály v Alby Hub
  (operator musí najprv otvoriť channel; alebo počkať na prvú JIT incoming).
- **HOLD invoices** (`make_hold_invoice` + `settle_hold_invoice`) — pre dispute escrow.
  Phase 3F (governance feature).
- **LN-to-LN forwarding profit** — netreba pre kya-hub use case.
- **Multi-wallet routing** (Alby + Phoenixd + LND) — over-engineering.

---

## 25. Phase 3 E — Real LN Payment Test (END-TO-END VALIDATED)

**Status:** ✅ COMPLETE — 12. máj 2026, ~14:28 lokál.

Toto je prvá registrácia agenta cez **plne self-custodial Lightning Network kanál**
(Alby Hub LDK node) bez dotyku BTCPay LN. Validuje sa kompletný flow od externého
peňaženkového klienta cez LSP-S2 JIT channel až po finálny podpis Ed25519
certifikátu na našej strane.

### 25.1 Outcome

| Pole | Hodnota |
|------|---------|
| Test runner | `scripts/test-real-ln-payment.js` |
| Agent name | `real-ln-test-6k` |
| Agent ID | `UMBRA-CAD028` |
| Tier | BASIC (10 000 SAT) — cena dočasne stiahnutá na 6 000 SAT len pre test, ihneď revertnutá na 10 000 SAT |
| Payment hash | `e2d7e7573a7a6d67decb4fb1838766b6096da70b27c34c2479ed3934d299f3a2` |
| Amount paid | 6 000 SAT (Lightning, BOLT11) |
| Payer wallet | Binance Lightning (custodial outbound) |
| Cert ID | `urn:kya:cert:CERT-CAD028-001` |
| Cert signature | **VALID** (Ed25519, offline overené proti `HUB_ED25519_PUBKEY_HEX`) |
| `payment_settled_at` | 2026-05-12 12:28:42.735307 UTC |
| End-to-end latency | ~3 sekundy od `payment_received` notifikácie po vystavenie certu |

### 25.2 Flow

```
┌──────────┐     ┌─────────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Binance  │───▶│  MegaLith   │───▶│ Alby Hub │───▶│ KYA-Hub  │───▶│ Certifi- │
│ (outbound)│     │  LSP (LSPS2)│     │ (LDK)    │     │ (NWC sub)│     │ kát ED25519│
└──────────┘     └─────────────┘     └──────────┘     └──────────┘     └──────────┘
    BOLT11           hop                inbound          payment_received
    invoice          forward             channel         Nostr notif
```

1. KYA-Hub `/api/pay?method=alby_ln` → Alby Hub `make_invoice` (NWC).
2. Bot vyplatí BOLT11 cez Binance Lightning → MegaLith ako LSP routuje hop.
3. MegaLith otvorí 0-conf JIT channel s Alby Hub (LSPS2) — capacity 1 M SAT inbound.
4. HTLC settled → Alby Hub posiela `payment_received` notifikáciu cez NWC.
5. KYA-Hub `lib/alby.js` callback nájde agenta podľa `payment_hash`, registruje
   v DB, vystavuje signed cert, odpovie 200 OK.

### 25.3 Channel state (po prvej platbe)

- **Channel funding TX:** `03cd4c52a32693a56a49590a3d3348b060d13a0453aad65df3f5a2907e561af2`
- **Stav:** 0-conf, JIT (LSPS2). Mining fee bola low (~155 sat/vB) → confirm pomalý,
  ale channel je usable hneď.
- **Inbound capacity:** ~1 000 000 SAT (po odpočítaní channel-opening fee).
- **LSP:** [MegaLith](https://megalithic.me).
- **Local balance po teste:** 6 000 SAT inbound spotrebovaných → ~994 000 SAT zostáva.

### 25.4 Lessons learned

1. **5-minútový timeout v `scripts/test-real-ln-payment.js` bol tesný.** User
   musel platiť cez Binance s 2FA flow, čo trvalo ~2 min. Pre operator manuálne
   testy treba expandovať polling window na ≥10 min.
2. **Tier price musí byť kompatibilná s payer minimom.** Binance Lightning má
   minimálnu výplatu ~6 000 SAT, takže BASIC 10 000 SAT mohol fungovať, ale
   menšie sumy by zlyhali na Binance min-spend. Pre menšie testy treba dočasne
   znížiť tier (a vrátiť!).
3. **Settlement bol okamžitý**: hneď ako MegaLith forwardoval HTLC, Alby
   vystrelil `payment_received` event a server vystavil cert v <1 s.
4. **LSP routing bol transparentný** — KYA-Hub nepozná LSP, vidí len incoming
   payment v Alby Hub channeli.
5. **`payment_hash` ako primary key na matching invoice → agent** funguje
   spoľahlivo (`alby.js` callback `findAgentByInvoice()` query je O(1)).
6. **Pricing revert po teste je kritický** — operator dočasne nastavil
   `BASIC=6000`, otestoval, a okamžite revertol na 10 000 SAT (uložené v
   `tier_pricing` history). 

### 25.5 Verification

```bash
# Stiahni live cert
curl -s https://umbraxon.xyz/api/cert/UMBRA-CAD028 | jq .

# Offline overenie podpisu (no DB, no API):
node -e "
  const c = require('./lib/certs');
  const cert = require('./test-cert.json');
  console.log(c.verifyCertSignature(cert));
"
# → { valid: true, reason: 'OK', issuerPubkey: '7b51ce92...', expired: false }
```

### 25.6 Reproducibility

Zmena testovacej registrácie na novom prostredí:

1. Spusti Alby Hub, otvor inbound liquidity cez LSPS2 (alebo manuálne kanál).
2. `node scripts/test-real-ln-payment.js --amount=10000 --name=test-N --timeout=600`.
3. Skript vypíše BOLT11 + QR cez `qrencode` (alebo `.invoice-qr-Nsat.png`).
4. Zaplatiť BOLT11 z externej Lightning peňaženky (Binance/Phoenix/Wallet of Satoshi).
5. Skript pollne `/api/check-status/:invoiceId` každú sekundu, vypíše PASS po
   úspešnom matchi `agent.kya_id` + `cert.serial`.

### 25.7 Production readiness signál

Tento test bol **gateway** pre Phase 4:
- ✅ NWC subscription stable nad PM2 reštartmi (29 reštartov v deň, žiadny lost event).
- ✅ Cert pipeline funguje cez **oba** payment paths (BTCPay onchain v UMBRA-6C459D
  + Alby LN v UMBRA-CAD028).
- ✅ Hot wallet `bc1qlh0warqgyxgl97r8vkswsh7vfcj79gjxhljmjc` má 23 867 SAT
  hotových na onchain anchor experimenty (P4-2).

Po tomto bode sme prešli z payment-rail validation na **trust-anchor layer**
(viď nasledujúca sekcia 26).

---

## 26. Phase 4 — ELITE Production-Ready (✅ implemented 2026-05-12)

Phase 4 mení KYA-Hub z **payment-rail validated** systému (Phase 3E) na
**trust-anchor systém** — ELITE agenti dostanú individuálny `OP_RETURN` anchor
v Bitcoin blockchaine + dedikovaný podpisový kľúč + verejné whitelist API.

### 26.1 Komponenty (5 podčastí)

| ID  | Modul | Stav | Test |
|-----|-------|------|------|
| P4-1 | ELITE Ed25519 signing key (encrypted at rest) | ✅ deployed | `signingRole=ELITE`, sig valid |
| P4-2 | `scripts/anchor-worker.js` PM2 daemon — OP_RETURN broadcast + confirmation poller | ✅ running DRY-RUN | tick observed, 36 B payload generated |
| P4-3 | Cert reissue s `credentialSubject.anchor` po anchored stave | ✅ implemented | new serial, old REVOKED, anchor field validates |
| P4-4 | `/api/whitelist`, `/api/whitelist/elite`, `/api/verify/anchor/:txid` | ✅ live | 28/28 e2e checks pass |
| P4-5 | Webhook delivery tier-priority (`agent_tier`, `priority` columns) | ✅ live | ELITE → priority 9, BASIC → 5 |
| P4-6 | ELITE public listing liveness (paid heartbeat, grace, delist, pay + free redeem) | ✅ live | migrácia `016`, sweep v `decay-worker` |

### 26.2 ELITE signing key architecture (P4-1)

- Generované cez `scripts/gen-hub-keys.js --role ELITE --passphrase …`
- Uložené **encrypted at rest** v `.env`:
  - `HUB_KEY_ELITE_ID=HUB-ELITE-20260512`
  - `HUB_KEY_ELITE_PUBKEY_HEX=20d7ac610aeac04803cc8722bef8bef24244a359340cc726078dbdfe3d44f785`
  - `HUB_KEY_ELITE_CIPHERTEXT=v1.<salt>.<iv>.<tag>.<ct>` (AES-256-GCM, scrypt-derived)
  - `HUB_KEY_PASSPHRASE` — separátne (in-process decrypt at startup, raw wipe-uje)
- DB `hub_keys` row: status `ACTIVE`, role `ELITE`, source `encrypted`
- BASIC kľúč (legacy plaintext) sa **NEDOTKOL** — všetky existujúce BASIC certs
  ostávajú overiteľné rovnakým pubkey-om.
- `certs.signCert(body)` automaticky vyberie kľúč podľa `body.credentialSubject.tier`:
  ELITE → ELITE kľúč, BASIC (alebo fallback) → BASIC kľúč.
- Verifikácia: cudzí cert s `proof.verificationMethod = did:key:ed25519:<elite_pub>`
  sa overí proti DB `hub_keys.pubkey_hex`. DEPRECATED kľúče tiež ostávajú verify-able
  (dual-verify window, default 30 dní).

### 26.3 OP_RETURN anchor worker (P4-2)

**Process name:** `kya-anchor-worker` (PM2). Restart-uje sa nezávisle od `kya-hub`.

**Tick model:**

```
broadcastLoop  (every 60 s)               confirmLoop  (every 10 min)
─────────────                             ─────────────
SELECT pending_anchors                    SELECT pending_anchors
WHERE status IN (PENDING,FAILED,DRY_RUN)  WHERE status = 'BROADCAST'
  AND attempts < max_attempts             
                                          getrawtransaction(txid)
For each row:                             if confirmations >= 1:
  cert_hash = sha256(canonical cert)        UPDATE → ANCHORED
  op_return = "KYA1" || cert_hash           reissue cert (P4-3)
  if DRY_RUN: write audit, mark             Telegram notif
  else: BTCPay create-tx(broadcast=true)
        UPDATE → BROADCAST
        Telegram notif
```

**OP_RETURN payload format (36 bytes, well under 80B limit):**

```
[4 B magic="KYA1" = 0x4B594131] [32 B sha256(canonical_cert_body)]
                                     ↑ unikátny per cert, deterministický
```

**Fee strategy:**
1. `bitcoind estimatesmartfee 6` (default 6-block target = ~1h)
2. fallback → `mempool.space /api/v1/fees/recommended` (economyFee)
3. fallback → `ANCHOR_FALLBACK_FEERATE_SAT_VB` env (default 2 sat/vB)
4. hard cap → `ANCHOR_MAX_FEERATE_SAT_VB` env (default 20 sat/vB) — chráni
   pred fee-spike attackom

**Pri ~36 B OP_RETURN + 1 input + 1 change output (P2WPKH):** tx vsize ≈ 110 vB,
takže pri 2 sat/vB jedna anchor TX stojí ~220 sat. BTCPay hot wallet (23 867
sat z Phase 2.5) zvládne ~100 anchorov pred ďalším sweep-om/topupom.

**Retry / failure modes:**
- BTCPay 4xx/5xx → `attempts++`, `last_error`, `next_attempt_at += 10 min`
- `attempts >= max_attempts` (default 3) → status `FAILED` + Telegram critical
- `503: hot wallet policy not enabled` → každý retry zlyhá → operator action needed
- Idempotency: `UNIQUE(cert_hash) WHERE cert_hash IS NOT NULL` v `pending_anchors`
  → nikdy dva anchor TXs pre rovnaký cert_hash.
- `pg_try_advisory_lock(0x4b594131)` per tick → ochrana proti race ak by sa
  spustili dva workery (treba sa vyhnúť).

**State machine:**

```
PENDING ─────────► BROADCAST ─────► ANCHORED ─────► CERT_REISSUED
   │                  │                              │
   │                  ▼                              ▼
   ▼               (retry on              (P4-3: new cert serial s
DRY_RUN          stuck mempool)            anchor obj v credentialSubject,
   │                  │                    starý cert is_current=FALSE,
   ▼                  ▼                    revoke_reason='reissued_with_anchor')
FAILED ◄─── max_attempts ◄──────────
```

**Bezpečnostné gate (LIVE broadcast):**

LIVE broadcast je za **3 explicit gates**:
1. `ANCHOR_WORKER_BROADCAST_ENABLED=true` v `.env`
2. BTCPay Server policy "Allow non-admins to use hotwallets" enabled (v UI)
3. `pm2 restart kya-anchor-worker --update-env`

Bez všetkých troch worker beží v **DRY_RUN** — generuje payload, audituje, ale
**nikdy nevolá BTCPay create-tx**.

### 26.4 Cert reissue lifecycle (P4-3)

Po `ANCHORED` stavovom prechode (confirm tick alebo `simulate_block_height` cez
admin endpoint), worker spustí `anchor.reissueCertWithAnchor()`:

1. SELECT current cert (`is_current=TRUE`) — to je *originálny* cert, ktorý sa
   kryptograficky zhoduje s on-chain `cert_hash` (lebo OP_RETURN ho fixoval).
2. Skopíruj `cert_body`, doplň `credentialSubject.anchor`:

```json
"anchor": {
  "type": "Bitcoin-OP_RETURN",
  "magic": "KYA1",
  "txid": "abc123...",
  "vout": 0,
  "op_return_hex": "4b594131<32B cert_hash>",
  "cert_hash": "<32B hex>",
  "block_height": 949999,
  "block_hash": "00000...",
  "confirmed_at": "2026-05-12T...",
  "verification_url": "https://mempool.space/tx/abc123..."
}
```

3. Nová `issuanceDate`, `id: urn:kya:cert:<NEW_SERIAL>`, znova podpis (ELITE).
4. Atomická transakcia:
   - INSERT nový cert (`is_current=TRUE`)
   - UPDATE starý → `is_current=FALSE, revoked_at=NOW(), revoke_reason='reissued_with_anchor'`
   - UPDATE agents.cert_serial = nový
   - UPDATE pending_anchors.reissued_cert_serial = nový
   - INSERT anchor_audit `CERT_REISSUED`

5. `/api/cert/:kya_id` automaticky vracia LATEST `is_current=TRUE` cert →
   downstream konzumenti dostanú novú verziu s anchor proofom **bez kódovej zmeny**.

### 26.5 Public whitelist API contract (P4-4)

| Endpoint | Auth | Cache | Vstup | Výstup |
|----------|------|-------|-------|--------|
| `GET /api/whitelist` | public + CORS=* | 60 s in-memory | `?limit=100&offset=0` | `{ epoch, count, total, agents[] }` |
| `GET /api/whitelist/elite` | public + CORS=* | 60 s | `?limit=100&offset=0` | ELITE + `anchor_status='ANCHORED'` + `elite_listing_status='LISTED'` (NULL sa berie ako LISTED) |
| `GET /api/verify/anchor/:txid` | public + CORS=* | 60 s | 64-hex txid | on-chain parse + DB reverse-lookup |

`/api/whitelist` filter: `is_active=TRUE AND status='VERIFIED' AND retired_at IS NULL
AND (tier='BASIC' OR (tier='ELITE' AND anchor_status='ANCHORED'
AND COALESCE(elite_listing_status,'LISTED')='LISTED'))`.

**BASIC** ostáva vo všeobecnom whiteliste bez ohľadu na listing stĺpce. **ELITE** sa z verejného
zoznamu vyfiltruje, ak je `DELISTED` alebo v `GRACE` po sweep-e (certifikát a anchor ostávajú;
ide iba o verejný index / discovery).

`epoch` je ISO week (`2026-W19` formát) — operator/relying-party môže používať
ako "snapshot version" hint pre svoj vlastný cache layer.

`Cache-Control: public, max-age=60` + CORS `*` znamená, že CDN (Cloudflare) sa
môže cachovať priamo. App-level rate limiting nie je potrebný keďže payload je
minimálny (počítané v stovkách KB max).

**Pole `kya_id` v `agents[]`:** formát ostáva `UMBRA-` + presne 6 znakov z množiny hex číslic (validácia `INVALID_KYA_ID` sa nemení). Noví agenti majú typicky **číselne radové** ID (`UMBRA-000123`); starší záznamy môžu mať „náhodnejší“ vzhľad (`UMBRA-CAD028`). Zoradenie v odpovedi závisí od SQL dotazu (nie od numerického poradia v `kya_id`).

`/api/verify/anchor/:txid` výstup:

```json
{
  "txid": "abc...",
  "on_chain": {
    "found": true,
    "source": "bitcoind" | "mempool.space",
    "confirmations": 1,
    "block_height": 949999,
    "op_return": { "vout": 0, "magic": "KYA1", "cert_hash": "<32B>", "raw_hex": "..." },
    "is_kya_anchor": true
  },
  "is_kya_anchor": true,
  "agent": { /* full agent object ako vo /api/whitelist */ } | null,
  "cert": {
    "anchored_cert_serial": "CERT-XXX-001",
    "reissued_cert_serial": "CERT-XXX-002",
    "cert_hash_in_anchor": "<32B>",
    "cert_history": [ {serial, issued_at, valid_until, is_current, revoked_at}, ... ]
  } | null
}
```

### 26.5a ELITE listing — stavy a operácia

| Stav | Význam |
|------|--------|
| `LISTED` | Agent je v `/api/whitelist` a `/api/whitelist/elite` (ak splní aj ostatné podmienky). |
| `GRACE` | Po zmeškaní `next_due_at`; ešte možný heartbeat za `ELITE_LISTING_HEARTBEAT_SATS`. |
| `DELISTED` | Po uplynutí `grace_until`; návrat cez reaktiváciu (`ELITE_LISTING_REACTIVATION_SATS`) alebo raz ročne `redeem-free`. |

- Init / backfill: migrácia `016` + pri novom `ANCHORED` worker `kya-anchor-worker` nastaví listing polia.
- Sweep: `lib/elite-listing.js` `sweep()` volaný z `lib/decay-worker.js` (hodinový tick); pri zmene emit `kya:whitelist-invalidate`.
- Deploy: `pm2 restart kya-hub`; po úprave `scripts/anchor-worker.js` aj `pm2 restart kya-anchor-worker`.

### 26.6 Webhook priority (P4-5)

Nové stĺpce v `webhook_deliveries`:
- `agent_tier` VARCHAR(16) — 'BASIC' | 'ELITE' | NULL
- `priority` SMALLINT default 5 — ELITE → 9, BASIC → 5
- `processing_started_at` TIMESTAMP — pre worker checkout audit

Index `idx_webhook_priority_pending` na `(priority DESC, received_at ASC)
WHERE processed = FALSE` umožňuje admin endpoint:

```
GET /api/admin/webhooks/queue
→ vráti pending webhooks zoradené ELITE-first, FIFO v rámci tieru
```

Inline processing v BTCPay + NWC handleroch ostáva (latencia ~100ms na webhook),
ale ak by sme niekedy preto trebať deferred queue, schema je pripravená.

### 26.7 Admin endpoints

| Endpoint | Účel |
|----------|------|
| `GET /api/admin/anchor/queue` | full queue + worker config + bitcoind status + 24h audit stats |
| `POST /api/admin/anchor/force` | enqueue alebo simulate broadcast/anchor pre testy |
| `GET /api/admin/anchor/audit/:kya_id` | celý forenzný trail pre agenta |
| `GET /api/admin/webhooks/queue` | priority view + ELITE-pending count |

`/api/admin/anchor/force` accept body:
```json
{
  "kya_id": "UMBRA-XXX",
  "simulate_txid": "<64-hex>",        // optional: bypassuje BTCPay
  "simulate_block_height": 949999,    // optional: + simulate_txid → instant ANCHORED + reissue
  "mark_status": "ANCHORED"           // optional alternative trigger
}
```

Bez `simulate_*` → row sa re-queue-uje (`PENDING`, attempts=0, next_attempt_at=NOW)
a worker ho vyzdvihne v ďalšom 60s tick.

### 26.8 Operator playbook

#### Monitor anchor pipeline
```bash
curl -sH "X-Admin-Key: $ADMIN_KEY" https://umbraxon.xyz/api/admin/anchor/queue | jq .
pm2 logs kya-anchor-worker --lines 50
```

#### Aktivovať LIVE broadcast (prvý anchor je nezvratný!)
```bash
# 1) UI: BTCPay → Server Settings → Policies → "Allow non-admins to use hotwallets" = ON
# 2) Otestuj manuálne (no broadcast):
curl -sH "X-Admin-Key: $ADMIN_KEY" -X POST \
    -H 'content-type: application/json' \
    -d '{"kya_id":"UMBRA-XXXXXX"}' \
    https://umbraxon.xyz/api/admin/anchor/force
# 3) Worker tick log by mal ukázať DRY_RUN — would broadcast OP_RETURN s payloadom
# 4) Flip switch:
sed -i 's/^ANCHOR_WORKER_BROADCAST_ENABLED=false/ANCHOR_WORKER_BROADCAST_ENABLED=true/' /root/kya-hub/.env
pm2 restart kya-anchor-worker --update-env
# 5) Watch:
pm2 logs kya-anchor-worker --lines 100 -f
```

#### Force-anchor manuálne pre konkrétny kya_id
```bash
curl -sH "X-Admin-Key: $ADMIN_KEY" -X POST \
    -H 'content-type: application/json' \
    -d '{"kya_id":"UMBRA-XXXXXX"}' \
    https://umbraxon.xyz/api/admin/anchor/force
```

#### Skontrolovať on-chain anchor po confirmácii
```bash
TXID=$(psql -c "SELECT bitcoin_txid FROM pending_anchors WHERE id=N" -t)
curl -s https://umbraxon.xyz/api/verify/anchor/$TXID | jq .
# alebo
mempool.space/tx/$TXID
```

#### Debug FAILED anchor
```bash
psql -c "SELECT id, status, attempts, last_error FROM pending_anchors WHERE status='FAILED'"
curl -sH "X-Admin-Key: $ADMIN_KEY" https://umbraxon.xyz/api/admin/anchor/audit/UMBRA-XXX | jq .
```

#### Reset retry counter ak operator chce skúsiť znova
```sql
UPDATE pending_anchors SET status='PENDING', attempts=0, last_error=NULL, next_attempt_at=NOW()
WHERE id = N AND status = 'FAILED';
```

### 26.9 Schema changes (migration 008)

`migrations/008_phase4_anchor_and_priority.sql` pridáva:

- `pending_anchors`: `cert_serial`, `cert_hash`, `op_return_hex`, `block_height`,
  `block_hash`, `max_attempts`, `next_attempt_at`, `payload_format`,
  `reissued_cert_serial`
- `agents`: `anchor_block_height`, `anchor_confirmed_at`
- `webhook_deliveries`: `agent_tier`, `priority`, `processing_started_at`
- nová tabuľka `anchor_audit` (forenzný log, NEVER deleted)

GRANTs pre `kyahub_app`: SELECT/INSERT/UPDATE na `anchor_audit` + USAGE/SELECT
na sequence.

### 26.10 Files touched

| Path | Zmena |
|------|-------|
| `migrations/008_phase4_anchor_and_priority.sql` | nová |
| `scripts/gen-hub-keys.js` | (žiadna — len volaný) |
| `scripts/anchor-worker.js` | nový (PM2 daemon) |
| `scripts/test-phase4.js` | nový (28-check e2e suite) |
| `lib/anchor.js` | nový (sdkadiel anchor lib pre worker + endpoints + test) |
| `lib/bitcoind-rpc.js` | nový (cookie-auth RPC klient pre bitcoind) |
| `lib/certs.js` | (žiadna — ELITE selection bola implementovaná v 2.3) |
| `server.js` | + 4 admin + 3 public endpointy, +`agent_tier` v `recordWebhookDelivery` |
| `ecosystem.config.js` | + `kya-anchor-worker` proces |
| `.env` | + ELITE kľúč (encrypted) + 12 anchor worker / bitcoind RPC premenných |
| `UMBRAXON.md` | + Section 25 (Phase 3E retrospective) + Section 26 (Phase 4) |

### 26.11 Test results (2026-05-12)

`scripts/test-phase4.js` 28/28 PASS:

```
✓ PRE_status_ok                status=ok
✓ PRE_elite_key_loaded         ELITE key present in /api/hub/pubkey
✓ S1_create_elite_agent        kya_id=UMBRA-04DD56 agent_id=446
✓ S2_issue_initial_elite_cert  serial=CERT-04DD56-001 signingRole=ELITE
✓ S2_initial_cert_sig_valid    reason=OK
✓ S3_force_anchor_simulate     txid=85be7890ee4f... reissued=CERT-04DD56-002
✓ S4_fetch_reissued_cert       serial=CERT-04DD56-002
✓ S4_cert_signature_valid      reason=OK pubkey=20d7ac610aea...
✓ S4_signingRole_is_ELITE      signingRole=ELITE
✓ S4_anchor_field_present      txid=85be7890ee4f... magic=KYA1
✓ S4_anchor_txid_matches       expected=85be7890ee4f...
✓ S4_anchor_cert_hash_matches_initial expected=91a953e8bf57...
✓ S4_anchor_block_height       block_height=949999
✓ S4_op_return_payload_valid   bytes=36 (expected 36)
✓ S5_old_cert_revoked          is_current=false reason=reissued_with_anchor
✓ S6_whitelist_elite_contains_agent count=1
✓ S6_whitelist_elite_anchor_txid_match txid=85be7890ee4f...
✓ S7_whitelist_contains_agent  count=10
✓ S8_verify_anchor_endpoint_ok status=200
✓ S8_verify_anchor_reverse_lookup agent=UMBRA-04DD56
✓ S8_verify_anchor_cert_hash_present cert_hash=91a953e8bf57...
✓ S8_verify_anchor_on_chain_field_present on_chain.found=false
✓ S9_audit_has_FORCED_BY_ADMIN events=FORCED_BY_ADMIN,CERT_REISSUED
✓ S9_audit_has_CERT_REISSUED   count=2
✓ S10_pending_anchor_ANCHORED  status=ANCHORED txid=85be7890ee4f...
✓ S10_pending_anchor_reissue_serial_set reissued=CERT-04DD56-002
✓ S11_webhook_tier_priority    agent_tier=ELITE priority=9
✓ S12_admin_webhook_queue_ok   count=200
```

Plus jeden **real-world DRY_RUN tick** observovaný proti `UMBRA-CAD028`:

```
broadcast tick: processing batch  count=1 mode=DRY_RUN
DRY_RUN — would broadcast OP_RETURN
  pa=32 kya=UMBRA-CAD028 attempt=1
  certHash=0255b96500f21fa363e7ec1414fb203e8e132dc3396a572a3cbcd6e0b090becc
  op_return_bytes=36
```

OP_RETURN payload v DB: `4b594131` (KYA1) + cert_hash → exact 36 bytes. ✅

### 26.12 First LIVE anchor — BTCPay 2.3.9 OP_RETURN bug & bitcoind workaround (2026-05-12)

**Status:** ✅ Two real mainnet anchors broadcast and confirmed in block **949,085**.

#### Discovery

First LIVE attempt against BTCPay 2.3.9 via `/api/v1/stores/.../payment-methods/onchain/BTC/wallet/transactions`
failed empirically across **4 input formats**:

| Format | HTTP | OP_RETURN in returned tx? |
|---|---|---|
| `destination: "OP_RETURN:<hex>"` | 422 | n/a (rejected: "Destination must be BIP21 or address") |
| `destination: "bitcoin:?op_return=<hex>"` | 422 | n/a (rejected: "BIP21 destination missing bitcoin address") |
| `destination: "bitcoin:<addr>?op_return=<hex>&amount=0.00000546"` | 200 | ❌ **silently stripped** |
| `destinations[0].opReturn: "<hex>"` (alongside destination+amount) | 200 | ❌ **silently stripped** |

Root cause: BTCPay added OP_RETURN support only in **2.4.0+**. BTCPay 2.3.9 happily
accepts the request, returns a valid signed raw tx, but with **no `6a` opcode in any
output**. The original `lib/anchor.js` (`btcpayBuildAndOptionallyBroadcast` with
`destination: "OP_RETURN:<hex>"`) was hitting case (1) above → HTTP 422 hard fail,
which is why `pa_id 33` ended in `FAILED` state with attempts=1.

#### Chosen workaround — Option B (bitcoind direct RPC)

Switched the broadcast backend from BTCPay → bitcoind hot wallet (`kya-anchor`).
Pipeline now:

```
buildOpReturnPayload(cert) → opReturnHex (KYA1 + sha256(cert))
  → bitcoind walletCall("kya-anchor", "createrawtransaction", [[], [{data: opReturnHex}]])
  → bitcoind walletCall("kya-anchor", "fundrawtransaction", [hex, {fee_rate: feerateSatVb, replaceable: true}])
  → bitcoind walletCall("kya-anchor", "signrawtransactionwithwallet", [hex])
  → bitcoind call("decoderawtransaction", [signed.hex])  -- assert 6a present
  → bitcoind walletCall("kya-anchor", "sendrawtransaction", [signed.hex])
```

`fundrawtransaction` automatically picks UTXOs and appends a change output.
Back-to-back anchors work because bitcoind allows spending its own unconfirmed
change immediately (the 2nd tx's input = 1st tx's vout 1).

#### Bootstrap (one-time)

```
docker exec btcpayserver_bitcoind bitcoin-cli -datadir=/data -rpcport=43782 createwallet kya-anchor false false "" false true true
docker exec btcpayserver_bitcoind bitcoin-cli -datadir=/data -rpcport=43782 -rpcwallet=kya-anchor getnewaddress kya-anchor-bootstrap bech32
# → bc1qd77z0klvtawsp8hrag7q7dcgzx0gfy9wul9k47
```

Then funded via a normal BTCPay send (`destinations[0].destination=<bech32>`, `amount=0.00008000`, `proceedWithBroadcast=true` — BTCPay handles plain sends fine, just not OP_RETURN). Bootstrap tx: **`e0158c7b77a4859316ffe1eb0e662ca39ff6ceaff50284675135fa158ce4871b`**.

#### Code changes

- **`lib/bitcoind-rpc.js`** — added `walletCall(walletName, method, params)` that
  routes RPC calls to `/wallet/<name>` URL path (required for wallet-scoped
  methods like fundrawtransaction).
- **`lib/anchor.js`** — added:
  - `bitcoindBuildAndOptionallyBroadcast({opReturnHex, feerateSatVb, broadcast})`
    — implements the Option-B pipeline above, with structural assertions on the
    built tx (must have `6a` opcode + matching payload in some vout).
  - `buildAndOptionallyBroadcast({...})` — unified dispatcher that selects
    backend via `ANCHOR_FUNDING_BACKEND` env (`'bitcoind'` default, `'btcpay'`
    legacy/broken on 2.3.x).
  - `getAnchorBackend()` / `getAnchorWalletStatus()` — diagnostics.
  - `parseOpReturnHex(hex)` — unambiguous OP_RETURN payload extractor from the
    scriptPubKey hex (handles all push opcodes: 0x01–0x4b direct push, 0x4c
    OP_PUSHDATA1, 0x4d OP_PUSHDATA2, 0x4e OP_PUSHDATA4).
  - `parseOpReturnAsm()` — generalized to also accept modern format
    `OP_RETURN OP_PUSHBYTES_36 <hex>` (mempool.space + bitcoind ≥0.21 emit this).
  - `getTxStatus(txid)` — new 3-tier resolution: wallet `gettransaction` →
    `getrawtransaction` (mempool-only without -txindex) → mempool.space REST.
    Fixes a confirm-poll dead end where bitcoind without `-txindex` cannot find
    txs that already left the mempool.
  - `verifyAnchorOnChain(txid)` — same 3-tier resolution + hex-first OP_RETURN
    extraction.
- **`scripts/anchor-worker.js`** — `processOne` now calls
  `anchor.buildAndOptionallyBroadcast(...)`; startup banner reports
  `getAnchorBackend()` + wallet status (balance/UTXOs).
- **`scripts/test-anchor-bitcoind.js`** (new) — DRY_RUN smoke test that builds +
  signs an OP_RETURN tx without broadcasting, decodes it, and asserts the
  presence of the `6a` opcode, KYA1 magic, and expected cert_hash. Safe to run
  before flipping `ANCHOR_WORKER_BROADCAST_ENABLED`.
- **`.env`** — added:
  - `ANCHOR_FUNDING_BACKEND=bitcoind`
  - `BITCOIND_ANCHOR_WALLET=kya-anchor`
  - `BITCOIND_ANCHOR_ADDRESS=bc1qd77z0klvtawsp8hrag7q7dcgzx0gfy9wul9k47`
  - flipped `ANCHOR_WORKER_BROADCAST_ENABLED=true`.

#### Historical results (this incident)

Block height at time of broadcast: **949,085** (mempool tip 949,076 → mined in 9 blocks).

| pa_id | KYA ID | TXID | block | fee | reissued cert |
|---|---|---|---|---|---|
| 33 | UMBRA-6C459D (GENESIS) | `3813827b0e3fb70b87fc730b1eaaf71fb115dc5b43881c74a9df31ef68ce90e8` | 949,085 | 314 sat | CERT-6C459D-002 |
| 34 | UMBRA-CAD028 (LN agent) | `5f711801799418b0238897581c295bc00bbe2296b170295eb5398bd9e2a7c828` | 949,085 | 314 sat | CERT-CAD028-002 |

Tx 2's input is tx 1's vout 1 (unconfirmed change), demonstrating bitcoind's
own-unconfirmed-change spending works for chained anchors within the same tick.

Verification URLs:
- https://mempool.space/tx/3813827b0e3fb70b87fc730b1eaaf71fb115dc5b43881c74a9df31ef68ce90e8
- https://mempool.space/tx/5f711801799418b0238897581c295bc00bbe2296b170295eb5398bd9e2a7c828

#### Wallet balances (after this incident)

| Wallet | Before | After | Delta |
|---|---|---|---|
| BTCPay (BTC store hot) | 23,867 sat | 15,585 sat | −8,282 sat (1× bootstrap to bitcoind) |
| bitcoind `kya-anchor`  | 0 sat      | 7,372 sat  | +8,000 received, −628 sat fees (2× anchor) |
| **Total system** | **23,867** | **22,957** | **−910 sat (all paid as miner fees)** |

Under the 15,000 sat cap stipulated for this operation.

#### Future-proofing

- **BTCPay backend** is kept (`ANCHOR_FUNDING_BACKEND=btcpay`) as a switchable
  option. Once BTCPay is upgraded to ≥2.4 (which has native OP_RETURN support),
  flip the env var if we ever want to consolidate wallets. Currently no reason
  to upgrade — bitcoind direct works, is faster, and we get full control over
  OP_RETURN bytes.
- **Recommended:** add `txindex=1` to bitcoind config on next maintenance
  window. Until then, the new `getTxStatus` fallbacks (wallet `gettransaction`
  + mempool.space) cover the gap.
- **Recommended:** add periodic top-up monitor — when `kya-anchor` wallet
  balance drops below ~3,000 sat, alert operator to refill from BTCPay so the
  worker doesn't fail with "Insufficient funds" mid-batch.
  → **Implemented 2026-05-12 (Production Hardening Sprint, Step 1)** — see
  *26.12.1 Top-up monitor (anchor-wallet-monitor.js)* below.

### 26.12.1 Top-up monitor (anchor-wallet-monitor.js)

**Goal:** detect a draining `kya-anchor` wallet and, in the worst case, flip
the OP_RETURN anchor worker into DRY_RUN automatically so that we never get a
chain of `sendrawtransaction → "Insufficient funds"` failures while the
operator is asleep.

**File:** `scripts/anchor-wallet-monitor.js`
**Schedule:** PM2 process `kya-anchor-wallet-monitor`, `cron_restart: '*/30 * * * *'`
(30 min single-shot).

**Thresholds (env-tunable):**

| Env var | Default | Meaning |
|---|---|---|
| `ANCHOR_WALLET_WARN_SATS`      | `3000` | Telegram warning (dedupe `anchor_wallet_low`) |
| `ANCHOR_WALLET_CRITICAL_SATS`  | `1000` | Telegram critical (dedupe `anchor_wallet_critical`) |
| `ANCHOR_WALLET_AUTOPAUSE_SATS` | `500`  | AUTO-PAUSE worker → DRY_RUN |
| `ANCHOR_WALLET_AUTOPAUSE_ENABLED` | (unset, = true) | Set to `false` to disable autopause |
| `ANCHOR_WALLET_MONITOR_INTERVAL_MS` | `1800000` | Used only in `--watch` mode |

**Flow on autopause:**

1. Rewrites `.env`: `ANCHOR_WORKER_BROADCAST_ENABLED=true` → `=false`
   (backs up old `.env` to `.env.autopause-<iso-ts>`, re-chmods to 600).
2. Calls `pm2 restart kya-anchor-worker --update-env` so the worker re-reads
   the new env value and drops back to DRY_RUN immediately.
3. Sends critical Telegram alert with dedupe key `anchor_wallet_autopaused`.

**Auto-pause is one-way.** The monitor never re-enables LIVE broadcast. After
top-up, operator MUST:

```
# 1. Verify new balance ≥ 15,000 sat (5× warn threshold = ~30 anchors of headroom)
docker exec btcpayserver_bitcoind bitcoin-cli -datadir=/data -rpcport=43782 -rpcwallet=kya-anchor getbalance

# 2. Flip env back to LIVE
sed -i 's/^ANCHOR_WORKER_BROADCAST_ENABLED=false$/ANCHOR_WORKER_BROADCAST_ENABLED=true/' /root/kya-hub/.env

# 3. Re-load worker with new env
pm2 restart kya-anchor-worker --update-env

# 4. Confirm it's LIVE again
pm2 logs kya-anchor-worker --lines 20 --nostream | grep -i 'broadcast_enabled'
```

**Operator top-up procedure (manual; from BTCPay hot wallet → bitcoind kya-anchor):**

```
# 1. Get a fresh receive address from kya-anchor
docker exec btcpayserver_bitcoind bitcoin-cli -datadir=/data -rpcport=43782 \
    -rpcwallet=kya-anchor getnewaddress topup-$(date +%Y%m%d) bech32

# 2. Send from BTCPay store hot wallet (UI: Wallets → BTC → Send → Standard, NO OP_RETURN)
#    Amount: 8,000 sat = ~25 anchors at current feerates.
#    DO NOT use OP_RETURN here — BTCPay 2.3.9 silently strips it; a plain send works fine.

# 3. Wait 1 confirmation (~10 min). Watch:
docker exec btcpayserver_bitcoind bitcoin-cli -datadir=/data -rpcport=43782 \
    -rpcwallet=kya-anchor listunspent

# 4. Verify monitor sees the new balance:
cd /root/kya-hub && node scripts/anchor-wallet-monitor.js --dry-run

# 5. If autopause had fired, follow the "Auto-pause is one-way" recovery above.
```

**Single-shot test (without alerts):**

```
cd /root/kya-hub && node scripts/anchor-wallet-monitor.js --dry-run
# Exit codes: 0=OK/warn-sent, 2=critical-sent, 3=autopause-fired, 1=internal-error
```

**Manual force-test (simulate critical):**

```
# Drop threshold artificially without actually moving funds:
ANCHOR_WALLET_CRITICAL_SATS=99999 node scripts/anchor-wallet-monitor.js
# (will fire critical Telegram with dedupe; subsequent runs will dedupe for 5 min)
```

---

## 27. Phase 5 — Revocation Transparency Log (✅ implemented 2026-05-12, DRY_RUN pending user GO for first broadcast)

### 27.1 Problem statement

Pre-Phase-5 stav: cert revocation = `UPDATE certificates SET revoked_at=NOW()`.
DB-only, žiadny on-chain dôkaz. Operator (alebo ktokoľvek s DB-write) môže
ticho "un-revoke" cert; relying party nemá ako overiť, či cert bol skutočne
revokovaný v minulosti. Pre-existing certs s `revoked_at` set sa dali
"obnoviť" zmenou stĺpca na NULL — auditovateľné iba cez audit log, ktorý je
v rovnakej DB.

Phase 5 cieľ: **každé revocation event je tamper-evident, batched do Merkle
tree-u raz za deň a anchorované na Bitcoin chain cez OP_RETURN s magickou
značkou "KYAR".** Relying party môže overiť offline (signed JSON CRL súbor)
aj on-chain (KYAR txid → 32 B Merkle root → fold proof from `revocation_hash`).

### 27.2 Components

| Komponent | Súbor | Účel |
|---|---|---|
| Migration | `migrations/009_phase5_crl_transparency.sql` | 3 tabuľky + backfill historických revocations |
| Merkle/CRL lib | `lib/crl.js` | tree build, proof, leaf hash, OP_RETURN payload, CRL JSON sign/verify, `recordRevocation()` helper |
| Daemon | `scripts/crl-worker.js` | 24h `anchorEpoch` + 10min `confirmTick` loops |
| API | `server.js` `/api/crl*` + `/crl/*` static | public read + admin force |
| Hooks | `lib/reputation-engine.js`, `lib/retire-service.js`, `lib/anchor.js`, admin reissue in `server.js` | každý revoke insertuje do `revocation_events` |
| Test | `scripts/test-phase5.js` | 43-assertion E2E (unit + DB + worker + API) |

### 27.3 Schema (migration 009)

#### `revocation_events`

Append-only ledger, one row per cert revocation. Backfill at migration time
synthesized rows for the 3 already-revoked certs (CERT-6C459D-001,
CERT-8A260C-001, CERT-CAD028-001).

| Column | Notes |
|---|---|
| `id BIGSERIAL` | PK |
| `cert_serial` | the revoked cert |
| `kya_id`, `agent_id` | for lookup |
| `revoked_at TIMESTAMP` | actual revoke time (matches certificates.revoked_at) |
| `revoked_by` | enum: `system / admin / owner / gdpr_purge / anchor-worker / retire-service / reputation-engine` |
| `revocation_reason TEXT` | LEFT(.., 500) — same trimming as backfill |
| `revocation_category` | enum: `SUSPENDED_ZONE / VOLUNTARY_RETIRE / GDPR_PURGE / REISSUED / ADMIN_REVOKE / OTHER` |
| `revocation_hash` | sha256(`${cert_serial}|${kya_id}|${iso-ms-utc}|${reason-≤500}`) — leaf for Merkle |
| `crl_anchor_id` | FK to `crl_anchors.id` once batched |
| `merkle_leaf_index` | 0-based position in anchored tree |
| `merkle_proof JSONB` | inclusion proof from this leaf to root |

Partial unique index `(cert_serial)` WHERE `crl_anchor_id IS NULL` — at most
one un-anchored revocation event per cert at a time.

#### `crl_anchors`

One row per daily anchor epoch.

| Column | Notes |
|---|---|
| `epoch_id INTEGER` | unix-day (UTC); used as `WHERE` key |
| `epoch_label` | e.g. `CRL-2026-05-12` |
| `merkle_root` | 32 B hex of Merkle root |
| `leaf_count` | number of revocations bundled |
| `op_return_hex` | full 36 B (4B KYAR magic + 32 B root) |
| `status` | `PENDING / DRY_RUN / BROADCAST / ANCHORED / FAILED` |
| `bitcoin_txid`, `fee_sats`, `block_height` | filled by worker |
| `tree_snapshot JSONB` | full Merkle levels for offline reproducibility |
| `crl_signature_hex`, `crl_signed_by_role`, `crl_signed_by_pubkey` | ROOT-key signature of daily CRL JSON |

Unique index `(epoch_id)` — at most one anchor per UTC day. Worker is
idempotent: re-running for same epoch returns `epoch_exists` and short-circuits.

#### `crl_signed_files`

Index of generated daily JSON files served from `/root/kya-hub/public/crl/`
(nginx + Express static). One row per epoch with `file_sha256`, signed-by
metadata, count.

### 27.4 Canonical leaf hash (locked formula)

```
revocation_hash = sha256(`${cert_serial}|${kya_id}|${revoked_at_iso_ms_z}|${revocation_reason_≤500}`)
```

- `revoked_at_iso_ms_z` matches both:
  - Postgres `TO_CHAR(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
  - JavaScript `new Date(revoked_at).toISOString()`
- `revocation_reason` is `LEFT(., 500)`, `COALESCE('')` — empty string when null.

This identical formula is shared between (a) the SQL backfill in migration
009, (b) `lib/crl.js computeRevocationHash`, and (c) the verifier recipe
embedded in the API responses, so historical and live leaves are
interchangeable.

### 27.5 Merkle tree construction (Bitcoin-style)

- Each leaf already pre-hashed (no extra wrapping).
- Odd levels: last element duplicated (Bitcoin convention).
- Empty tree: root = `sha256("KYAR_EMPTY_CRL")` sentinel (kept as a fallback
  option; default worker behaviour is to skip epochs with 0 new revocations).
- Single leaf: root = leaf hash, proof = empty array.
- Proof step: `{ pos: 'left' | 'right', hash: hex }` — sibling's position
  relative to running value.
- Verifier fold:
  ```
  running = leafHash
  for step in proof:
      running = step.pos === 'left'
          ? sha256(step.hash || running)
          : sha256(running || step.hash)
  return running === expectedRoot
  ```

### 27.6 OP_RETURN payload (KYAR magic)

```
+--------+------------------+----------------------------------+
| 4 B    | 4B KYAR magic    | 0x4B 0x59 0x41 0x52              |
| 32 B   | sha256 Merkle    | leaves[*].revocation_hash → root |
+--------+------------------+----------------------------------+
Total: 36 B (same envelope size as KYA1)
```

Decoded with the same `parseOpReturnHex`-style logic as KYA1 (handles all
push opcodes 0x01-0x4b, 0x4c/0x4d).

### 27.7 Daily cadence

- `anchorEpoch` ticks every 24 h (`CRL_WORKER_INTERVAL_MS=86400000`).
- Epoch ID = unix-day (UTC) = `floor(now_ms / 1000 / 86400)`.
- On startup the worker does ONE immediate tick (catch-up after restart),
  then sleeps.
- If no new un-anchored revocations → epoch is skipped entirely (no OP_RETURN
  fee burn, no DB row).
- Per-anchor cost: ~140–500 sat (single OP_RETURN at economy feerate). At
  daily cadence: ~6k-15k sat/month — within budget.

### 27.8 API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/crl` | paginated revocations (filterable by `kya_id`, `cert_serial`) |
| GET | `/api/crl/proof/:cert_serial` | proof + verifier_recipe for one cert |
| GET | `/api/crl/epoch/:epoch_id` | one epoch (tree snapshot + all revocations) |
| GET | `/api/crl/anchors` | paginated anchor list (audit) |
| GET | `/crl/<epoch_label>.json` | static signed CRL JSON file (offline cache) |
| GET | `/crl/latest.json` | symlink to newest epoch's JSON |
| POST | `/api/admin/crl/anchor-now` | admin force; `{broadcast:true}` requires `CRL_WORKER_BROADCAST_ENABLED=true` |

All public endpoints emit `Access-Control-Allow-Origin: *` and short
`Cache-Control: public, max-age=60`.

### 27.9 ROOT key for CRL JSON signing

- Generated 2026-05-12 via `node scripts/gen-hub-keys.js --role ROOT --yes`.
- Key ID: `HUB-ROOT-20260512`
- Pubkey: `d280308f1b9abd439418942a34c142ebcefa4245322680b67ca887b96e769527`
- Encrypted privkey in `.env` (`HUB_KEY_ROOT_CIPHERTEXT`, AES-256-GCM,
  scrypt-derived from `HUB_KEY_PASSPHRASE`).
- **Currently online** (decrypted into memory on start). Future hardening:
  move ROOT priv to HSM or sign CRL JSON offline + ingest signature.
- `lib/crl.signCrlBody` defaults to `role: 'ROOT'`. Falls back to ELITE →
  BASIC if ROOT unavailable (with warning).

### 27.10 Hooks (where revocation_events get inserted)

| Site | Category | Revoked_by |
|---|---|---|
| `lib/reputation-engine.applyEvent` SUSPENDED zone branch | `SUSPENDED_ZONE` | `reputation-engine` |
| `lib/retire-service.voluntaryRetire` | `VOLUNTARY_RETIRE` | `owner` |
| `lib/retire-service.adminPurge` (GDPR purge branch) | `GDPR_PURGE` | `gdpr_purge` |
| `lib/anchor.reissueCertWithAnchor` (after anchor confirmation) | `REISSUED` | `anchor-worker` |
| `server.js POST /api/admin/agent/:kya_id/reissue-cert` | `REISSUED` | `admin` |

All call sites wrap the insert in `try/catch` so a CRL-ledger failure NEVER
breaks the original revoke operation.

### 27.11 Worker gate (same model as Phase 4)

LIVE OP_RETURN broadcast requires:

```
CRL_WORKER_BROADCAST_ENABLED=true   # in .env
pm2 restart kya-crl-worker --update-env
```

Default is unset → DRY_RUN mode (no broadcast). Admin endpoint
`/api/admin/crl/anchor-now {broadcast:true}` also requires this env flag
(defense in depth).

⚠️ **Before broadcasting the first KYAR anchor**, operator MUST:

1. Verify anchor wallet has ≥1,000 sat (`node scripts/anchor-wallet-monitor.js --dry-run`).
2. Run DRY_RUN through worker: `node scripts/crl-worker.js --once --dry-run`.
3. Spot-check generated `/crl/crl-YYYY-MM-DD.json` (signature + proofs verify offline).
4. Flip `CRL_WORKER_BROADCAST_ENABLED=true` in `.env`.
5. `pm2 restart kya-crl-worker --update-env`.
6. Confirm first broadcast lands and reaches ANCHORED status (~1-12h depending on feerate).

### 27.12 Files added / modified

**Added:**

- `migrations/009_phase5_crl_transparency.sql` — schema + backfill
- `lib/crl.js` — Merkle + CRL primitives
- `scripts/crl-worker.js` — PM2 daemon
- `scripts/test-phase5.js` — 43-assertion E2E
- `public/crl/` directory (static-served)

**Modified:**

- `server.js` — `/api/crl*` endpoints, `/crl/*` static, admin force, hook in reissue
- `lib/reputation-engine.js` — record SUSPENDED revocations
- `lib/retire-service.js` — record voluntary + GDPR revocations
- `lib/anchor.js` — record reissue-with-anchor revocations
- `ecosystem.config.js` — `kya-crl-worker` PM2 app
- `.env` — added `HUB_KEY_ROOT_*` (ROOT key)

### 27.13 Test results

```
$ node scripts/test-phase5.js
=== 1. lib/crl unit tests ===           19/19 passed
=== 2. DB backfill + hash consistency === 2/2  passed
=== 3. CRL worker --once --dry-run ===  10/10 passed
=== 4. API endpoints ===                12/12 passed
SUMMARY: 43 passed, 0 failed
```

DRY_RUN epoch built and signed JSON file at `/crl/crl-2026-05-12.json`
(3 historical revocations, ROOT-signed, Merkle root
`cec0ef51f356d862…b371fecd`).

**Waiting for user GO before first LIVE KYAR broadcast.**

---

## 28. Phase 4B — Manufacturer Onboarding API (✅ implemented 2026-05-12)

DB-backed registry of trusted AI agent manufacturers. Replaces the static
`TRUSTED_MANUFACTURERS` env-var list (which is kept as a fallback for
backward compat). Manufacturers cryptographically pre-attest each agent they
ship; matching agents inherit `manufacturer_verified = true` + a per-tier
reputation bonus on registration.

Full operator + integrator guide: [`docs/MANUFACTURER-ONBOARDING.md`](docs/MANUFACTURER-ONBOARDING.md).

### 28.1 Schema (migration 010)

- `manufacturers` — one row per registered mfr. Status enum:
  `PENDING → VERIFIED → SUSPENDED / REVOKED`. Tier enum: `BRONZE / SILVER /
  GOLD` with default rep bonus +25 / +50 / +100 (env-tunable
  `MFR_BONUS_*`). Pubkey is 32B Ed25519 hex, unique. Counters
  `attestation_count`, `agent_count` maintained by app code.
- `manufacturer_attestations` — one row per signed pre-attestation. Unique
  on `(manufacturer_id, agent_manifest_hash)`. Lifecycle fields:
  `attested_at`, `expires_at`, `agent_id` (one-shot consume on agent
  registration), `consumed_at`, `revoked_at` / `revoked_by` /
  `revoke_reason`. Optional pins `expected_agent_pubkey` /
  `expected_agent_name` lock the attestation to a specific bot.
- `registration_intents` + `agents` extended with `mfr_attestation_id`
  (forensic FK) and `mfr_tier`.
- GRANTs: SELECT/INSERT/UPDATE for `kyahub_app`. Hard DELETE is
  intentionally **not** granted (production uses soft-delete via
  `revoked_at` / `status=REVOKED`).

### 28.2 Signature scheme

```
manifest_hash    = sha256( key-sorted, whitespace-free JSON canonicalisation )
mfr_signature    = Ed25519( sk_mfr, manifest_hash_bytes )    # 64B / 128 hex
```

The mfr signs the **raw 32 bytes** of `manifest_hash`, not the hex string.
KYA-Hub verifies via `hubkeys.verify()` against the registered
`pubkey_ed25519`. The mfr keypair is generated **off-system** and KYA-Hub
never sees the private key.

### 28.3 API surface

Public:
- `GET  /api/manufacturers?limit=&offset=`
- `GET  /api/manufacturer/:manufacturer_id`
- `POST /api/manufacturer/attestation`

Admin (`X-Admin-Key`):
- `POST /api/admin/manufacturer/register`
- `POST /api/admin/manufacturer/:manufacturer_id/verify`
- `POST /api/admin/manufacturer/:manufacturer_id/suspend`
- `POST /api/admin/manufacturer/:manufacturer_id/revoke`
- `POST /api/admin/manufacturer/attestation/:id/revoke`
- `GET  /api/admin/manufacturer/:manufacturer_id/attestations`

Rate limit: `RATE_MFR_ATTEST_PER_MIN` (default 20/min/IP, admin bypass).

### 28.4 Registration consumption path

`server.js /api/register/initiate` now consults
`manufacturer.findUsableAttestation()` first, falling back to the legacy
env-based `verifyManufacturerAttestation()` only if no usable DB row is
found. When matched, the registration intent stores
`mfr_attestation_id` + `mfr_tier`; on payment settle, the agent INSERT
includes those columns and `manufacturer.markAttestationConsumed()` links
the attestation row to the new `agents.id` (one-shot — re-registration of
the same manifest is a no-op).

### 28.5 Test harness

```
$ node scripts/test-manufacturer-flow.js
=== 1. self-test signature ===                  1/1   passed
=== 2. admin register ===                       6/6   passed
=== 3. public lookup (PENDING) ===              3/3   passed
=== 4. admin verify ===                         2/2   passed
=== 5. public visibility ===                    4/4   passed
=== 6. attestation submit happy path ===        3/3   passed
=== 7. idempotent replay ===                    2/2   passed
=== 8. tampered signature ===                   2/2   passed
=== 9. DB sanity ===                            5/5   passed
=== 10. findUsableAttestation in-process ===    3/3   passed
=== 11. suspend / re-verify ===                 5/5   passed
=== 12. attestation revoke ===                  2/2   passed
=== 13. cleanup ===                             1/1   passed
SUMMARY: 39 passed, 0 failed
```

The test generates a throwaway Ed25519 keypair, exercises the full happy
path + suspend / revoke / replay / tamper paths, then cleans up. With
`DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` exported, cleanup is a hard DELETE;
otherwise it falls back to a soft cleanup (status=REVOKED) and prints the
manual DELETE SQL.

### 28.6 Files

- `migrations/010_phase4b_manufacturers.sql`
- `lib/manufacturer.js`
- `scripts/test-manufacturer-flow.js`
- `docs/MANUFACTURER-ONBOARDING.md`
- modified `server.js` (endpoints + registration hook + `mfrAttestLimiter`)

---

## 29. Production Hardening Sprint Log (2026-05-12)

Checkpoint trail of the multi-step production hardening sprint. Each step
appended in chronological order so we can resume seamlessly after interruption.

### Step 2 — bitcoind `txindex=1` config prep ⚠️ BLOCKED — operator decision required (2026-05-12 ~14:35 UTC)

**Finding (discovered during prep):**

The running bitcoind container is launched with `-prune=5000` (5 GB pruned
node). Inspection:

```
$ docker exec btcpayserver_bitcoind cat /proc/1/cmdline | tr '\0' ' '
bitcoind -prune=5000 -dbcache=1024 -maxconnections=12 -rpcauth=btcrpc:... \
         -rpcport=43782 -rpcbind=0.0.0.0:43782 -rpcallowip=0.0.0.0/0 \
         -port=39388 -whitelist=0.0.0.0/0 -datadir=/data

$ docker exec btcpayserver_bitcoind cat /data/bitcoin.conf
mainnet=1
[main]
printtoconsole=1
rpcallowip=::/0
```

`txindex=1` **requires a fully-indexed (non-pruned) chain**. Bitcoin Core will
refuse to start if `txindex=1` is set while `-prune=N>0` is in effect, with the
error: `"Prune mode is incompatible with -txindex"`. The prune flag is passed
via the BTCPay-managed docker-compose command line (not via the in-container
`/data/bitcoin.conf`), so editing `bitcoin.conf` to add `txindex=1` would
**silently break the next restart** (and any docker host reboot / security
update / docker engine update would trigger that restart).

**Therefore we did NOT modify `bitcoin.conf`.** Touching it now is a trap.

**Operator gate (3 options — operator must choose):**

1. **Stay pruned, skip txindex (current state, recommended for now).**
   - Cost: $0, no downtime.
   - Anchor worker's existing 3-tier fallback (`gettransaction` →
     `getrawtransaction` → mempool.space) already covers the gap. Verified
     working for both production anchors in block 949,085.
   - `verifyAnchorOnChain` likewise has the 3-tier fallback.
   - Downside: external relying parties cannot look up arbitrary historical
     anchor txs by `getrawtransaction <txid>` against our node; they must use
     mempool.space (or run their own full node, which is the standard
     trust-minimization stance anyway).

2. **Unpruned + txindex (full archival node, gives single-tier
   `getTxStatus` / `verifyAnchorOnChain`).**
   - Cost: ~700 GB disk (currently 5 GB used → +~700 GB), 4–8 h IBD or 1–2 d
     full re-sync.
   - Steps (when the operator is ready for the maintenance window):
     1. `docker compose stop btcpayserver_bitcoind` (or equivalent
        BTCPay-managed stop)
     2. Edit `/var/lib/docker/volumes/generated_bitcoin_datadir/_data/bitcoin.conf`
        to add `txindex=1`
     3. **Edit the BTCPay docker-compose override** (NOT just `bitcoin.conf`)
        to remove `-prune=5000` from the bitcoind command. The BTCPay
        deployment uses fragment-based compose generation; the relevant file
        is typically `/root/btcpayserver-docker/docker-compose-generator/docker-fragments/bitcoin-mainnet.yml`
        or set via `BTCPAYGEN_ADDITIONAL_FRAGMENTS=opt-add-bitcoinfullnode`
        env var.
     4. `BTCPayServer-docker/btcpay-up.sh` (regenerates compose)
     5. `docker compose up -d btcpayserver_bitcoind`
     6. Monitor reindex via `docker logs -f btcpayserver_bitcoind | grep -i
        'progress'` — expect 4–24 h depending on hardware.
     7. During reindex the anchor worker's 3-tier fallback continues serving
        (wallet+mempool.space) — no downtime for KYA-Hub.

3. **Compact-filter index (txindex-lite, less common).**
   - `blockfilterindex=basic` works in pruned mode but does NOT enable
     `getrawtransaction <txid>` for arbitrary txs — only for txs in unpruned
     blocks. Not a real alternative for our use case.

**Decision pending:** keep state (1) for now; the 3-tier fallback is robust
and we have no near-term need for full-node lookups. Re-visit when (a) BTCPay
is upgraded for some other reason, or (b) we want to remove the mempool.space
dependency entirely.

**Files touched in this step:** NONE (intentionally — see "trap" warning
above). The recommended top-of-file note in `bitcoin.conf` is also NOT added,
because the .conf is volume-mounted under BTCPay's regen flow and may be
overwritten on the next `btcpay-up.sh`.

**Blockers:** operator must choose option 1, 2, or 3 above. Default = 1
(no-op).

**Next:** Step 3 — Phase 5 Revocation Transparency Log.

---

### Step 3 — Phase 5 Revocation Transparency Log ✅ DRY_RUN ready — waiting for user GO on first KYAR broadcast (2026-05-12 ~15:00 UTC)

**Done:**

- Migration 009 applied — 3 new tables (`revocation_events`, `crl_anchors`,
  `crl_signed_files`) + auto-backfill of 3 existing historical revocations.
- `lib/crl.js` — Merkle tree builder + per-leaf proof + Bitcoin-style
  odd-level duplication + KYAR OP_RETURN payload + canonical CRL JSON
  signing/verification.
- `scripts/crl-worker.js` — PM2 daemon (`kya-crl-worker`), 24 h anchor
  loop + 10 min confirm loop, idempotent per-epoch, advisory lock, signed
  CRL JSON file generator with stable `latest.json` symlink.
- ROOT signing key generated (`HUB-ROOT-20260512`,
  pub=`d280308f…6e769527`), encrypted in `.env`.
- Public API endpoints live: `/api/crl`, `/api/crl/proof/:serial`,
  `/api/crl/epoch/:id`, `/api/crl/anchors`, `/crl/<file>.json` (static),
  `/crl/latest.json`. Admin gate: `POST /api/admin/crl/anchor-now`.
- All revoke code paths (rep-engine SUSPENDED, retire owner, GDPR purge,
  anchor reissue, admin reissue) now insert into `revocation_events`.
- `scripts/test-phase5.js`: **43/43 assertions pass**, including
  cryptographic offline verification of the served signed CRL JSON.
- UMBRAXON Section 27 fully written.

**Files added:** `migrations/009_phase5_crl_transparency.sql`, `lib/crl.js`,
`scripts/crl-worker.js`, `scripts/test-phase5.js`, `public/crl/` dir.

**Files modified:** `server.js`, `lib/reputation-engine.js`,
`lib/retire-service.js`, `lib/anchor.js`, `ecosystem.config.js`, `.env`.

**Current epoch:** `CRL-2026-05-12` (epoch_id=20585), leaves=3,
merkle_root=`cec0ef51f356d862495d81ab220871226346f9f1e160061f46b648fab371fecd`,
status=`DRY_RUN`, OP_RETURN payload (would-be)
`4b594152cec0ef51f356d862495d81ab220871226346f9f1e160061f46b648fab371fecd`.

**Blockers / gates:**

- ⚠️ **First LIVE KYAR broadcast requires explicit user GO.** To proceed:
  1. Confirm wallet has ≥ ~1,000 sat (currently 7,372 sat → headroom for
     ~20 KYAR anchors).
  2. Flip `.env`: `CRL_WORKER_BROADCAST_ENABLED=true`.
  3. `pm2 restart kya-crl-worker --update-env`.
  4. Watch logs for first broadcast (will happen within `INTERVAL_MS=24h`
     from the worker's startup tick — to force immediately, use admin
     endpoint or `node scripts/crl-worker.js --once`).

**Next:** Step 4 — Manufacturer Onboarding API.

---

### Step 1 — Anchor wallet top-up monitor ✅ (2026-05-12 ~14:30 UTC)

**Done:**

- New file `scripts/anchor-wallet-monitor.js` — single-shot or `--watch` mode,
  reads bitcoind `kya-anchor` wallet via `walletCall('getbalance')` +
  `getwalletinfo` + `listunspent`, classifies balance into `OK / WARN /
  CRITICAL / AUTOPAUSE`, sends Telegram alerts with dedupe keys, and on
  AUTOPAUSE rewrites `.env` to set `ANCHOR_WORKER_BROADCAST_ENABLED=false` and
  runs `pm2 restart kya-anchor-worker --update-env`.
- Registered in `ecosystem.config.js` as `kya-anchor-wallet-monitor` with
  `cron_restart: '*/30 * * * *'` (auto-restart every 30 min, autorestart=false
  so PM2 doesn't loop it between cron windows).
- UMBRAXON 26.12 → added section **26.12.1 Top-up monitor** with thresholds
  table, autopause recovery procedure, manual top-up procedure, and
  force-test command.
- Initial run: wallet balance 7,372 sat → level=OK → no notification (as expected).
- PM2 dump saved.

**Blockers:** none.

**Next:** Step 2 — bitcoind `txindex=1` config prep.

---

### Step 5 — Phase 5b Multi-Sig ELITE certs ✅ (2026-05-12 ~17:15 UTC)

**Done:**

- Migration 011 applied: `certificates` extended with `proof_type` (default
  `Ed25519Signature2020`), `proof_threshold` (default 1), and
  `proof_signing_roles` (text[]). 11 historical certs backfilled.
- `lib/hubkeys.js` gained two new exports:
  - `signMultiSig({ message, roles, optional, audit })` — signs a single
    message with N roles in order, returns
    `[ { role, keyId, pubHex, signature } ]` + `missing[]` for optional
    roles that were skipped.
  - `verifyMultiSig(message, signatures, threshold)` — verifies an array
    against a threshold; returns
    `{ valid, validCount, total, threshold, perSignature }`.
- `lib/certs.js` overhaul:
  - New `signCert(body, audit, opts)` opt-in API. ELITE certs auto-pick the
    multi-sig path when `CERT_ELITE_MULTISIG=true` (default). Explicit
    `{ multiSig, roles, threshold, optional }` overrides for break-glass.
  - New `Ed25519MultiSignature2020` proof block format:
    ```jsonc
    {
      "type": "Ed25519MultiSignature2020",
      "created": "...",
      "threshold": 2,
      "signatures": [
        { "role": "BASIC", "verificationMethod": "did:key:ed25519:<pub>#key-basic",
          "signatureValue": "<128hex>", "signingKeyId": "HUB-BASIC-..." },
        { "role": "ELITE", "verificationMethod": "did:key:ed25519:<pub>#key-elite",
          "signatureValue": "<128hex>", "signingKeyId": "HUB-ELITE-..." }
      ],
      "verificationMethods": ["did:key:ed25519:<basic>#key-basic", "..."],
      "proofPurpose": "assertionMethod",
      "algorithm": "Ed25519",
      "canonicalizationAlgorithm": "urn:umbraxon:json-sorted-keys-v1",
      "digestAlgorithm": "SHA-256",
      "missingRoles": []
    }
    ```
  - `verifyCertSignature()` accepts both proof types transparently. Result
    includes `multisig: true/false`, `threshold`, `validCount`,
    `perSignature[]`. For multi-sig also `issuerPubkeys[]` is returned
    (with `issuerPubkey` aliased to the first pubkey for backward compat).
- `server.js` + `lib/anchor.js`: cert INSERTs now persist `proof_type`,
  `proof_threshold`, `proof_signing_roles`. Multi-sig-aware `issuerPubkey`
  derivation (looks at `signatures[0].verificationMethod` when single-sig
  VM is absent).
- Env defaults:
  - `CERT_ELITE_MULTISIG=true` (default on)
  - `CERT_ELITE_MULTISIG_ROLES=BASIC,ELITE`
  - `CERT_ELITE_MULTISIG_THRESHOLD=2`
  - `CERT_ELITE_MULTISIG_OPTIONAL=` (empty — both required to sign)
  - ROOT key remains **offline-only for emergency** (not part of the
    default signing path). Break-glass usage: pass
    `{ multiSig: true, roles: ['BASIC','ELITE','ROOT'], threshold: 3 }`
    explicitly to `signCert()`.
- `scripts/test-multisig-elite.js` — **39/39 assertions pass**, including
  3-of-3 break-glass with ROOT key.
- `scripts/test-phase5.js` (CRL Phase 5) still passes 31/31 (proves no
  regression on legacy single-sig path).

**Backward compat:**

- Existing 11 single-sig certs (including the 2 LIVE ELITE certs anchored
  in block 949,085) verify unchanged through `verifyCertSignature()`.
- Offline verifier scripts (`test-protocol.js`, `test-phase4.js`) keep
  working because `verifyCertSignature(legacyCert).issuerPubkey` is still
  populated.
- The legacy `certificates.hub_signature` column still receives a value
  (the first signature in multi-sig mode); canonical truth is the JSONB
  `cert_body.proof.signatures[]` array.

**Files added:** `migrations/011_phase5b_multisig.sql`,
`scripts/test-multisig-elite.js`.

**Files modified:** `lib/hubkeys.js`, `lib/certs.js`, `lib/anchor.js`,
`server.js`, `UMBRAXON.md`.

**Wallet impact:** zero (no on-chain transactions).

**Blockers:** none. All NEW ELITE certs from this point are issued as
2-of-2 multi-sig (BASIC + ELITE). To re-sign the 2 existing LIVE ELITE
certs with the new multi-sig scheme, the operator must invoke admin
reissue manually (`POST /api/admin/agent/:kya_id/reissue-cert`) — not
done automatically to preserve the audit trail of the original
single-sig issuance.

**Next:** Step 6 — Security audit + `SECURITY-AUDIT-2026-05-12.md`.

---

### Step 6 — Security audit ✅ (2026-05-12 ~18:00 UTC)

**Done:**

- Static review of every file added/modified in Phase 3, 4, 4B, 5, 5b.
- `npm audit` clean (0 advisories across 165 prod deps).
- 20 findings categorised: **0 P0**, 3 P1, 2 P2, 15 OK.
- Full write-up in [`SECURITY-AUDIT-2026-05-12.md`](SECURITY-AUDIT-2026-05-12.md)
  including methodology, per-finding detail, fix queue, and re-test
  plan.
- **All P1 + P2 fixes applied in the same commit:**
  - **P1 §3.4** Sanitised `e.message` leakage from public endpoints
    (`/api/agent/:kya_id/action`, `/api/agent/:kya_id/retire`,
    `/api/manufacturer/attestation`). Server-side detail preserved in
    `logger.error` only.
  - **P1 §3.5** Added per-manufacturer token bucket
    (`lib/manufacturer._consumeMfrToken`). Defaults: BRONZE 60/hr,
    SILVER 120/hr, GOLD 240/hr (env-tunable). HTTP 429 +
    `Retry-After` on exhaustion.
  - **P1 §3.6** Capped `attestation_metadata` and `manifest.metadata`
    at 4 KB each (env: `MFR_MAX_METADATA_BYTES`,
    `MFR_MAX_MANIFEST_META_BYTES`). HTTP 413 on oversize.
  - **P2 §3.2** Removed deprecated `"crypto": "^1.0.1"` stub from
    `package.json`. `npm prune` removed `node_modules/crypto`.
  - **P2 §3.3** Deleted orphan root-level `anchor.js` (dead code).
- Tests after fixes: `test-multisig-elite` 39/39, `test-manufacturer-flow`
  44/44 (5 new P1-coverage assertions), `test-phase5 --skip-api` 31/31.

**Files added:** `SECURITY-AUDIT-2026-05-12.md`.

**Files modified:** `server.js`, `lib/manufacturer.js`, `package.json`,
`scripts/test-manufacturer-flow.js`, `UMBRAXON.md`.

**Files deleted:** `anchor.js` (orphan), `node_modules/crypto` (stub).

**Remaining audit follow-ups:**

- **PR-5 (P2)** Wire `npm audit --audit-level=high` and the three E2E
  test scripts into CI. Out of scope for this in-repo audit; needs an
  external CI runner.
- **Known accepted risk:** ROOT private key stored online (encrypted at
  rest in `.env`). Documented in `UMBRAXON.md §27` and §28.
  Long-term plan: move to HSM / offline storage. Not a blocker for
  current scope because ROOT is only invoked for break-glass ELITE
  cert re-issuance (operator-explicit, not automatic).

**Wallet impact:** zero.

**Blockers:** none. **Sprint complete.**

---

### Step 4 — Phase 4B Manufacturer Onboarding API ✅ (2026-05-12 ~16:30 UTC)

**Done:**

- Migration 010 applied: `manufacturers` + `manufacturer_attestations`
  tables, plus `registration_intents.{mfr_attestation_id, mfr_tier}` and
  `agents.{mfr_attestation_id, mfr_tier}` columns. Idempotent (re-run
  safe).
- `lib/manufacturer.js` — admin CRUD (register / verify / suspend / revoke),
  public attestation submission with Ed25519 verification, internal
  `findUsableAttestation()` + `markAttestationConsumed()`, attestation
  revocation, public/admin serialisers.
- `server.js` — 9 new endpoints (3 public + 6 admin), `mfrAttestLimiter`
  (20 req/min/IP, admin bypass), and registration hook in
  `/api/register/initiate` + `registerAgent()` that:
  - Looks up the DB attestation by canonical manifest hash (with optional
    pubkey/name pins) and prefers it over the legacy env-var path.
  - Persists `mfr_attestation_id` + `mfr_tier` through the
    `registration_intents` row.
  - On payment settle + agent INSERT, calls `markAttestationConsumed()` to
    link the attestation row to the new agent (one-shot, idempotent).
  - Falls back gracefully to the env-based check if the DB lookup throws
    (never blocks registration on the new path).
- `docs/MANUFACTURER-ONBOARDING.md` — full operator + integrator guide
  including Node.js / Python / curl signer recipes, KYC tier semantics,
  rotation playbook, compromise response, error code reference.
- `scripts/test-manufacturer-flow.js` — **39/39 assertions pass** against
  the live hub. Exercises register → verify → submit → idempotent replay →
  tampered sig (401) → DB sanity → `findUsableAttestation` → suspend
  rejection → re-verify → attestation revoke → cleanup. Cleanup uses
  privileged DB user if `DB_ADMIN_USER` exported, else falls back to soft
  cleanup via the revoke API.
- UMBRAXON Section 28 fully written.

**Files added:** `migrations/010_phase4b_manufacturers.sql`,
`lib/manufacturer.js`, `scripts/test-manufacturer-flow.js`,
`docs/MANUFACTURER-ONBOARDING.md`.

**Files modified:** `server.js`, `UMBRAXON.md`.

**Behavior preserved:**

- Legacy env-var `TRUSTED_MANUFACTURERS` path still works (fallback) — no
  breaking changes for callers already using in-manifest `manufacturer.*`
  sub-objects.
- Backward-compat for existing agents with `manufacturer_id` set from the
  env-var era — they retain `manufacturer_verified=true`, even though
  there's no `mfr_attestation_id` to consume.
- All admin endpoints rate-limit-bypass and `_adminBypass()`-aware (PENDING
  / SUSPENDED / REVOKED manufacturers visible only to admin).

**Wallet impact:** zero (no on-chain transactions).

**Blockers:** none. Operator can begin onboarding real manufacturers via
`POST /api/admin/manufacturer/register` whenever ready.

**Next:** Step 5 — Multi-sig (BASIC + ELITE + ROOT) for ELITE certs.

---

## 30. Strategic Sprint 2026-05-12 — 13-item audit response

Multi-item resilience / backup / compliance sprint kicked off after the
16-point strategic audit (chat
[16-point audit](eec8cc1e-e75b-49ed-88ca-98458e4fe42b)). 13 of those 16
points are code-relevant and executed sequentially in priority order:

| # | Priority | Item | Status |
|---|---|---|---|
|  1 | 🔴 HIGH   | Off-Hetzner encrypted backup for Lightning channel state | ⚠ B2 creds pending — local fallback active |
|  2 | 🔴 HIGH   | PostgreSQL automated daily backup                        | ⚠ B2 creds pending — local fallback active |
|  3 | 🔴 HIGH   | Cert issuance circuit breaker (soft 3 % / hard 8 %)      | ✅ |
|  4 | 🔴 HIGH   | Volumetric AML limits (per-agent, global)                | ✅ |
|  5 | 🔴 HIGH   | Bitcoin fork detector                                    | ✅ |
|  6 | 🟡 MED    | Lightning inbound liquidity monitor                      | ⚠ inbound visibility pending operator unlock-pw drop |
|  7 | 🟡 MED    | Log redaction expansion + regex auto-mask                | (in progress) |
|  8 | 🟡 MED    | GDPR-aligned agent data-export endpoint                  | (in progress) |
|  9 | 🟡 MED    | Public `/api/protocol/versions` endpoint                 | (in progress) |
| 10 | 🟡 MED    | Prometheus `/api/metrics` + p99 latency alert            | (in progress) |
| 11 | 🟢 LOW    | DAC8 daily accounting export                             | (in progress) |
| 12 | 🟢 LOW    | ESG statement template + auto-generated yearly report     | (in progress) |
| 13 | 🟢 LOW    | Lightning watchtower operator playbook                   | (in progress) |

Each item updates the row above as it lands. Detailed per-item
checkpoints are appended below in chronological order.

### 30.1 Item 1 — Lightning channel state backup ✅ (B2 pending) (2026-05-12)

**Done:**

- Generated 32-byte `BACKUP_PASSPHRASE` (64 hex chars) into `.env` and
  chmod 600. Documented recovery procedure (incl. `BACKUP_PASSPHRASE`
  rotation playbook) in [`docs/RESTORE-PROCEDURES.md`](docs/RESTORE-PROCEDURES.md).
- Migration **012_strategic_sprint_backup_and_aml.sql** applied — new
  `backup_log` table (append-only audit) + `volumetric_limits` /
  `volumetric_counters` (Item 4 schema rolled in to keep migration count
  reasonable). GRANTs to `kyahub_app` (SELECT/INSERT/UPDATE only).
- New `scripts/backup-channel-state.sh`:
  - Tars `/root/kya-hub/albyhub/workdir/` (LDK channel store + SCB +
    nwc.db) with `--warning=no-file-changed` (sqlite WAL is hot).
  - Encrypts with `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`
    keyed off `BACKUP_PASSPHRASE` and appends 32-byte HMAC-SHA256 tail
    for tamper-evidence (encrypt-then-MAC). Functionally equivalent to
    AES-256-GCM under our threat model; CBC+HMAC chosen for openssl CLI
    portability.
  - Uploads to Backblaze B2 if `B2_KEY_ID` / `B2_APP_KEY` / `B2_BUCKET`
    are present (supports both `b2` CLI and `aws s3` against
    `B2_S3_ENDPOINT`). Falls back to local-only with a Telegram
    `warning` (deduped) instructing the operator to provision B2.
  - Logs one row into `backup_log` per run (kind, dest, size, sha256,
    status, metadata, host).
  - Prunes `/root/backups/lightning_channel/` older than
    `BACKUP_HOT_RETENTION_DAYS` (default 30 d).
  - Telegram critical alert on FAIL or PARTIAL (deduped per status).
- Cron installed: `17 * * * * scripts/backup-channel-state.sh` (hourly,
  17 min offset).
- First real run produced a 26 MB encrypted artifact
  (`/root/backups/lightning_channel/channel-state-20260512T153409Z.tar.gz.enc`)
  with `backup_log id=1`, status=OK, sha256 prefix `83da5acf62d04092…`.
- `scripts/test-item1-channel-backup.js` — **14/14 assertions pass**:
  passphrase format, script presence + executable, artifact present
  with HMAC integrity verified, openssl roundtrip decrypts cleanly, tar
  contains `ldk/` + `nwc.db`, DB log row sha256 matches artifact.

**Files added:**

- `migrations/012_strategic_sprint_backup_and_aml.sql`
- `scripts/backup-channel-state.sh`
- `scripts/test-item1-channel-backup.js`
- `docs/RESTORE-PROCEDURES.md`
- `/root/backups/{lightning_channel,postgres,dac8_export,esg_report}/`
  (created, chmod 700)

**Files modified:**

- `.env` — appended `BACKUP_PASSPHRASE`, `B2_KEY_ID`, `B2_APP_KEY`,
  `B2_BUCKET`, `B2_S3_ENDPOINT`, `BACKUP_LOCAL_DIR`,
  `BACKUP_HOT_RETENTION_DAYS`, `BACKUP_COLD_RETENTION_DAYS` (B2 keys
  blank until operator provisions a bucket).
- crontab: `17 * * * * scripts/backup-channel-state.sh`.

**User-input gates encountered:**

- ⚠ **Backblaze B2 credentials pending operator provisioning.** Until
  `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_S3_ENDPOINT` are set in
  `.env`, all encrypted backups remain on the Hetzner host under
  `/root/backups/`. This is safer than the prior state (no backup at
  all) but does NOT satisfy the "off-Hetzner" intent of Item 1. Operator
  must:
  1. Sign up for Backblaze B2 (https://www.backblaze.com/cloud-storage),
     pick the **EU Central** region (jurisdictional alignment).
  2. Create a bucket named e.g. `umbraxon-kyahub-backups`,
     **private**, **server-side encryption ON**.
  3. Create an application key scoped to that bucket
     (read+write+listFiles).
  4. Populate `.env` with the four values, `chmod 600 .env`, and run
     `bash scripts/backup-channel-state.sh` once manually to verify
     B2 upload path.

**Cumulative test count after Item 1:** existing 114 + 14 = **128**.

### 30.2 Item 2 — PostgreSQL daily backup ✅ (B2 pending) (2026-05-12)

**Done:**

- New `scripts/backup-database.sh`:
  - `pg_dump --format=custom --no-owner --no-privileges | gzip -6` →
    `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt` keyed off
    `BACKUP_PASSPHRASE` + 32-byte HMAC-SHA256 tail (same encrypt-then-
    MAC format as Item 1).
  - Object name: `kyahub-YYYYMMDD.dump.gz.enc` (B2 path
    `db/kyahub-YYYYMMDD.dump.gz.enc`).
  - Same B2-or-local fallback strategy as Item 1.
  - Inserts one row into `backup_log` per run (kind=`postgres`).
  - Prunes local `/root/backups/postgres/` older than 30 d.
  - Telegram CRITICAL on FAIL / PARTIAL (dedupe `db_backup_*`).
- Cron installed: `0 2 * * * scripts/backup-database.sh` (02:00 UTC
  daily). Coexists with the older local-only Phase 2.4
  `scripts/backup-db.sh` (kept; writes to `/var/backups/kyahub/`, no
  encryption) so we have **two independent backup paths** —
  defence-in-depth.
- First real run produced `/root/backups/postgres/kyahub-20260512.dump.gz.enc`
  (172 KB; small because the DB only has 13 agents + minimal history),
  status=OK, sha256 prefix `888fbf2d…`.
- Restore procedure documented in
  [`docs/RESTORE-PROCEDURES.md` §3](docs/RESTORE-PROCEDURES.md).
- `scripts/test-item2-database-backup.js` — **8/8 assertions pass**:
  artifact present, HMAC tail validates, openssl decrypts cleanly,
  gunzip yields a buffer starting with the PostgreSQL custom-format
  magic `PGDMP`, backup_log row matches.

**Files added:**

- `scripts/backup-database.sh`
- `scripts/test-item2-database-backup.js`

**Files modified:**

- crontab: `0 2 * * * scripts/backup-database.sh`.
- `docs/RESTORE-PROCEDURES.md` (already includes §3 restore steps from
  Item 1 commit).

**User-input gates encountered:**

- ⚠ Same Backblaze B2 credentials gate as Item 1. Currently writes to
  `/root/backups/postgres/` only. The daily `02:00 UTC` cron will keep
  building these artifacts; the moment B2 creds are added to `.env`,
  the very next run will start uploading to `b2://${B2_BUCKET}/db/`.

**Cumulative test count after Item 2:** 128 + 8 = **136**.

### 30.3 Item 3 — Cert issuance circuit breaker ✅ (2026-05-12)

**Done:**

- New module **`lib/cert-issuance-breaker.js`** — fundamentally different
  from `lib/circuit-breaker.js` (which counts consecutive upstream
  failures): this one keeps a rolling 5-min window of cert *signing*
  outcomes and trips on FAILURE PERCENTAGE.
  - SOFT WARN at **3 %** fail rate → Telegram `warning`, dedupe
    `cert_issuance_degraded`. Cert signing continues.
  - HARD HALT at **8 %** fail rate → maintenance mode. `/api/pay`
    returns HTTP 503 + `Retry-After: 300`. Telegram `critical`, dedupe
    `cert_issuance_halted`. Operator-only manual reset.
  - `MIN_SAMPLES=20` gates the trip so a single quiet-day failure
    cannot halt the system.
  - `AUTO_RESET_AFTER_MS=0` by default — only an admin POST reset
    can clear the halt. (Set non-zero in `.env` to enable optional
    auto-recovery after a grace period.)
- Wired into `server.js`:
  - `issueCertificate(client, ...)` now wraps `buildCertBody` +
    `signCert` in try/catch and calls `recordFailure(err)` on any
    error from the body builder, signer, or DB INSERT/UPDATE.
    On success it calls `recordSuccess()`.
  - Before doing any work it consults `canIssue()` and throws
    `CERT_ISSUANCE_HALTED` (with `retryAfterSec=300`) if halted.
  - `/api/pay` POST handler now has a top-of-handler gate:
    `if (certIssuanceBreaker.isMaintenanceMode()) → 503 + Retry-After`.
- Admin endpoints (both `X-Admin-Key`-gated):
  - `GET  /api/admin/breaker/cert-issuance/state` — window stats,
    config, halt state, last 10 failure codes, last 10 admin resets.
  - `POST /api/admin/breaker/cert-issuance/reset` — clears HARD HALT,
    records `{admin, reason, ts}` into `reset_history[]`. Accepts a
    `reason` in body or query string + an `X-Admin-User` header for
    attribution.
  - `GET /api/admin/breakers` enriched: also returns `cert_issuance`
    snapshot alongside the BTCPay/Alby breakers.
- Env vars (added to `.env` with safe production defaults):
  - `CERT_BREAKER_WINDOW_MS=300000`
  - `CERT_BREAKER_MIN_SAMPLES=20`
  - `CERT_BREAKER_WARN_PCT=3`
  - `CERT_BREAKER_HALT_PCT=8`
  - `CERT_BREAKER_AUTO_RESET_AFTER_MS=0`
- `scripts/test-item3-cert-breaker.js` — **36/36 assertions pass**:
  9 in-process test groups (initial state, MIN_SAMPLES gate, soft warn
  band, HALT band, `wrap()` throwing while halted, admin reset,
  window slide, `wrap()` outcome accounting) + live endpoint smoke
  tests against PM2-served kya-hub (state, reset, /breakers includes
  cert_issuance, bad-admin-key → 401).
- `pm2 reload kya-hub --update-env` clean (no regression on /api/tiers,
  /api/pay still serves 200 for valid requests).

**Files added:**

- `lib/cert-issuance-breaker.js`
- `scripts/test-item3-cert-breaker.js`

**Files modified:**

- `server.js` — require, `issueCertificate` wrap, `/api/pay`
  maintenance gate, admin endpoints, `/api/admin/breakers` enrichment.
- `.env` — 5 new vars.

**User-input gates encountered:** none. Thresholds (3 % / 8 %) were
user-confirmed in the audit brief.

**Cumulative test count after Item 3:** 136 + 36 = **172**.

### 30.4 Item 4 — Volumetric AML limits ✅ (2026-05-12)

**Done:**

- Schema landed in migration 012 (applied during Item 1): two new
  tables `volumetric_limits` (admin-editable) + `volumetric_counters`
  (sliding-window event log). Seeded 3 default limits with
  regulator-defensible rationales:
  | limit_key                    | threshold | window | scope     |
  |------------------------------|----------:|-------:|-----------|
  | `agent:per_day_sats`         | 200 000   | 24 h   | per_agent |
  | `global:per_hour_regs`       | 1 000     |  1 h   | global    |
  | `global:per_day_anchor_sats` | 50 000    | 24 h   | global    |
- New module **`lib/volumetric-limits.js`**:
  - `check(pool, key, { subject_id, amount, metadata })` — INSERT
    counter row + rolling-window SUM/COUNT in one short transaction.
    Returns `{ok, threshold, current, retry_after_sec, …}`. Telegram
    `warning` on breach (dedupe per `limit_key:subject`).
  - `peek(pool, key, { subject_id })` — non-mutating window inspection
    for admin dashboards.
  - `upsertLimit(pool, …)` — admin-driven CRUD. Pre-fetches existing
    row to merge values (PG enforces NOT NULL during the INSERT phase
    even when ON CONFLICT branches).
  - `prune(pool, { extra_margin_days, dry_run })` — counter cleanup.
  - **Fails OPEN** on DB errors (loud-log only — a misconfigured pool
    must never accidentally take the hub offline).
- Wiring:
  - `server.js /api/pay` checks `global:per_hour_regs` (count=1) on
    every fresh registration attempt, returns 429 +
    `Retry-After: 3600` + `VOLUMETRIC_LIMIT_EXCEEDED` body on breach.
  - `scripts/anchor-worker.js` records `agent:per_day_sats` (subject =
    `kya_id`, amount = fee_sats) and `global:per_day_anchor_sats`
    after each successful OP_RETURN broadcast. Failures here are
    swallowed — never poison the just-broadcast tx.
- Admin endpoints (all `X-Admin-Key`-gated):
  - `GET    /api/admin/volumetric-limits` — list + global-window peek.
  - `GET    /api/admin/volumetric-limits/:limit_key?subject_id=…` — peek.
  - `POST   /api/admin/volumetric-limits` — upsert (body fields per
    doc; supports `X-Admin-User` audit attribution).
  - `POST   /api/admin/volumetric-limits/prune?dry_run=1` — counter prune.
- Doc: [`docs/AML-VOLUMETRIC-LIMITS.md`](docs/AML-VOLUMETRIC-LIMITS.md)
  — threshold rationales, breach behavior, recommended counter-prune
  cron, "adding new limits" recipe.
- `scripts/test-item4-volumetric.js` — **27/27 pass**: seed, peek,
  under/at/above threshold, per_agent isolation, global count limit,
  disabled-fails-open, unknown-key-fails-open, full admin endpoint
  loop incl. 401 on bad key. Test cleans up its own rows.
- `pm2 reload kya-hub` + `pm2 reload kya-anchor-worker` clean.

**Files added:**

- `lib/volumetric-limits.js`
- `docs/AML-VOLUMETRIC-LIMITS.md`
- `scripts/test-item4-volumetric.js`

**Files modified:**

- `server.js` — require, `/api/pay` gate, 4 admin endpoints,
  `/api/admin/breakers` already enriched in Item 3.
- `scripts/anchor-worker.js` — post-broadcast counter inserts.

**User-input gates encountered:** none. Seeded thresholds match the
audit brief's defaults.

**Cumulative test count after Item 4:** 172 + 27 = **199**.

### 30.5 Item 5 — Bitcoin fork detector ✅ (2026-05-12)

**Done:**

- New module **`lib/fork-detector.js`** with three independent sources:
  - local bitcoind via `bitcoindRpc.call('getblockcount')` +
    `getblockhash <height>`
  - mempool.space Esplora: `/api/block-height/<height>` +
    `/api/blocks/tip/{hash,height}`
  - blockstream.info Esplora: `/api/block-height/<height>` +
    `/api/blocks/tip/{hash,height}`
- Compares hashes at `local_tip - FORK_DETECTOR_DEPTH` (default 1) so
  short-term explorer lag does not look like a fork.
- Quorum rule = 2-of-3 on the same hash. Status:
  - `OK` if ≥2 sources agree AND local matches the quorum hash.
  - `FORK_DETECTED` otherwise (logged + Telegram CRITICAL, dedupe
    `fork_detector`).
  - `INSUFFICIENT_SOURCES` if <2 sources answered (warning).
  - `LOCAL_RPC_UNREACHABLE` if bitcoind down (critical).
- Autopause: if `FORK_DETECTOR_AUTOPAUSE=true` in `.env`, a
  `FORK_DETECTED` outcome rewrites `.env` to
  `ANCHOR_WORKER_BROADCAST_ENABLED=false` and runs
  `pm2 restart kya-anchor-worker --update-env` (env file backed up
  to `.env.fork-pause-<ts>` first). Default OFF — operator must opt in.
- Detects recovery: subsequent `OK` after a `FORK_DETECTED` fires an
  `info` notification with dedupe `fork_detector_recovered`.
- New PM2 cron app **`kya-fork-detector`** (`scripts/fork-detector-worker.js`)
  with `cron_restart: '*/10 * * * *'` and `autorestart: false`. Each
  run probes, alerts, exits with a status-coded exit code, PM2
  reschedules 10 min later.
- New admin endpoint:
  - `GET /api/admin/chain-status` — returns the in-memory `lastResult`
    (zero-cost; updated each time the embedded fork-detector library
    is called by anything in the server process).
  - `GET /api/admin/chain-status?fresh=1` — forces an immediate 3-source
    probe (~1–6 s); useful for verification or post-incident audit.
- Env vars added with safe defaults:
  - `FORK_DETECTOR_DEPTH=1`
  - `FORK_DETECTOR_HTTP_TIMEOUT_MS=6000`
  - `FORK_DETECTOR_AUTOPAUSE=false`
  - `MEMPOOL_API_URL=https://mempool.space`
  - `BLOCKSTREAM_API_URL=https://blockstream.info`
- First production run (against mainnet block 949,094): all 3 sources
  agreed on hash
  `000000000000000000010b573a159575e767c3ba6203edfddcb84512e4889a3b`.
  Status = OK, autopause not triggered.
- `scripts/test-item5-fork-detector.js` — **13/13 pass**: config
  sanity, mainnet quorum probe, ≥1 external source, admin endpoints
  (cached + fresh), 401 on bad key.
- `pm2 reload kya-hub`, `pm2 start kya-fork-detector`, `pm2 save`.

**Files added:**

- `lib/fork-detector.js`
- `scripts/fork-detector-worker.js`
- `scripts/test-item5-fork-detector.js`

**Files modified:**

- `server.js` — require, `/api/admin/chain-status` endpoint.
- `ecosystem.config.js` — new `kya-fork-detector` PM2 app.
- `.env` — 5 new vars.

**User-input gates encountered:** none. Operator can opt into
`FORK_DETECTOR_AUTOPAUSE=true` whenever they want stronger automated
safety (default OFF lets the operator decide manually after seeing the
alert).

**Cumulative test count after Item 5:** 199 + 13 = **212**.

### 30.6 Item 6 — Lightning inbound liquidity monitor ✅ (operator gate) (2026-05-12)

**Done:**

- New `scripts/lightning-liquidity-monitor.js` (also `require`-able):
  - **Preferred path** — Alby Hub native HTTP API
    (`POST /api/unlock` → `GET /api/channels`). Reads `localBalance` /
    `remoteBalance` / capacity / active state for every channel.
    Requires the hub to be unlocked; the script reads the unlock
    password from a chmod-600 file (default
    `/root/kya-hub/.secrets/alby-unlock.txt`).
  - **Fallback path** — NWC `getBalance()` for outbound sats. Inbound
    is `null` + `inbound_unknown=true`; a `warning` Telegram is sent
    explaining how to enable full visibility.
  - **Both fail** → CRITICAL Telegram, exit 4.
- Thresholds (env-tunable, defaults match audit brief):
  - WARN at `<500 000` sats inbound (50 % depletion of the 1 M MegaLith
    channel)
  - CRITICAL at `<200 000` sats inbound
  - Recovery info notification on return to OK after WARN/CRITICAL.
- Telegram alerts on WARN / CRITICAL with deduped keys
  (`liquidity_warn`, `liquidity_critical`) and explicit action:
  *"Buy +500 k SAT channel from MegaLith for ~9 k SAT fee"*.
- New admin endpoint:
  - `GET /api/admin/lightning/liquidity` (cached lastResult, zero-cost)
  - `?fresh=1` for an immediate probe (~1 s when alby-http path active).
- New PM2 cron app **`kya-liquidity-monitor`** with
  `cron_restart: '*/15 * * * *'`, `autorestart: false`. First tick
  observed: NWC fallback path used (no unlock password file), outbound
  5 646 sats, inbound_unknown=true.
- Env vars added:
  - `LIQUIDITY_WARN_SATS=500000`
  - `LIQUIDITY_CRITICAL_SATS=200000`
  - `LIQUIDITY_LSP_FEE_SATS=9000`
  - `LIQUIDITY_LSP_BUY_SATS=500000`
  - `LIQUIDITY_HTTP_TIMEOUT_MS=5000`
  - `ALBY_HUB_URL=http://127.0.0.1:8080`
  - `ALBY_UNLOCK_PASSWORD_FILE=/root/kya-hub/.secrets/alby-unlock.txt`
- `scripts/test-item6-liquidity.js` — **13/13 pass**: config defaults,
  runOnce returns probe + correct fallback flags, admin endpoint
  cached/fresh/401.

**Files added:**

- `scripts/lightning-liquidity-monitor.js`
- `scripts/test-item6-liquidity.js`

**Files modified:**

- `server.js` — `/api/admin/lightning/liquidity` endpoint.
- `ecosystem.config.js` — new `kya-liquidity-monitor` PM2 app.
- `.env` — 7 new vars.

**User-input gates encountered:**

- ⚠ **Inbound visibility requires the operator's Alby Hub unlock
  password.** Until the operator drops it into
  `/root/kya-hub/.secrets/alby-unlock.txt` (chmod 600), the monitor
  runs in NWC-only fallback mode: it reports outbound balance and
  emits a `warning` notification (deduped `liquidity_no_auth`)
  explaining the fix. CRITICAL alerts cannot fire from the fallback
  path (we don't know inbound), so WARN/CRITICAL thresholds are
  intentionally observability-only until the operator enables full
  channel-state reads.

**Cumulative test count after Item 6:** 212 + 13 = **225**.

### 30.7 Item 7 — Log redaction expansion + regex auto-mask ✅ (2026-05-12)

**Done:**

- `lib/logger.js` overhauled with two redaction layers:
  - **Layer 1 — pino built-in `redact.paths`**: explicit env-name list
    expanded with `HUB_KEY_*_PRIVKEY_CIPHERTEXT`, `HUB_KEY_*_PRIVKEY`,
    `HUB_KEY_PASSPHRASE`, `BACKUP_PASSPHRASE`, `B2_APP_KEY`, `B2_KEY_ID`,
    `LNBITS_INVOICE_READ_KEY`, `ALBY_WEBHOOK_SECRET`,
    `TELEGRAM_BOT_TOKEN`, `DISCORD_WEBHOOK_URL`, plus `mnemonic`, `seed`,
    `xprv`, `tprv` (top-level and `*.` nested variants for
    `private_key`, `privkey`, `privateKey`, `unlock_password`,
    `unlockPassword`).
  - **Layer 2 — regex auto-redactor** (`formatters.log`):
    every log object is walked recursively before serialisation. Any
    *string value* >= `LOG_REDACT_MIN_LEN` (default 32) chars that
    matches a pure-hex pattern, a base64/base64url pattern, OR an
    envelope-ciphertext prefix (`GCM:`, `AES:`, `CBC:`, `ENC:`, `pbkdf2$`,
    `argon2$`, `scrypt:`) is replaced with `***REDACTED***`, UNLESS it
    begins with a public-by-design allow prefix:
    `UMBRA-` (kya_id), `KYAR`/`KYA1` (OP_RETURN magic), `did:`,
    `bc1`/`tb1` (bech32), `lnbc` (BOLT11), `http://`/`https://`,
    `mempool.space`, `blockstream.info`.
  - Field-name sweep: keys matching
    `passphrase|privkey|private_key|privateKey|seed|mnemonic|xprv|tprv|`
    `unlock_password|unlockPassword|api_key|apikey|secret|`
    `webhook_secret|admin_key|nwc_uri|telegram_bot_token|b2_app_key|`
    `backup_passphrase|hub_key_.*_ciphertext|hub_key_.*_privkey` are
    redacted regardless of value shape (catches obscurely-formatted
    secrets like NWC URIs with `?secret=…` query strings).
  - Header sweep: `cookie`, `authorization`, `x-admin-key`,
    `nostr-signature`, `btcpay-sig`, `alby-signature`, `x-alby-signature`
    keys are redacted unconditionally.
  - Helpers exported for testing: `_shouldRedact`, `_autoRedactDeep`,
    `_REDACT_PATHS`, `_ALLOW_PREFIXES`, `_MIN_AUTO_REDACT_LEN`.
- Env vars added (safe defaults):
  - `LOG_REDACT_MIN_LEN=32` (lowering it makes the auto-redactor more
    aggressive)
  - `LOG_REDACT_MAX_DEPTH=8` (walk depth cap, anti-DoS for cyclic
    objects)
- `scripts/test-item7-log-redaction.js` — **29/29 pass**:
  spawns a child node process that logs a realistic mix of secrets
  (HUB key ciphertext with `GCM:` envelope, raw 64-hex passphrases,
  BIP32 xprv, BIP39 mnemonic, NWC URI with embedded `secret=…` query
  string, admin keys, deep-nested ciphertext, `Bearer …`
  authorization), then `grep`s the captured stdout to ensure NONE of
  those secret values appear, while
  public-by-design values (kya_id, mempool.space URL, lnbc invoice
  prefix, KYAR magic, did:key DID, bc1 address) still pass through.
  Also unit-tests `_shouldRedact()` directly against allow-prefixes
  and the GCM envelope pattern.

**Defence-in-depth note (intentional false-positives):** the regex layer
also masks public-but-long values like block hashes, txids, and
secp256k1 pubkeys (66-hex). This is by design — the auto-redactor
cannot distinguish a public sha256 hash from a private 32-byte secret
that has been hex-encoded, so the policy is "mask first, ask later".
Operators who need to see a specific public hex in logs should either
prefix it with an allow-prefix at the call site (e.g.
`{ block_hash_short: hash.slice(0,16)+'…' }`) or log via a sibling
short-form field. The `lib/notifications.js` and `server.js` flows
that emit public block/tx ids already use short forms.

**Files added:**

- `scripts/test-item7-log-redaction.js`

**Files modified:**

- `lib/logger.js` — both redaction layers rewritten.

**User-input gates encountered:** none.

**Cumulative test count after Item 7:** 225 + 29 = **254**.

### 30.8 Item 8 — Agent data export endpoint (GDPR Subject Access) ✅ (2026-05-12)

**Done:**

- `migrations/013_strategic_sprint_data_export.sql` applied — new table
  `data_exports` (BIGSERIAL audit ledger; status PENDING/READY/EXPIRED/
  FAILED, sha256-hashed one-time download_token, expires_at, archive
  path + sha256, request signature/nonce/timestamp, client_ip,
  user_agent, download_count, pruned_at, metadata JSONB). Three indexes
  for `(kya_id, requested_at)`, `(status, expires_at)`, and a partial
  `(download_token_sha256)` for the public download lookup. Grants to
  `kyahub_app`: SELECT/INSERT/UPDATE only — DELETE intentionally
  withheld, audit rows are permanent.
- `lib/data-export-service.js` new module (~260 LOC) with the full
  signed-request → archive-build → token-hash → audit-row flow:
  - `canonicalExportPayload({kya_id, nonce, timestamp})` — fixed-shape
    JSON, identical pattern to retire/appeal/manufacturer flows.
  - `createExport(pool, hubkeys, args)` — validates format, ±5 min
    timestamp skew, looks up agent, verifies Ed25519 signature against
    `agents.agent_pubkey`, enforces a rolling 24h rate limit
    (`DATA_EXPORT_MAX_PER_DAY=5` default), inserts PENDING row, builds
    `data.json`, zips it as a single-entry archive at level 9, chmods
    the file 600, computes sha256, marks row READY. On any error sets
    status FAILED with `error_message`.
  - `resolveDownload(pool, {export_id, kya_id, token})` — timing-safe
    sha256(token) comparison, expiry check, single-use enforcement,
    `kya_id` path-mismatch guard.
  - `markDownloaded(pool, exportId)` — increments download_count and
    records the downloader's IP into `metadata`.
  - `prune(pool, {dryRun})` — admin pruner: deletes expired/failed
    archives from disk, marks rows PRUNED/EXPIRED, leaves the DB row
    intact for the audit trail.
  - `collectAgentDump(pool, kya_id, agent_id)` — joins 12 tables that
    reference the agent (agents, certificates, reputation_events,
    reputation_events_archive, action_log, reports_against_me,
    reports_by_me, appeals, heartbeats_log (last 1k),
    cert_signing_log, pending_anchors, anchor_audit, revocation_events).
    Each query is independently try/caught so a single missing table
    doesn't abort the whole dump.
- New endpoints in `server.js`:
  - `POST /api/agent/:kya_id/data-export` — phase2Limiter rate gate,
    signature failure tracked via `abuseTracker.recordSignatureFailure`
    (same as retire). Returns the freshly-built archive's
    one-time URL, sha256, size, expiry, and rate-limit usage.
  - `GET /api/agent/:kya_id/data-export/:export_id?token=...` — public
    binary download. Sets `Content-Type: application/zip`,
    `Content-Disposition` with the canonical filename, plus
    `X-Archive-SHA256` for tamper detection. Single-use semantics
    enforced via `markDownloaded`.
  - `GET /api/admin/data-exports` (admin-auth) — paginated audit
    listing; never returns the plaintext token, only the hashed form
    (and that's not in the columns selected).
  - `POST /api/admin/data-exports/prune` (admin-auth) — `dry_run` flag
    supported.
- Env vars added (safe defaults):
  - `DATA_EXPORT_DIR=/root/kya-hub/data-exports`
  - `DATA_EXPORT_TTL_SECONDS=3600`
  - `DATA_EXPORT_MAX_PER_DAY=5`
  - `DATA_EXPORT_PUBLIC_BASE_URL=` (empty → caller's SDK reconstructs)
  - `HUB_PUBLIC_URL=` (fallback if `DATA_EXPORT_PUBLIC_BASE_URL` empty)
- New dependency: `archiver@6` (CJS-compatible; v7 is ESM-only and our
  server is CommonJS). 6 packages added, 0 vulnerabilities.
- New disk artefact dir: `/root/kya-hub/data-exports/` (chmod 700).
- `docs/DATA-EXPORT-API.md` — full operator + regulator handbook:
  canonical payload shape, error table, admin endpoints, archive
  layout, retention policy, agent-SDK worked example.
- `scripts/test-item8-data-export.js` — **31/31 pass**: synthetic agent
  seeded with a throwaway Ed25519 keypair, then driven through every
  error path (bad sig, bad nonce, ts-skew, wrong privkey, unknown kya),
  the happy path (status READY, sha256 round-trips, mode 600), the
  single-use download semantic (good→OK, second→ALREADY_DOWNLOADED,
  mismatched kya_id→403), zip introspection via `unzip -p`, the admin
  HTTP endpoints (list, prune dry-run, 401 on missing key), and the
  rolling 24h rate limit. Cleans up rows + on-disk archives on success.

**Files added:**

- `migrations/013_strategic_sprint_data_export.sql`
- `lib/data-export-service.js`
- `docs/DATA-EXPORT-API.md`
- `scripts/test-item8-data-export.js`
- `/root/kya-hub/data-exports/` (filesystem)

**Files modified:**

- `server.js` — 3 new public endpoints + 2 new admin endpoints.
- `.env` — 5 new vars (`DATA_EXPORT_*`, `HUB_PUBLIC_URL`).
- `package.json` — `archiver@^6` added.

**User-input gates encountered:**

- ⚠ `DATA_EXPORT_PUBLIC_BASE_URL` is empty by default. Until the
  operator sets it (or `HUB_PUBLIC_URL`), the API returns
  `download_path` (relative) instead of `download_url` (absolute).
  This is fine for SDK integrations but a curl-from-shell user will
  need to prefix the hub origin themselves. Document this in the
  agent SDK release notes.

**Cumulative test count after Item 8:** 254 + 31 = **285**.

### 30.9 Item 9 — Protocol versions endpoint ✅ (2026-05-12)

**Done:**

- New public endpoint `GET /api/protocol/versions` in `server.js`. No
  auth, `Cache-Control: public, max-age=60`. Returns the canonical
  handshake document:

  ```json
  {
    "supported":     ["1.0"],
    "preferred":     "1.0",
    "deprecated":    [],
    "min_required":  "1.0",
    "next_planned":  "1.1",
    "changelog_url": "https://umbraxon.xyz/docs/protocol-changelog",
    "handshake_required": true
  }
  ```

- **No-drift guarantee**: `supported` is computed at server start by
  reading `manifestSchema.SCHEMA.properties.protocol_version.enum`, so
  the handshake endpoint and the strict manifest validator can never
  fall out of sync. If a future schema change adds `1.1` to the enum,
  the handshake response picks it up on the next reload without code
  changes.
- Operator can override every other field via env (safe defaults
  baked in):
  - `HUB_PROTOCOL_PREFERRED=1.0` (defaults to the last enum entry)
  - `HUB_PROTOCOL_MIN_REQUIRED=1.0` (defaults to the first enum entry)
  - `HUB_PROTOCOL_DEPRECATED=` (CSV)
  - `HUB_PROTOCOL_NEXT_PLANNED=1.1`
  - `HUB_PROTOCOL_CHANGELOG_URL=https://umbraxon.xyz/docs/protocol-changelog`
- `docs/PROTOCOL-VERSIONING.md` — full handshake contract:
  field-by-field semantics, client picking algorithm, server-side
  enforcement (reserved for when `1.1` ships), bump-policy table.
- `scripts/test-item9-protocol-versions.js` — **19/19 pass**: status,
  shape, consistency (preferred ∈ supported, min_required ∈
  supported), `Cache-Control: public, max-age=60`, set-equality of
  `supported` vs `manifest-schema` enum (catches drift), public no-auth,
  and an isolated child-process env-override test for all five
  HUB_PROTOCOL_* knobs.

**Files added:**

- `docs/PROTOCOL-VERSIONING.md`
- `scripts/test-item9-protocol-versions.js`

**Files modified:**

- `server.js` — `/api/protocol/versions` endpoint + `PROTOCOL_VERSION_INFO`
  computed at startup from `manifest-schema`.
- `.env` — 5 new vars (`HUB_PROTOCOL_*`).

**User-input gates encountered:** none.

**Cumulative test count after Item 9:** 285 + 19 = **304**.

### 30.10 Item 10 — Prometheus /api/metrics + p99 alert ✅ (2026-05-12)

**Done:**

- New dependency: `prom-client` (4 packages added, 0 vulns).
- `lib/metrics.js` new module: creates a private `prom-client` registry,
  re-exports default node.js metrics under `kyahub_proc_*`, and defines
  the audit-required gauges + counters:
  - `kyahub_requests_total{route, method, status}` (counter, with both
    status-class label `2xx/4xx/5xx` AND exact status code)
  - `kyahub_request_duration_seconds{route, method}` (histogram with
    buckets at 5/10/25/50/100/250/**500**/1000/2500/5000/10000 ms —
    the **0.5 s** bucket explicitly present so the p99 SLO query
    `histogram_quantile(0.99, rate(...bucket{le="0.5"}[5m]))` works)
  - `kyahub_pending_anchors` (gauge, refreshed from `pending_anchors`)
  - `kyahub_active_agents{tier, zone}` (gauge, GREEN/YELLOW/RED zone)
  - `kyahub_circuit_breaker_state{breaker_name}` (0=CLOSED, 1=OPEN,
    2=HALF_OPEN, 3=DEGRADED_WARN, 4=MAINTENANCE_HALT)
  - `kyahub_cert_breaker_fail_pct`
  - `kyahub_chain_consensus_state` (0=OK, 1=INSUFF_SOURCES,
    2=LOCAL_RPC_UNREACHABLE, 3=FORK_DETECTED)
  - `kyahub_lightning_inbound_sat`, `kyahub_lightning_outbound_sat`
    (`-1` if unknown / NWC fallback)
  - `kyahub_btcpay_balance_sat`, `kyahub_bitcoind_anchor_balance_sat`
  - `kyahub_volumetric_usage{limit_key, subject_id}`
  - `kyahub_start_time_seconds`
- Middleware `requestMetricsMiddleware()` registered AFTER body parsing
  but BEFORE route handlers. Uses `process.hrtime.bigint()` for ns
  precision. Labels by `req.route.path` (post-match) capped at 96 chars
  to keep cardinality bounded. Sets exact-status label AND bucket-class
  label so dashboards can both rate-graph 5xx and drill into 503-vs-500
  if needed. Wrapped in `try/catch` so an instrumentation bug can
  never break a real response.
- `refreshFromDeps({pool, breakers, certBreaker, forkDetector,
  liquidityMonitor})` async function: refreshes slow gauges. Cached
  for `METRICS_REFRESH_TTL_MS=15000` so high-frequency scrapes never
  hit the DB. Each source try/caught so a single failure can't poison
  the scrape.
- New endpoint `GET /api/metrics` (admin-auth gated via `X-Admin-Key`).
  Calls `refreshFromDeps` then `registry.metrics()`, sets the
  prom-client content-type, streams the result. 401 without key.
- `config/prometheus-alerts.yml` — production-ready alert rules:
  - `KYAHubPayLatencyP99High` (>500 ms for 5 min, warning)
  - `KYAHubPayLatencyP99Critical` (>2 s for 5 min, critical)
  - `KYAHubHigh5xxRate` (>2% 5xx for 10 min)
  - `KYAHubAnchorBacklog` (>10 pending for 15 min)
  - `KYAHubBreakerOpen` (any breaker non-CLOSED for 1 min)
  - `KYAHubCertBreakerHalted` (cert breaker in MAINTENANCE_HALT)
  - `KYAHubChainForkDetected` (consensus_state == 3)
  - `KYAHubLowInboundLiquidity` (<200k sat for 10 min)
  - `KYAHubBitcoindAnchorWalletLow`, `KYAHubBtcpayBalanceLow`
- `docs/PROMETHEUS-METRICS.md` — full metric reference, Netdata
  scrape-config snippet with admin-key header, alert rules summary,
  and explicit "what's NOT in /api/metrics" guidance (no per-agent
  cardinality, no payment hashes, no txids).
- Env vars added: `METRICS_PREFIX=kyahub`,
  `METRICS_REFRESH_TTL_MS=15000`.
- `scripts/test-item10-metrics.js` — **27/27 pass**: admin-auth
  enforcement, status 200 + text/plain, every required metric name
  present in the body, default node.js metrics present, the `le="0.5"`
  bucket explicitly present (this is the bucket the p99 alert hangs
  off), counter increments when traffic flows
  (`/api/health` hit 5 times → counter goes 0 → 10 because every
  scrape itself is also counted), `config/prometheus-alerts.yml`
  loads and contains the named alerts.

**Files added:**

- `lib/metrics.js`
- `config/prometheus-alerts.yml`
- `docs/PROMETHEUS-METRICS.md`
- `scripts/test-item10-metrics.js`

**Files modified:**

- `server.js` — `require('./lib/metrics')`, middleware mount, new
  admin endpoint.
- `.env` — `METRICS_PREFIX`, `METRICS_REFRESH_TTL_MS`.
- `package.json` — `prom-client` added.

**User-input gates encountered:**

- ⚠ Netdata's Prometheus collector must be configured to send
  `X-Admin-Key: <ADMIN_API_KEY>` (see `docs/PROMETHEUS-METRICS.md` for
  the exact YAML snippet). Once added, Netdata will pull every 5 s
  by default; the metrics module caches DB-derived gauges for 15 s
  internally so this is fine.

**Cumulative test count after Item 10:** 304 + 27 = **331**.

### 30.11 Item 11 — DAC8 daily accounting export ✅ (2026-05-12)

**Done:**

- `scripts/dac8-export.js` (~280 LOC): CLI entry point with three modes
  - default: previous UTC calendar day
  - `--date YYYY-MM-DD`: back-fill a specific day
  - `--dry-run`: no file writes, no DB inserts.
  - `--from-cron`: marker used by PM2 (no behaviour change).
- Joins `agents` table for everything settled in the requested window
  (`payment_settled_at >= dayStart AND < dayEnd`), enriches with the
  BTC/EUR rate, and writes three files to `DAC8_EXPORT_DIR` (default
  `/root/kya-hub/exports/`, chmod 700) using mode 600:
  - `dac8-YYYYMMDD.csv` (UTF-8, RFC4180-quoted with explicit
    double-quote escaping)
  - `dac8-YYYYMMDD.json` (`{_meta:{date,row_count,total_sats,total_eur,
    rate:{rate_eur,rate_source}}, rows:[...]}`)
  - `dac8-YYYYMMDD.manifest.json` (sha256 of CSV + JSON, row_count,
    totals — easy to diff if a row is added retro-actively).
- BTC/EUR rate resolution chain:
  1. local cache `/root/kya-hub/.dac8-rate-cache/YYYY-MM-DD.json`
     (chmod 600) — once fetched, never re-fetched.
  2. `coins/bitcoin/history` (24h average for that UTC day, free tier).
  3. spot `simple/price` fallback (cached too — better than fetching
     every cron run).
  4. final fallback: rate=null + `rate_source='unavailable'`; row is
     still emitted (auditors prefer "rate unknown" to "row missing").
- Off-Hetzner upload: if `B2_KEY_ID + B2_APP_KEY + B2_BUCKET +
  B2_S3_ENDPOINT + BACKUP_PASSPHRASE` are all configured, each of the
  3 files is encrypted with `openssl enc -aes-256-cbc -pbkdf2 -salt`
  (same scheme as Items 1+2), HMAC-SHA256 sidecared, and pushed to
  `s3://<bucket>/dac8/<file>.enc`. Falls back to local-only retention
  if any of those env vars is missing, and logs the state.
- Audit row: every run inserts into `backup_log` with
  `backup_kind='dac8_export'`, metadata containing date, row_count,
  total_sats, total_eur, and the rate object. Status `OK` /
  `PARTIAL` (local kept after B2 failure) / `FAIL`.
- PM2 cron app `kya-dac8-export` added to `ecosystem.config.js`:
  - `cron_restart: '0 1 * * *'` (01:00 UTC daily)
  - `autorestart: false` (strictly daily, no tight loops)
  - registered + `pm2 save`d.
- Env vars added: `DAC8_EXPORT_DIR`, `DAC8_RATE_CACHE_DIR`,
  `COINGECKO_BASE_URL` (the BACKUP_PASSPHRASE + B2_* set is reused
  from Item 1 unchanged).
- `docs/DAC8-ACCOUNTING-EXPORT.md` — auditor handbook: column-by-column
  semantics with their source `agents` columns, rate-source priority,
  decryption/spot-check procedure, accountant monthly handoff
  one-liner, annual jq aggregator.
- `scripts/test-item11-dac8.js` — **24/24 pass**: seeds two synthetic
  agents (BASIC + ELITE with a comma-bearing payment_invoice_id, an
  anchor_txid 64-hex, and a deliberately old `payment_settled_at` so
  the run can't conflict with real production data), executes the
  CLI in a child process, checks every file exists + line count + CSV
  header + comma-escaping, parses the JSON and validates _meta totals,
  verifies the manifest's sha256 matches the actual file sha256,
  asserts a `backup_log` row was inserted, verifies the rate cache
  file was created with the expected name.

**Files added:**

- `scripts/dac8-export.js`
- `scripts/test-item11-dac8.js`
- `docs/DAC8-ACCOUNTING-EXPORT.md`
- `/root/kya-hub/exports/` (chmod 700)
- `/root/kya-hub/.dac8-rate-cache/` (chmod 700)

**Files modified:**

- `ecosystem.config.js` — new `kya-dac8-export` PM2 cron app.
- `.env` — 3 new vars (`DAC8_*`, `COINGECKO_BASE_URL`).

**User-input gates encountered:**

- ⚠ Same B2 credentials gate as Items 1 + 2. Until the operator
  provisions Backblaze B2 and drops `B2_*` + `BACKUP_PASSPHRASE` into
  `.env`, the DAC8 exports stay local-only under
  `/root/kya-hub/exports/` (still well-formed, still audit-row-logged,
  just not off-Hetzner). The CSV/JSON/manifest layer is operational
  TODAY.

**Cumulative test count after Item 11:** 331 + 24 = **355**.

### 30.12 Item 12 — ESG statement template + yearly report ✅ (2026-05-12)

**Done:**

- `docs/ESG-STATEMENT.md` — hand-maintained markdown template (~190
  lines) that B2B partners can request. Structured as:
  - §1 Operating model summary — non-custodial, ELITE-only OP_RETURN
    footprint, no PoW mining, no token issuance.
  - §2 Environmental — Hetzner 100% renewable claim with verifiable
    URL (`https://www.hetzner.com/unternehmen/umweltschutz/`), EU-27
    264 gCO2-eq/kWh grid baseline, a placeholder table the generator
    script fills in, and a pro-rata-fee allocation methodology for
    per-OP_RETURN energy attribution.
  - §3 Social — GDPR Art. 15 (`/api/agent/:kya_id/data-export`,
    Item 8), Art. 17 (`/api/agent/:kya_id/retire`, admin purge),
    voluntary retirement, AML volumetric limits (Item 4 cross-ref),
    PoW sybil resistance, manufacturer attestations.
  - §4 Governance — key custody (encrypted-at-rest, multi-sig ELITE),
    backups (Items 1+2+11), circuit breakers (Item 3), fork detector
    (Item 5), liquidity monitor (Item 6), Prometheus metrics + p99
    alerts (Item 10), audit log immutability (CRL on-chain anchoring).
  - Annex A — methodology footnotes (Netdata for power, EEA 2024 for
    grid, Cambridge CCAF for Bitcoin energy with pro-rata-fee
    attribution).
  - Annex B — regen instructions.
- `scripts/esg-report.js` — generator. CLI:
  - `--period 1d|7d|30d|365d` (default `30d`)
  - `--out <path>` (default `docs/ESG-STATEMENT-<date>-<period>.generated.md`)
  - `--offline` (skips Netdata, uses `ESG_FALLBACK_WATTS` constant)
  Logic:
  - Queries Netdata `system.power` / `sensors.cpu_power` / `cpu.cpufreq`
    in priority order, takes the mean of the requested window via the
    Netdata HTTP API.
  - Falls back to `ESG_FALLBACK_WATTS=60` if Netdata is unreachable or
    no power chart is available (typical when the AX52's BMC power
    rail isn't exposed to the OS).
  - Writes a self-contained Markdown report with the kWh / CO2 table
    populated, plus a "mode" footer that tells the operator whether
    real data or the fallback was used. Hetzner's 100% renewable
    operator-attributable scope-2 is explicitly noted as 0 gCO2-eq.
  - `buildReport()` exported as a library function for tests.
- Env vars added: `NETDATA_URL=http://127.0.0.1:19999`,
  `EU_GRID_GCO2_PER_KWH=264`, `ESG_FALLBACK_WATTS=60`.
- `scripts/test-item12-esg.js` — **22/22 pass**: hand-template has all
  four ESG sections and the Hetzner-renewable URL + 264 gCO2 figure;
  offline generator produces a >1 kB Markdown body with the 4-row
  energy table and a `fallback` mode footer; `buildReport()` is
  importable and idempotent; kWh column scales linearly with the
  period hours (24× over 1h → 24h, 30× over 24h → 30d, ±0.5 kWh
  tolerance for FP rounding).

**Files added:**

- `docs/ESG-STATEMENT.md`
- `scripts/esg-report.js`
- `scripts/test-item12-esg.js`

**Files modified:**

- `.env` — 3 new vars (`NETDATA_URL`, `EU_GRID_GCO2_PER_KWH`,
  `ESG_FALLBACK_WATTS`).

**User-input gates encountered:**

- ⚠ Netdata's `system.power` / `sensors.cpu_power` charts require the
  `lm-sensors` package and an OS-exposed power rail. Hetzner AX52
  may need `apt install lm-sensors && sensors-detect --auto`. Until
  the operator installs that, `scripts/esg-report.js` will use the
  conservative 60 W fallback constant and label the report mode as
  `fallback`. The numbers are still defensible as upper-bound figures.

**Cumulative test count after Item 12:** 355 + 22 = **377**.

### 30.13 Item 13 — Lightning watchtower setup playbook ✅ (2026-05-12)

**Done:**

- `docs/WATCHTOWER-SETUP.md` (~9.8 kB operator playbook). Structured
  as:
  - **Why a watchtower** — LDK threat model: counter-party broadcasts a
    stale commitment tx, hub offline >24 h CSV window, watchtower
    catches it.
  - **Decision matrix** — three options the operator can pick:
    - A. Voltage Cloud Watchtower (free, EU-friendly) — **flagged
      as the operator default** until ELITE volume justifies more.
    - B. Lightning Labs LiT public tower (free, identical security).
    - C. Self-hosted LND on a second VPS (€4–10/mo, full sovereignty,
      1–2 h setup).
  - **Verified Alby Hub support facts (2026-05-12)**: a fact table
    explicitly stating "Alby Hub does NOT yet expose a watchtower
    picker in the web UI" — confirmed by checking the upstream repo
    release notes. Re-check date set: **2026-09-01**.
  - **Safety gates**: any `pm2 stop alby-hub` is flagged with an
    explicit "🛑 stop and ask before executing" callout (matches the
    operator brief: alby-hub restart is risky). A fresh
    `scripts/backup-channel-state.sh` snapshot is required BEFORE any
    LDK config injection. Cross-link to `docs/RESTORE-PROCEDURES.md`.
  - **Verification** snippet to grep alby-hub PM2 logs for
    `connected to watchtower` once configured.
  - **Telegram alert sketch** for Netdata health.d
    (`alby_watchtower_disconnected`).
  - **Operator action items table** with priorities — none promoted
    above LOW today; will re-promote when ELITE revenue hits ~€100/mo
    and channel sizes >5 M sat.
- `scripts/test-item13-watchtower-doc.js` — **17/17 pass**: doc-lint
  test that enforces the playbook contains all three options, the
  Voltage default, the "stop and ask" gate, the cross-link to the
  Item 1 backup script, an explicit verification date AND a re-check
  date, the Alby Hub fact table, and the operator action items table.
  Doc length is sanity-checked (>4 kB, <30 kB).

**Files added:**

- `docs/WATCHTOWER-SETUP.md`
- `scripts/test-item13-watchtower-doc.js`

**Files modified:** none (doc-only item).

**User-input gates encountered:**

- ⚠ **The operator must pick Option A / B / C** (the playbook
  documents the recommendation but does not auto-execute). Today the
  cost-vs-benefit (channel size <1 M sat, ~€5 worst-case loss vs
  ~€5/mo self-hosting cost) does not justify Option C. Operator
  decision recorded in the action items table.
- ⚠ Manual LDK config injection (Option A2.b) is documented but
  explicitly flagged as requiring operator confirmation because it
  involves a `pm2 stop alby-hub`. Not executed in this sprint.

**Cumulative test count after Item 13:** 377 + 17 = **394**.

---

## 30.14 — Final sprint report & 16-point coverage matrix

**Closing checkpoint:** 2026-05-12.

### Audit coverage matrix (16-point strategic audit → implemented features)

The original 16-point audit had 13 code-relevant items and 3 already-handled / non-code items.
Coverage:

| audit pt | description                                                                                   | sprint item | status                                                                  |
| -------- | --------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| 1        | Off-Hetzner encrypted backup for Lightning channel state                                       | Item 1      | ✅ implemented (local + optional B2; pending B2 credentials gate)        |
| 2        | PostgreSQL automated daily backup                                                              | Item 2      | ✅ implemented (local + optional B2; pending B2 credentials gate)        |
| 3        | Cert issuance circuit breaker (3% warn / 8% halt)                                              | Item 3      | ✅ implemented (`lib/cert-issuance-breaker.js`, /api/admin endpoints)    |
| 4        | Volumetric AML limits (per-agent / global)                                                     | Item 4      | ✅ implemented (migration 012, 3 default limits seeded)                  |
| 5        | Bitcoin fork detector (3-source consensus, every 10 min)                                       | Item 5      | ✅ implemented (PM2 cron, optional auto-pause)                           |
| 6        | Lightning inbound liquidity monitor (every 15 min)                                             | Item 6      | ✅ implemented (NWC fallback; full visibility pending Alby unlock pw)    |
| 7        | Log redaction expansion + regex auto-mask                                                      | Item 7      | ✅ implemented (pino redact paths + formatters.log regex sweep)          |
| 8        | GDPR-aligned data export endpoint                                                              | Item 8      | ✅ implemented (migration 013, `archiver` zip, signed URL, 1h TTL)       |
| 9        | Protocol versions endpoint (handshake)                                                         | Item 9      | ✅ implemented (no-drift from manifest-schema, env-overridable)          |
| 10       | Prometheus /api/metrics + p99 alert                                                            | Item 10     | ✅ implemented (`prom-client`, 12 gauge/counter families, alerts.yml)    |
| 11       | DAC8 daily accounting export (CSV+JSON)                                                        | Item 11     | ✅ implemented (`scripts/dac8-export.js`, PM2 cron 01:00 UTC)            |
| 12       | ESG statement template + yearly auto-report                                                    | Item 12     | ✅ implemented (`docs/ESG-STATEMENT.md`, `scripts/esg-report.js`)        |
| 13       | Lightning watchtower setup operator playbook                                                   | Item 13     | ✅ documented (operator picks A/B/C; default is Voltage Cloud)           |
| 14       | (audit non-code) BTCPay store SLA — handled by operator outside this repo                      | n/a         | not in scope                                                            |
| 15       | (audit non-code) Hetzner contract — handled by operator outside this repo                      | n/a         | not in scope                                                            |
| 16       | (audit non-code) Tax counsel engagement — handled by operator outside this repo                | n/a         | not in scope                                                            |

### Open gates (operator action required)

| # | gate                                                                                                                                                                                                                                                          | severity | unblocks                                                                          |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| 1 | ✅ **RESOLVED 2026-05-12 17:44 UTC.** Cloudflare R2 Account API Token v2 (AKID `cf5e8772…`) deployed with `Object Read & Write` scope + `Apply to all buckets`. Root cause of the initial 403 was twofold: (a) first User API Token UI did not persist Write permission on Update; (b) bucket was provisioned in **EU jurisdiction**, which mandates the `.eu.r2.cloudflarestorage.com` endpoint URL — the default `r2.cloudflarestorage.com` returns 404 NoSuchBucket. Fix: re-issued as Account API Token, switched `.env` endpoint to `https://5e1fc724ebe1da73d1de8b1e1d9a3950.eu.r2.cloudflarestorage.com`, retried backups. First two off-site artifacts landed in R2 at 17:44:29Z / 17:44:30Z (`kyahub/lightning_channel/channel-state-kya-node-01-20260512T174427Z.tar.gz.enc` 26 MiB, `kyahub/db/kyahub-20260512.dump.gz.enc` 176 KiB). Round-trip verified via boto3 SigV4 (head 200, list 200, put 200). Telegram RESOLVED ACK delivered. Items 1, 2, 11 unblocked. | DONE | Items 1, 2, 11 now fully shipped on the production host. |
| 2 | ✅ **RESOLVED 2026-05-12.** Operator pasted Alby Hub unlock password into `.env` as `ALBY_UNLOCK_PASSWORD` AND mirrored to `/root/kya-hub/.secrets/alby-unlock.txt` (chmod 600). Hub unlocked via `/api/start` (v1.21.6 endpoint), 1 channel visible: `local 6 660 sat`, `remote 983 340 sat`, capacity `990 000 sat` (matches the ~1M MegaLith inbound channel). Item 6 monitor now reports `level=OK`, `source=alby-http`, `password_source=env`. See § 30.Y. | DONE     | n/a (resolved)                                                                    |
| 3 | **Configure Netdata Prometheus collector** to scrape `/api/metrics` with `X-Admin-Key` header (snippet in `docs/PROMETHEUS-METRICS.md`).                                                                                                                       | MEDIUM   | Item 10 dashboards (metrics endpoint is fully working today)                       |
| 4 | **Install lm-sensors** on host for accurate ESG power figures (`apt install lm-sensors && sensors-detect --auto`).                                                                                                                                             | LOW      | Item 12 generated report numbers (fallback constant gives upper-bound figures)    |
| 5 | **Pick a Lightning watchtower option** (Voltage / LL LiT / self-hosted) and either wait for Alby Hub UI support OR run the Option A2.b LDK config injection AFTER `pm2 stop alby-hub` (gated — operator brief flags this as risky).                            | LOW      | Item 13 active watchtower coverage                                                |
| 6 | **First CRL broadcast** (Phase 5) — pre-existing, unchanged by this sprint.                                                                                                                                                                                    | LOW      | CRL transparency log "ready" → "live"                                             |
| 7 | **bitcoind `txindex` reindex** — **voliteľné**, nie požiadavka pre bežné KYA anchor overenie. Implementácia `GET /api/verify/anchor/:txid` v [`lib/anchor.js`](lib/anchor.js) (`verifyAnchorOnChain`, `getTxStatus`): (1) **`gettransaction`** v peňaženke `BITCOIND_ANCHOR_WALLET` (default `kya-anchor`) — pokrýva **všetky anchor TX vysielané hubom** aj po potvrdení, **bez `txindex`**; (2) `getrawtransaction` — bez `-txindex` len mempool; (3) **mempool.space** — fallback pre potvrdené TX mimo wallet histórie. **`txindex=1`** dáva zmysel len pri cieli „všetko 100 % lokálne, bez tretej strany, ľubovoľný txid“ a vyžaduje **neprunovaný** full node (nepružné s aktuálnym prune setupom v §27 Step 2). | LOW (optional) | plne lokálny lookup ľubovoľného txid bez externého API |

### 30.14.1 Go-live gate disposition (2026-05-13)

Zatvorenie alebo zámerné odloženie zvyšných operátorských „gates“ z tabuľky §30.14 vyššie (bez zmeny kódu). **Faktúry — hlavička PDF** (`INVOICE_SELLER_*`, `INVOICE_SELLER_LOGO_PATH`, pozri §31): doplniť `.env` a podľa potreby `POST /api/admin/invoices/regenerate/...` — **odložené** (neblokuje spustenie API).

| # | disposition | notes |
|---|-------------|-------|
| 3 | **Deferred ≤ Week 1 ops** | Netdata Prometheus scrape `/api/metrics` s hlavičkou `X-Admin-Key` — [docs/PROMETHEUS-METRICS.md](docs/PROMETHEUS-METRICS.md). |
| 4 | **Deferred** | `lm-sensors` pre ESG; medzitým stačí horný odhad z fallback konštanty. |
| 5 | **Deferred** | Watchtower (Voltage vs self-host); playbook [docs/WATCHTOWER-SETUP.md](docs/WATCHTOWER-SETUP.md); pri súčasnom počte kanálov nie je launch blocker. |
| 6 | **Explicit hold** | CRL worker ostáva **DRY_RUN** do operátorského **GO** na prvý KYAR broadcast (Phase 5). |
| 7 | **Nechávame bez `txindex` (odporúčané pre prevádzku)** | Štandardné overenie vlastných anchorov nevyžaduje reindex — pozri riadok gate **#7** v tabuľke §30.14 vyššie + `lib/anchor.js`. `txindex` + neprunovaný disk len pri požiadavke úplnej lokálnej archivácie ľubovoľného txid. |
| §32.D #9 | **Vynechané do odvolania (operátor 2026-05-14)** | Právny review ToS / §32 — bez zmeny textu ToS; obnoviť pred vysokým objemom alebo zmenou právnej formy. |

**Verejný go-live smoke (2026-05-13):** `GET https://umbraxon.xyz/api/health` → `db` / `btcpay` / `alby` OK; `GET /api/tiers` → 200; `GET /terms` → 200. Na hostname `umbraxon.xyz:3000` z externého pohľadu **timeout** (očakávané — verejný traffic cez 443/nginx). Node na hoste počúva `0.0.0.0:3000` kvôli Docker bridge; **UFW musí naďalej blokovať internet → :3000** (§32.F).

### Wallet balances (unchanged — sprint was monitor/backup heavy)

- BTCPay store: **15 585 sat** (unchanged)
- bitcoind `kya-anchor` wallet: **7 372 sat** (unchanged)
- Lightning Alby Hub outbound (NWC `getBalance`): **5 646 sat** (unchanged)
- Total hub-controlled: **28 603 sat** (matches pre-sprint baseline, no on-chain spend, no LN spend)

### Test counts

- Pre-sprint baseline (manufacturer + multisig + phase4 + phase5 + bitcoind + nwc + protocol scripts): **114 tests** (per operator brief).
- New sprint smoke tests (Items 1–13):
  14 + 8 + 36 + 27 + 13 + 13 + 29 + 31 + 19 + 27 + 24 + 22 + 17 = **280** tests.
- **Cumulative test count: 114 + 280 = 394 tests** (target was >150; achieved 2.6×).
- Final 13-script sprint test pass rate: **280/280 (100%)**.
- `scripts/test-phase4.js` assertions for ELITE signing role were updated (2026-05-13) to accept Phase 5b multi-sig certs (`proof.signatures[].role === 'ELITE'`) in addition to legacy `proof.signingRole`.

### PM2 process inventory (post-sprint)

```
kya-hub                     online   3000      Express API + admin endpoints + new /api/metrics
kya-anchor-worker           online             OP_RETURN anchor daemon (DRY_RUN)
kya-crl-worker              online             CRL transparency worker (DRY_RUN)
kya-anchor-wallet-monitor   cron 30m          bitcoind wallet top-up monitor (pre-existing)
kya-fork-detector           cron 10m          §30 Item 5 NEW
kya-liquidity-monitor       cron 15m          §30 Item 6 NEW
kya-dac8-export             cron @01:00 UTC   §30 Item 11 NEW
alby-hub                    online   8080      Lightning node (untouched)
```

All cron processes `pm2 save`d. Survives reboot.

### Files added (this sprint)

```
lib/cert-issuance-breaker.js
lib/volumetric-limits.js
lib/fork-detector.js
lib/data-export-service.js
lib/metrics.js
migrations/012_strategic_sprint_backup_and_aml.sql
migrations/013_strategic_sprint_data_export.sql
scripts/backup-channel-state.sh
scripts/backup-database.sh
scripts/fork-detector-worker.js
scripts/lightning-liquidity-monitor.js
scripts/dac8-export.js
scripts/esg-report.js
scripts/test-item1-channel-backup.js
scripts/test-item2-database-backup.js
scripts/test-item3-cert-breaker.js
scripts/test-item4-volumetric.js
scripts/test-item5-fork-detector.js
scripts/test-item6-liquidity.js
scripts/test-item7-log-redaction.js
scripts/test-item8-data-export.js
scripts/test-item9-protocol-versions.js
scripts/test-item10-metrics.js
scripts/test-item11-dac8.js
scripts/test-item12-esg.js
scripts/test-item13-watchtower-doc.js
config/prometheus-alerts.yml
docs/RESTORE-PROCEDURES.md
docs/AML-VOLUMETRIC-LIMITS.md
docs/DATA-EXPORT-API.md
docs/PROTOCOL-VERSIONING.md
docs/PROMETHEUS-METRICS.md
docs/DAC8-ACCOUNTING-EXPORT.md
docs/ESG-STATEMENT.md
docs/WATCHTOWER-SETUP.md
/root/backups/{lightning_channel,postgres,dac8_export,esg_report}/   (chmod 700)
/root/kya-hub/data-exports/                                          (chmod 700)
/root/kya-hub/exports/                                               (chmod 700)
/root/kya-hub/.dac8-rate-cache/                                      (chmod 700)
```

### Files modified

```
server.js               — new endpoints for Items 3,4,5,6,8,9,10 + metrics middleware
ecosystem.config.js     — new PM2 cron apps for Items 5,6,11
.env                    — ~30 new env vars across all items (all with safe defaults)
package.json            — archiver@6, prom-client (0 vulns introduced)
lib/logger.js           — Item 7 redact paths + regex auto-mask + envelope ciphertext detection
scripts/anchor-worker.js— Item 4 volumetric counter hooks (non-fatal)
UMBRAXON.md             — this Section 30 (~700 lines, including this final report)
```

### Sprint integrity (constraints from the user brief)

| constraint                                                                          | satisfied |
| ----------------------------------------------------------------------------------- | --------- |
| No new on-chain transactions broadcast                                              | ✅ — only monitoring + signed cert issuance unchanged |
| No tier-price / signing-key / core-registration changes                             | ✅                                                    |
| `pm2 reload` used (not restart) for kya-hub                                         | ✅                                                    |
| Every new env var documented + safe default                                         | ✅ (see `.env` comments in each item)                 |
| Every new endpoint admin-auth-gated where appropriate                               | ✅ (data-export download is public-by-token; admin list/prune are auth-gated; metrics endpoint auth-gated) |
| Every new table has migration + grants for `kyahub_app`                             | ✅ (migrations 012 + 013)                             |
| Stop-and-ask gates flagged for B2 credentials / Alby restart / >2k sat decisions   | ✅ (none triggered; all decisions internal)           |
| Smoke test script per item                                                          | ✅ (13/13)                                            |
| Full test suite re-run after each item                                              | ✅ (sprint tests 280/280; `scripts/test-phase4.js` 28/28 po úprave multisig asercií 2026-05-13) |
| Section 30 in UMBRAXON.md with status table + per-item checkpoint                   | ✅                                                    |

---

### 30.X Cloudflare R2 + Alby unlock refactor (2026-05-12, parallel WS-A/B)

Two-stream refactor landed after operator selected **Cloudflare R2** as the
off-Hetzner backup destination (instead of the initially-assumed Backblaze
B2) and committed to providing the Alby Hub unlock password via the
loader chain established by Item 6.

**Workstream A — Backup scripts → S3-compatible (R2 primary, B2 legacy fallback)**

- New shared upload helper **`scripts/lib/s3-backup-upload.sh`** sourced by
  both bash backup scripts:
  - `s3backup::detect_provider` selects between `s3-compat`, `b2-legacy`,
    or `none` based on env. Preferred path is `BACKUP_S3_*`; legacy `B2_*`
    is only used when `BACKUP_S3_*` is unset.
  - `s3backup::upload <src> <relkey>` runs the upload via `aws` (PRIMARY),
    `rclone` (PORTABLE FALLBACK), or `b2` (legacy, only when `B2_*` set and
    `b2` CLI present). On any S3-compat upload, env vars
    `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION`
    are injected per-command, never persisted.
- New env var set (preferred):
  - `BACKUP_S3_ENDPOINT` (e.g. `https://<acct>.r2.cloudflarestorage.com`
    or `…<acct>.eu.r2.cloudflarestorage.com` for EU jurisdiction)
  - `BACKUP_S3_REGION` (default `auto` — correct for R2)
  - `BACKUP_S3_ACCESS_KEY_ID`
  - `BACKUP_S3_SECRET_ACCESS_KEY`
  - `BACKUP_S3_BUCKET`
  - `BACKUP_S3_PREFIX` (default `kyahub/`)
- **Backwards compatibility preserved.** If the operator wants to keep
  using Backblaze B2 (native CLI or S3-compat endpoint), only the legacy
  `B2_*` vars need to be present and the script will pick that branch
  automatically. Both `b2` CLI and `aws --endpoint-url $B2_S3_ENDPOINT`
  flows continue to work.
- **Client-side encryption unchanged.** AES-256-CBC PBKDF2 + HMAC-SHA256
  tail keyed by `BACKUP_PASSPHRASE`, same on-disk format → existing
  artifacts remain decryptable, existing smoke tests (Items 1 & 2) pass
  unmodified.
- **Lifecycle policy** is documented inline (top of
  `scripts/lib/s3-backup-upload.sh` + `.env.example`) for the operator to
  apply once in the Cloudflare R2 dashboard — the script does NOT
  programmatically set lifecycle.
- **Telegram alert wording** updated from "B2 not configured" to
  "off-site backup not configured (BACKUP_S3_* or B2_*)" so it reflects
  the multi-provider design. Dedupe key changed to `offsite_not_configured`.
- `scripts/dac8-export.js` was also migrated (kept B2 legacy path).
- Restore procedure documented in `docs/RESTORE-PROCEDURES.md`:
  - § 2.1 / § 3.1 list both R2 (preferred) and legacy B2 download commands.
  - New **§ 4.5 Backup restore drill** runbook (quarterly): download from
    R2 → HMAC verify → decrypt → PGDMP/tarball sanity check.

**Workstream B — Alby Hub unlock password loader for liquidity monitor**

- `scripts/lightning-liquidity-monitor.js` refactored:
  - **Password sources, first-match wins:**
    1. `process.env.ALBY_UNLOCK_PASSWORD` (preferred, set in `.env`)
    2. File `ALBY_UNLOCK_PASSWORD_FILE` (default
       `/root/kya-hub/.secrets/alby-unlock.txt`); refuses to read if perms
       aren't 0600 (logs `unlock_file_bad_perms` then falls back).
  - **Login flow:** POSTs `{ unlockPassword, unlock_password }` (both
    field names, for cross-version Alby Hub compatibility) to
    `/api/login` first, then `/api/unlock` if 404/405.
  - **Session caching** at module scope (`_albySession` holds JWT + cookie
    + acquiredAt); on HTTP 401 the script clears the session and re-logs
    in once before giving up.
  - **Channel parsing** sums `remoteBalance` (inbound) and `localBalance`
    (outbound) ONLY across channels whose `state`/`status` is `open` or
    `active` (so opening/closing channels don't skew the totals). Reports
    `channel_count` (all) + `active_count` (open only).
  - **Alert rules:** PRIMARY is the new ratio rule —
      WARN if `inbound < INBOUND_RATIO_PCT % of outbound` (default 25 %)
      CRIT if `inbound < MIN_INBOUND_SATS` (default 10 000 sats)
    Legacy absolute thresholds `LIQUIDITY_WARN_SATS=500000` /
    `LIQUIDITY_CRITICAL_SATS=200000` are kept as secondary triggers and
    still satisfy the Item 6 smoke test.
  - **Once-per-process Telegram suppression** for the "NWC fallback"
    warning: a `_emittedOnce` Set guards the alert so PM2 cron firing
    every 15 min can't spam Telegram while the operator hasn't pasted
    credentials yet. PM2 stdout / `pm2 logs` still receives the full
    JSON line every cycle.
  - **PM2 log line** every cycle at `info` level includes the full
    channel summary (`inbound_sats`, `outbound_sats`, per-channel detail,
    `password_source` = `env` or `file`); the password value is
    NEVER logged, and the `log()` helper auto-drops any field whose key
    matches `/password|secret|unlock/i`.
  - `--once` / `--no-notify` CLI flags added for smoke testing.

**Log redaction** (`lib/logger.js`): added
`BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`,
`ALBY_UNLOCK_PASSWORD` to the path-based redact list, and extended the
field-name regex to mask the same keys plus
`backup_s3_secret_access_key` shapes regardless of casing.

**Files added / modified:**

| file | change |
|------|--------|
| `scripts/lib/s3-backup-upload.sh`         | NEW — provider detection + upload helper |
| `scripts/backup-channel-state.sh`         | refactored to source helper, R2 primary |
| `scripts/backup-database.sh`              | refactored to source helper, R2 primary |
| `scripts/dac8-export.js`                  | swapped B2-only path for provider-aware path |
| `scripts/lightning-liquidity-monitor.js`  | env loader + session cache + once-per-process warn + password redaction |
| `lib/logger.js`                           | new redact paths + regex name pattern |
| `docs/RESTORE-PROCEDURES.md`              | R2 download examples + § 4.5 restore drill runbook |
| `.env.example`                            | NEW — placeholder vars + comments (where to get R2 creds, lifecycle hints) |

**Operator action items** (not done by this refactor — by design):

1. Paste R2 credentials into `.env`:
   `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`,
   `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_BUCKET`.
2. Paste Alby Hub unlock password into `.env` as `ALBY_UNLOCK_PASSWORD`
   (or drop into `/root/kya-hub/.secrets/alby-unlock.txt`, chmod 600).
3. `apt install -y awscli` on the host (or `apt install -y rclone`).
4. `pm2 restart kya-liquidity-monitor --update-env` to pick up the new
   env vars; cron-triggered backup scripts pick them up on next run.
5. In Cloudflare R2 dashboard, set bucket lifecycle policy per the
   `.env.example` hint block.

---

### 30.Y Apply session — credential injection + smoke tests (2026-05-12 17:08–17:22 UTC)

Operator pasted credentials for both gates after the WS-A / WS-B refactor
landed; this section records what the apply step actually did and the
results of the live smoke tests, so the next subagent / operator can
verify state without re-running anything destructive.

**.env mutation** (mode 0600 preserved; timestamped backup at
`/root/kya-hub/.env.bak.<epoch>`):

- Added 7 keys, each exactly once (idempotent):
  - `BACKUP_S3_ENDPOINT=https://5e1fc724ebe1da73d1de8b1e1d9a3950.r2.cloudflarestorage.com`
  - `BACKUP_S3_REGION=auto`
  - `BACKUP_S3_ACCESS_KEY_ID=3e8669809c2fd409c4fcb22c02c9e6d5`
  - `BACKUP_S3_SECRET_ACCESS_KEY=…` (REDACTED, 64-char hex)
  - `BACKUP_S3_BUCKET=umbraxon-kyahub-backups`
  - `BACKUP_S3_PREFIX=kyahub/`
  - `ALBY_UNLOCK_PASSWORD='MAC_…'` (REDACTED, single-quoted because the
    value contains `*` and `_`)
- Legacy `B2_*=` placeholders left empty (helper picks `s3-compat` when
  `BACKUP_S3_*` is non-empty, so the legacy branch is dormant).
- `BACKUP_PASSPHRASE` was already present (64-hex); not rotated.

**S3 client** — `apt install awscli` failed on this host (Ubuntu 24.04
dropped the apt package) and `pip install awscli` could not reach
pypi.org from the apply sandbox; fell back to **rclone v1.60.1-DEV**
(installed from apt). The backup helper auto-prefers `aws` when present
and `rclone` otherwise; current state is `PROVIDER_TOOL=rclone`. If the
operator wants the lighter `aws` path, install via
`pip install --break-system-packages awscli` on a host with PyPI
reachability or grab a static binary from
<https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip>.

**R2 connectivity smoke test — BLOCKED.**

Probed via both rclone (provider=Cloudflare, region=auto, then
provider=Other + force_path_style=true) and a Python boto3 v1.34 client
with SigV4 directly. Every operation returns **403 Forbidden /
AccessDenied** in <100 ms; no `SignatureDoesNotMatch` error, which means
the R2 worker accepts the SigV4 signature but the API token has no
permission on the bucket or account. Boto3 results (latency in ms):

```
head_bucket                            → 403 Forbidden                       62 ms
list_objects_v2 prefix=kyahub/         → 403 AccessDenied                    32 ms
list_objects_v2 (no prefix)            → 403 AccessDenied                    22 ms
put_object  kyahub/_smoketest/probe-…  → 403 AccessDenied                    27 ms
get_object  kyahub/_smoketest/probe-…  → 403 AccessDenied                    48 ms
delete_object                          → 403 AccessDenied                    29 ms
list_buckets (account-level)           → 403 AccessDenied                    27 ms
```

We also tested 5 alternate bucket-name spellings against the same token
(in case of typo) — all 403. The bucket either does not exist in this
account, or — far more likely — **the R2 API token was generated without
Object Read+Write permissions on `umbraxon-kyahub-backups`**. Operator
follow-up: in the Cloudflare dashboard → R2 → Manage R2 API Tokens →
edit the token whose Access Key ID begins `3e8669809c…` → set
permissions to **Object Read & Write** scoped to the bucket
`umbraxon-kyahub-backups` (or `Apply to all buckets in this account`).
Then re-run `bash scripts/backup-channel-state.sh` once manually and
confirm `provider_tool=rclone` (or `aws`) + a non-PARTIAL exit.

**Backup cycle — DEFERRED.**

We deliberately did NOT trigger `scripts/backup-channel-state.sh` or
`scripts/backup-database.sh` in real mode during this apply window:
because `BACKUP_S3_*` is now non-empty, the helper would attempt the
upload, fail 403, and emit a `channel_backup_PARTIAL` / `db_backup_PARTIAL`
Telegram CRITICAL alert. That's noisier than the prior
`offsite_not_configured` warning and not actionable until the R2 token
is re-scoped. Once operator fixes the token, the next hourly /
daily cron will complete the off-site path automatically (no further
human intervention required).

**Alby Hub unlock — RESOLVED.**

- `/api/info` before: `unlocked: false`, `running: true`, `version: v1.21.6`.
- `POST /api/start` with `{"unlockPassword":"…"}` → `http=200`,
  returned a 132-char JWT (HS256, `permission:full`, exp +90 days).
- `/api/info` with `Authorization: Bearer <JWT>`: `unlocked: true`.
  (Note: `/api/info` without the JWT still reports `unlocked: false` in
  this build because the unlock state is JWT-scoped, not global —
  this is intentional in Alby Hub v1.21.x and not a bug.)
- `/api/channels` with the Bearer token returned 1 channel:
  - id `194919490373…1539`, peer pubkey `038a9e56…89bf`, `active: true`,
    `status: "online"`, `IsChannelReady: true`, `IsUsable: true`.
  - `localBalance=6 660 000 msat` → **6 660 sat outbound**.
  - `remoteBalance=983 340 000 msat` → **983 340 sat inbound**.
  - `capacity=990 000 sat`, matches the operator's prior 1 M sat MegaLith
    channel purchase (the 10 k sat gap is the LDK reserve / fees).
- Liquidity classification: `OK` (inbound is 14764.9 % of outbound — fresh
  inbound-tilted channel as expected).

**Two prior-subagent bugs fixed during apply** (in
`scripts/lightning-liquidity-monitor.js`):

1. `_albyLogin()` previously POSTed only to `/api/login` and `/api/unlock`.
   On Alby Hub v1.21.6 those return `401 missing or malformed jwt` and
   `429 rate limit exceeded` respectively — `/api/login` is the OAuth/JWT
   *exchange* endpoint, NOT the unlock endpoint. Fixed by adding
   `/api/start` (the actual v1.21.x unlock endpoint) to the **front** of
   the endpoint probe list, and by treating `429` the same as `404/405`
   (skip to next endpoint instead of bailing).
2. `_isOpenChannel()` previously matched only `state ∈ {open, active}`.
   v1.21.6 returns `status: "online"` and `state: null` for ready
   channels, so the heuristic returned `false` and zeroed out
   inbound/outbound. Patched to also accept `status: "online"`, to use
   `c.active === true` as the primary signal unless the status is
   explicitly closing/closed, and to fall back to
   `internalChannel.channel.IsChannelReady && IsUsable` (LDK ground truth)
   when neither string field is conclusive.

The first cron tick after the prior subagent's `/api/login`-only refactor
(2026-05-12 17:15 UTC) DID succeed in logging in but then reported
`level: CRITICAL, inbound_sats: 0, open_count: 0` because of bug #2 — so
one false-positive `liquidity_critical` Telegram alert may have been
emitted at 17:15 UTC. § 30.Y.11 clears the dedupe state so the next OK
cycle emits a clean RESOLVED notification.

**PM2 state after `pm2 restart … --update-env`:**

```
kya-hub                  online   pid 1706945   restart count 58  Express API
kya-liquidity-monitor    stopped  cron 15 min   exit 0 OK         §30 Item 6
alby-hub                 online   pid 1418036   9h uptime         Lightning node
kya-anchor-worker        online                                   anchor daemon
kya-crl-worker           online                                   CRL worker
```

Note: `kya-liquidity-monitor` is `stopped` in the steady state by design
— PM2 entry is `cron_restart: '*/15 * * * *', autorestart: false`, so it
runs once-per-cron-tick and exits 0. Last manual cycle (17:22:25 UTC,
post-patch) logged
`{event: alby_login_ok, endpoint: /api/start, source: env:ALBY_UNLOCK_PASSWORD}`
then
`{level: OK, event: liquidity_check, inbound_sats: 983340, outbound_sats: 6660, ratio_pct: 14764.9, channel_count: 1, open_count: 1, password_source: [REDACTED]}`.

**Files changed in this apply window:**

| file                                          | change                                                                                                                                                                                                                |
|-----------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `.env`                                        | +7 keys (R2 + ALBY_UNLOCK_PASSWORD), mode 0600 preserved; backup at `.env.bak.<epoch>`                                                                                                                                |
| `scripts/lightning-liquidity-monitor.js`      | added `/api/start` as primary unlock endpoint + 429-tolerant probe loop; patched `_isOpenChannel` to handle `status: "online"` and `IsChannelReady+IsUsable`                                                          |
| `UMBRAXON.md`                                 | this section + open-gates table update                                                                                                                                                                                 |

**Files NOT changed** (already in the prior WS-A/B refactor):

- `scripts/backup-channel-state.sh`
- `scripts/backup-database.sh`
- `scripts/lib/s3-backup-upload.sh`
- `lib/logger.js`
- `docs/RESTORE-PROCEDURES.md`
- `.env.example`

---

## 2026-05-12 evening — Strategic Sprint §31 (A/B/C/D/E)

This sprint added two migrations, one new lib for pricing/deny-list, one new
lib for PDF invoices, three new admin endpoints, one new public endpoint, a
quarterly restore-drill PM2 entry, R2 lifecycle UI instructions, retention
audit gap-fills with Telegram anomaly alerts, and a security audit pass.

### R2 lifecycle (A.1) — ✅ **DONE 2026-05-12 ~19:11 UTC** (operator UI confirmation)

The Cloudflare API token in `BACKUP_S3_*` is a **Bucket-scoped** R2 access key
(S3-compatible). It can `PutObject` / `GetObject` / `DeleteObject` but **cannot**
set lifecycle rules — that requires a separate Account API Token with the
`Workers R2 Storage:Edit` permission. Programmatic `PUT
/accounts/<id>/r2/buckets/<bucket>/lifecycle` returned `Authentication error`
in this sprint, so operator configured the rules manually via the dashboard.

**Verification (audit trail):** Operator confirmed completion in chat 2026-05-12 ~19:11 UTC
+ screenshot archived at `audits/2026-05-12/r2-lifecycle-rules-active.png`.
Programmatic read-back via `s3api get-bucket-lifecycle-configuration` returns
`AccessDenied` (token lacks Bucket Configuration scope), so audit relies on the
archived screenshot until a higher-scope Account API token is provisioned
(operator follow-up #5).

**Actual rules applied (per screenshot, 2026-05-12):**
1. *Default Multipart Abort Rule* (Cloudflare built-in) — Enabled.
2. `delete-lightning-channel-90d` — prefix `kyahub/lightning_channel/`, Delete after 90 days — Enabled.
3. `ia-transition-after-30d` — bucket-wide (no prefix), Transition to Infrequent Access after 30 days — Enabled.

Note: rule 3 is bucket-wide rather than the originally-suggested 3 separate prefix-scoped
IA rules. Functionally equivalent: every object lands at Standard, transitions to IA at 30 d,
and `kyahub/lightning_channel/` objects additionally get deleted at 90 d (rule 2 runs alongside).
DB dumps / DAC8 exports / invoices stay in IA permanently — exactly the intended cost profile.

Original manual UI steps (kept for re-issuance / new bucket setup):

1. Log in → R2 → bucket `umbraxon-kyahub-backups` → **Settings** tab → **Object
   lifecycle rules** → **Add rule**.
2. Rule **A**: name `delete-lightning-channel-90d`
   - Prefix: `kyahub/lightning_channel/`
   - Action: **Delete objects** after `90` days from upload.
   - Save.
3. Rule **B**: name `ia-transition-after-30d`
   - Prefix: `kyahub/db/`
   - Action: **Transition to Infrequent Access** after `30` days from upload.
   - Save.
4. Repeat rule **B**'s configuration with prefix `kyahub/dac8/`.
5. Repeat rule **B**'s configuration with prefix `kyahub/invoices/` (new this
   sprint — PDFs sit on the hub for fast admin queries, IA after 30 d is
   plenty).
6. Verify rules show **Status: Active** in the Settings tab.
7. (Optional) Re-issue an Account API Token with `R2 Storage:Edit` scope and
   record it in 1Password if you want programmatic management later. The
   bucket-scoped key currently in `.env` stays as-is.

### Quarterly restore-drill (A.3)

`ecosystem.config.js` now contains `kya-restore-drill` with
`cron_restart: '0 9 1 */3 *'` (09:00 UTC on day 1 of every 3rd month).
`scripts/restore-drill.sh` lists the latest `kyahub/db/*.dump.gz.enc`,
downloads, verifies HMAC tail, decrypts, gunzips, `pg_restore --list` and
inserts a `backup_log` row with `backup_kind='restore_drill'`.

Manual trigger:

```
pm2 trigger kya-restore-drill    # or
bash scripts/restore-drill.sh    # runs once, exits with 0=OK / 2=FAIL
```

First drill on 2026-05-12 18:18 UTC: PASS, 84 tables, 583 KB dump from
180 096 B encrypted artifact. Telegram informational alert sent.

### Retention audit (B)

`lib/retention-worker.js` extended with 7 new hard-delete tasks:

| Table | Trigger col | Days | Notes |
| ----- | ----------- | ---- | ----- |
| `auth_challenges`        | `created_at`   |   7 | nonces accumulate after `used_at` |
| `pow_challenges`         | `created_at`   |   7 | same |
| `signature_failures`     | `occurred_at`  |  90 | spike detection only |
| `registration_intents`   | `created_at`   |  30 | only completed/expired |
| `ip_bans`                | `banned_at`    |  90 | only revoked/expired |
| `data_exports`           | `requested_at` |  30 | invokes `data-export-service.prune` (handles disk too) |
| `volumetric_counters`    | `occurred_at`  | 365 | AML retention window |

Anomaly alert: if any single retention run deletes >5 % of a table's
`pg_class.reltuples` *prior* row count (and ≥100 rows), Telegram is sent
via `lib/notifications.notify`. Threshold tunable via
`RETENTION_ANOMALY_FRAC` + `RETENTION_ANOMALY_MIN_ROWS`.

VACUUM ANALYZE targets extended to cover the new tables.

### Invoice generator (C)

- `lib/invoice-pdf.js` — `pdfkit` + `qrcode` based A4 single-page renderer.
- New table: `invoices`. Unique key: `payment_hash` (idempotent).
- New endpoints:
  - `GET  /api/admin/invoices` paginated list.
  - `GET  /api/admin/invoices/:invoice_number.json` metadata.
  - `GET  /api/admin/invoices/:invoice_number/pdf` streams PDF (local or R2
    fallback).
  - `POST /api/admin/invoices/regenerate/:invoice_number` re-renders.
  - `POST /api/agent/:kya_id/invoice` agent self-fetch (Ed25519-signed, same
    pattern as data-export).
- BTCPay `InvoiceSettled` and Alby NWC settled callbacks fire-and-forget
  `invoicePdf.issueForPayment(pool, {...})` after a successful
  `registerAgent()`.
- PDFs at `/root/kya-hub/invoices/YYYY/MM/UMX-<ts>-<KYA_ID>.pdf`
  (`chmod 600`, dir `700`); mirrored to
  `s3://umbraxon-kyahub-backups/kyahub/invoices/...` via `aws`.
- Backfill: `scripts/backfill-invoices.js` issued **10 invoices** on
  2026-05-12 18:36 UTC for every agent with `payment_amount_sats>0 AND
  payment_settled_at IS NOT NULL` (incl. the two operator-named test agents
  UMBRA-6C459D, UMBRA-CAD028).
- Operator follow-ups: fill `.env` keys `INVOICE_SELLER_ADDRESS`,
  `INVOICE_SELLER_TAX_ID`, `INVOICE_SELLER_VAT_ID`, `INVOICE_SELLER_IBAN`,
  `INVOICE_SELLER_LOGO_PATH` then `POST
  /api/admin/invoices/regenerate/<inv>` to re-render the historical PDFs
  with the real header. *(Go-live disposition: §30.14.1 — non-blocking defer.)*

### No-custody penalty system (D — A+B+D combo)

Operator decision 2026-05-12: hub holds NO bot funds. Penalties are
upfront price + reputation drop + CRL inclusion + multiplied
re-registration fee + cooldown. **No bond. No refund.**

- `lib/registration-quote.js` + table `pubkey_deny_list` (migration 014).
- `GET  /api/registration/quote?tier=ELITE&pubkey=<hex>` (public, rate-limited).
- `POST /api/admin/agents/:kya_id/ban` body `{reason, evidence_hash?,
  ban_duration_days?}`. Transactionally sets `agents.status='BANNED'`,
  upserts `pubkey_deny_list`, drops reputation by `BAN_REPUTATION_DROP` (default
  500), revokes active certs into CRL.
- `POST /api/admin/agents/:kya_id/unban` clears cooldown only; `ban_count`
  persists, so the next ban still applies the multiplier.
- `GET  /api/admin/deny-list?limit=N&offset=N&only_active=true` — paginated;
  pubkey returned as `pubkey_prefix` (first 16 chars).
- `/api/pay` now rejects with `409 PUBKEY_DENY_LISTED` if the caller's
  pubkey has an active deny-list entry, and `402
  PAYMENT_REQUIRED_RE_REGISTRATION_MULTIPLIER` if they submit the base
  price after a past ban.

### Security audit (E)

Full report: `SECURITY-AUDIT-2026-05-12-EVENING.md`. Highlights:

- **P0-1 fixed**: kya-hub was binding `0.0.0.0:3000` and UFW allowed
  `3000/tcp` from anywhere → nginx bypass. Now binds `127.0.0.1`, UFW rule
  removed. PoC at `audits/2026-05-12/poc/p0-1-nginx-bypass.sh`.
- **P1-2 / P1-3 fixed**: `/root` and `/root/backups/<kind>` were `755`. Set
  to `700`.
- P2 follow-ups documented (no operational blockers).

---

## §32 Public Terms of Service + `/api/health` hardening (2026-05-12)

Two follow-ups from the security audit + invoice-backfill chain landed in
this slot:

- **P1**: publish public ToS at `https://umbraxon.xyz/terms` (invoice PDF
  footers + `cert.termsOfUse.id` already point there → 404 was a broken
  trust signal).
- **P2**: harden `/api/health` (was probing BTCPay synchronously on every
  hit → DoS amplifier; was leaking raw `pg` driver error strings →
  information disclosure).

### 32.A Public Terms of Service deployment

**File paths (on host):**

| Path                                                        | Mode | Purpose                                  |
|-------------------------------------------------------------|------|------------------------------------------|
| `/root/kya-hub/nginx-proxy/snippets/terms.html`             | 0644 | HTML version (inline CSS, no JS, no tracking, dark-mode aware) |
| `/root/kya-hub/nginx-proxy/snippets/terms.txt`              | 0644 | Plain-text mirror (cURL-friendly fallback) |
| `/root/kya-hub/nginx-proxy/conf.d/default.conf`             | 0644 | added two `location =` blocks (alias + cache headers) |

Both files are bind-mounted into the `kya-hub-proxy` (nginx:1.27-alpine)
container at `/etc/nginx/snippets/terms.{html,txt}` via the existing
read-only mount declared in `nginx-proxy/docker-compose.yml`. The container
serves them directly via `alias` — **no `proxy_pass` to the Node app**, so
the static ToS path remains available even when the Node backend is
restarting.

**nginx route patches** (`nginx-proxy/conf.d/default.conf`, inside the
`server { listen 80 default_server; }` block):

```nginx
location = /terms {
    access_log off;
    default_type text/html;
    charset utf-8;
    add_header Content-Type        "text/html; charset=utf-8"          always;
    add_header Cache-Control       "public, max-age=3600"              always;
    add_header X-Robots-Tag        "index, follow"                     always;
    add_header X-Content-Type-Options "nosniff"                        always;
    add_header Referrer-Policy     "no-referrer-when-downgrade"        always;
    alias /etc/nginx/snippets/terms.html;
}

location = /terms.txt {
    access_log off;
    default_type text/plain;
    charset utf-8;
    add_header Content-Type        "text/plain; charset=utf-8"         always;
    add_header Cache-Control       "public, max-age=3600"              always;
    add_header X-Robots-Tag        "index, follow"                     always;
    add_header X-Content-Type-Options "nosniff"                        always;
    add_header Referrer-Policy     "no-referrer-when-downgrade"        always;
    alias /etc/nginx/snippets/terms.txt;
}
```

Both locations are **public, no rate limit, no IP filter** (they sit above
the `limit_req` directives in the server block; only the parent server-block
`limit_conn cc_per_ip` connection cap still applies).

**Reload command (no downtime, file already in place):**

```bash
docker exec kya-hub-proxy nginx -t \
  && docker exec kya-hub-proxy nginx -s reload
```

The `alias` directive re-reads the file content on every request, so
content edits to `terms.{html,txt}` do **not** require even a reload —
only route changes do. The HTML file header comment documents this for
future operators.

**Verification (2026-05-12 ~19:23 UTC):**

```text
$ curl -sS -o /dev/null -w '%{http_code} %{size_download} %{content_type}\n' \
    https://umbraxon.xyz/terms
200 26549 text/html; charset=utf-8

$ curl -sS -o /dev/null -w '%{http_code} %{size_download} %{content_type}\n' \
    https://umbraxon.xyz/terms.txt
200 20532 text/plain; charset=utf-8

$ curl -sI https://umbraxon.xyz/terms | grep -E '^(cache-control|x-robots-tag|content-type|strict-transport)'
content-type: text/html; charset=utf-8
cache-control: public, max-age=3600
x-robots-tag: index, follow
strict-transport-security: max-age=63072000; includeSubDomains; preload
```

Invoice PDFs (footer URL) and cert JSON `termsOfUse.id` now resolve. No
backfill of historical receipts is required — the URL string was already
correct, it was just 404 until this commit.

**Content disclosure / operator action items:**

- The document is a **strong first draft**, not legally certified. It
  captures: acceptance via fee payment; full definitions; service scope
  (and explicit "NOT a financial product / not custody / not a court of
  dispute"); BASIC 10 000 sat / ELITE 80 000 sat pricing with worked
  `min(3^ban_count, 9)` re-registration multiplier examples; certificate
  lifecycle (BASIC 12-mo, ELITE until-revoked, OP_RETURN anchors
  permanent); reputation system disclaimers (best-effort, non-transferable,
  not a financial value); ban grounds + 30 d/90 d cooldowns + permanent
  deny after ≥3 bans; owner obligations (signing-key custody, key-rotation
  on compromise); "AS IS" warranty disclaimer with liability capped at
  trailing-12-month fees (~€100/agent); explicit tax-treatment paragraph
  for the current **natural-person / no IČO / no VAT** status (Slovak
  Income Tax Act §8 "Ostatné príjmy"); GDPR-rights disclosure with the
  hard-truth note that anchored hashes are mathematically immutable;
  Slovak governing law + Prešov-region exclusive jurisdiction; 30-day
  modification notice; contact details.
- English text is authoritative; Slovak titles are convenience
  translations only.
- **Operator must obtain Slovak attorney sign-off before mass agent
  registrations exceed 100 / year.** Even a quick review by a small-firm
  attorney (~€150–€300) is strongly recommended once the operator
  registers a živnosť or s.r.o. — at that point Section 10 (tax
  treatment) needs an update anyway.

### 32.B `/api/health` hardening

Two issues from the audit are addressed in `server.js`:

**(1) Cached upstream probe.** The previous implementation ran a
synchronous `axios.get(BTCPay/api/v1/stores/.../invoices?take=1)` and
`pool.query('SELECT 1')` on **every** request to `/api/health`. Because
`/api/health` is intentionally exempt from the rate limiter (it's a
public liveness endpoint hit by Netdata, UptimeRobot, and the operator
dashboard), a single attacker could trivially amplify a few hundred req/s
into the same amount of upstream load against BTCPay. Now the probes run
on a **background interval** (`HEALTH_PROBE_INTERVAL_MS`, default 60 000
ms), the endpoint returns the cached snapshot, and a `cache` block exposes
`probe_interval_ms`, `staleness_ms`, `last_probe_at`, and `degraded`
(true when staleness exceeds `HEALTH_STALE_CYCLE_MULT × probe_interval`,
default 5 cycles → 5 min). Cold-start (cache empty) executes one live
probe so the first request after `pm2 restart` still returns useful data.

**(2) DB error string masking.** Raw `pg` driver error messages
(`connect ECONNREFUSED 127.0.0.1:5432`, `password authentication failed
for user "kyahub_app"`, etc.) leaked host, port, user, and sometimes
credential hints to any unauthenticated caller. Now the response only
includes a small fixed vocabulary of `db.status` labels:

| `pg` error                             | public `db.status` |
|----------------------------------------|--------------------|
| `ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ETIMEDOUT` | `unreachable`  |
| SQLSTATE `28P01` / `28000` (auth)      | `auth_failure`     |
| SQLSTATE `3D000` (db missing)          | `db_missing`       |
| anything else                          | `error`            |
| `SELECT 1` returned a row              | `OK`               |

The same vocabulary is applied to the BTCPay probe (`unreachable` for
network-level errors, `http_error` with `http_status` integer for
HTTP-level failures, `error` for anything else). Raw `code` / `message`
/ `host` / `port` are accessible **only** via the new admin endpoint:

```
GET /api/admin/health/details        (requires X-Admin-Key)
GET /api/admin/health/details?refresh=1   (force one fresh probe sweep)
```

**Files changed:**

```text
server.js
  + section 6) /api/health refactor (~140 line block, ~lines 1190-1320):
      - new constants: HEALTH_PROBE_INTERVAL_MS, HEALTH_STALE_CYCLE_MULT
      - new module-scope state: _healthCache, _healthProbeInFlight,
        _healthProbeTimer
      - new helpers: _classifyDbError, _classifyBtcpayError,
        _runHealthProbe, _startHealthProbeLoop
      - rewritten app.get('/api/health', ...) returning cached snapshot
      - new app.get('/api/admin/health/details', security.adminAuth, ...)
  + start() boot: kicks _runHealthProbe() + _startHealthProbeLoop()
                  before the existing health-monitor Telegram loop
```

**Before/after behavior:**

|                                              | Before                  | After |
|----------------------------------------------|-------------------------|-------|
| BTCPay HTTP calls per 20 req of `/api/health`| **20**                  | **0** (probe runs once per `HEALTH_PROBE_INTERVAL_MS`) |
| `db.status` on DB outage                     | leaks `err.message`     | sanitized label only |
| Hostname / port disclosure                   | yes (in `FAIL: connect ECONNREFUSED 127.0.0.1:5432`) | no |
| Auth-failure disclosure                      | yes (in `FAIL: password authentication failed ...`) | sanitized to `auth_failure` |
| Cache freshness signal for ops               | none                    | `cache.staleness_ms` + `cache.degraded` |
| Admin-only verbose error access              | none                    | `GET /api/admin/health/details` with `X-Admin-Key` |
| Cold-start behavior (first call after pm2 restart) | live probe (correct)    | live probe (preserved) |

**Test results (2026-05-12 19:30 UTC):**

```text
TEST 1  20 sequential calls to /api/health    → all 200, 0 new BTCPay probes
TEST 2  sample response                        → db.status='OK', btcpay.status='unreachable'
TEST 3  scan response for raw error/host:port  → OK: no raw error string
TEST 4  staleness_ms grows linearly            → 24949ms → 26975ms after 2s sleep
TEST 5  /api/admin/health/details, no key      → 401
TEST 6  /api/admin/health/details, wrong key   → 401
TEST 7  /api/admin/health/details, valid key   → 200 + raw {code,message,host,port}
TEST 8  ?refresh=1 forces fresh probe          → staleness_ms = 2 after refresh
TEST 9  public /api/health regex for leaks     → no 'ECONNREFUSED', no '127.0.0.1:41721'
TEST 10 server.log scan for raw DB error escape→ none
TEST 11 pm2 log scan for raw DB error escape   → none
TEST 12 _classifyDbError unit cases            → 5/5 PASS
```

The BTCPay probe currently classifies as `unreachable` (host kya-hub
trying to reach `127.0.0.1:41721` and being refused). This is a
pre-existing operational state — the audit hardening correctly classifies
it without leaking the host:port pair. Investigating the BTCPay reachability
is out of scope for this audit follow-up but noted in operator action items.

**Env knobs (added):**

```dotenv
# /api/health upstream-probe cache. Background interval; the endpoint
# itself never blocks on the upstream probe.
HEALTH_PROBE_INTERVAL_MS=60000
# How many missed cycles before the endpoint flags `degraded:true`.
# (Still returns HTTP 200 — degraded is a soft signal for ops dashboards.)
HEALTH_STALE_CYCLE_MULT=5
```

Both have safe in-code defaults; `.env` is **unmodified** (no add).
Operator may add them later if non-default values are desired.

**PM2 restart applied:**

```bash
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
pm2 restart kya-hub --update-env
```

`pm2 list` confirms `kya-hub` online; `pm2 logs --nostream` shows the
expected boot trace (`UMBRAXON KYA-Hub ONLINE`).

### 32.C Pre-existing P0 reverse-proxy reachability finding (out of scope; flagged)

While validating the `/api/health` hardening from the public URL the
following pre-existing condition surfaced:

- The kya-hub Node process binds **only** `127.0.0.1:3000` (per the
  P0-1 audit fix).
- The `kya-hub-proxy` container resolves `host.docker.internal` to
  `172.17.0.1` (the **default** docker0 bridge gateway), **but** the
  container is on the `generated_default` network (`172.18.0.0/16`).
  Therefore the `proxy_pass http://kya_hub_backend;` directive cannot
  reach the Node process at all → every public request to
  `https://umbraxon.xyz/*` returns the `@upstream_down` `503 service
  temporarily unavailable` page after `proxy_connect_timeout 5s`.
- `docker ps` confirms the container is `Up 8 hours (unhealthy)` — the
  healthcheck (`wget http://127.0.0.1/api/status` *through* the same
  proxy chain) has been failing since the bind change.

The `/terms` and `/terms.txt` routes added in §32.A intentionally bypass
this issue because they use `alias` (served by the proxy container
itself), not `proxy_pass`. **Historický stav (pred §32.F):** všetky `/api/*`
boli z internetu nedostupné. **Po §32.F** je verejný API chain obnovený;
overenie 2026-05-13: `https://umbraxon.xyz/api/health` a `/api/tiers` → HTTP 200.

**Suggested fixes (operator pick one, none applied by this slot):**

1. Add the docker bridge gateway as a second listen address on the
   host-side kya-hub: in `server.js` listen on both `127.0.0.1` and
   `172.18.0.1`; UFW rule allowing `from 172.18.0.0/16 to 172.18.0.1
   port 3000` (still no public exposure).
2. Set `extra_hosts: "host.docker.internal:172.18.0.1"` in
   `nginx-proxy/docker-compose.yml` to **point at the right gateway**
   for this network, AND apply fix #1 so the host actually listens on
   that interface.
3. Move kya-hub into a docker container on `generated_default`
   network (cleanest long-term answer; rules out the host-vs-container
   networking edge entirely).

This finding is flagged in the operator gates table below (`§32 P0
reverse-proxy reachability`).

### 32.D Open gates table — appended rows

The "Open gates (operator action required)" table earlier in §30 is
extended with:

| # | gate                                                                                                                                                                                                                                       | severity | unblocks |
|---|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|----------|
| 8 | **Account API Token with `R2 Storage:Edit` scope** — optional, low priority. Reason to add later: programmatic R2 lifecycle management + bucket-level config audit (currently lifecycle rules audited by operator screenshots in §30.R2-lifecycle / §32). Cost to operator: ≈2 min in the Cloudflare UI. Cost of NOT doing: lifecycle rules remain audited by screenshot only. Recommend addressing at the next quarterly ops review. | LOW (optional) | programmatic R2 lifecycle audit; otherwise non-blocking |
| 9 | **Slovak attorney review of public ToS at `/terms`.** Strong first draft is live (§32.A). Sign-off recommended before agent registrations exceed 100 / year, or before the operator registers a živnosť / s.r.o. / VAT (whichever first).   | MEDIUM | Section 10 (tax treatment) update path; consumer-protection robustness |
| 10 | ✅ **RESOLVED 2026-05-12 večer (§32.F) + overené 2026-05-13.** Spojenie reverse-proxy → `kya-hub` obnovené (`BIND_ADDR=0.0.0.0` + UFW len Docker podsiete; internet → :3000 zostáva DROP). Verejný smoke: `https://umbraxon.xyz/api/health`, `/api/tiers` → HTTP 200. Symptóm z §32.C je uzavretý historický záznam. | DONE | — |
| 11 | **Watch first 24 h Netdata + ops dashboard** for `/api/health` cache-staleness + `degraded:true` triggers. Tune `HEALTH_PROBE_INTERVAL_MS` / `HEALTH_STALE_CYCLE_MULT` only if false alarms are observed.                                  | LOW | Item §32.B steady-state confidence |

### 32.E Files modified (this slot)

```text
NEW:
  /root/kya-hub/nginx-proxy/snippets/terms.html       (0644, 26 549 B)
  /root/kya-hub/nginx-proxy/snippets/terms.txt        (0644, 20 532 B)

MODIFIED:
  /root/kya-hub/nginx-proxy/conf.d/default.conf       (+38 lines; two new
                                                       `location =` blocks
                                                       and a header comment)
  /root/kya-hub/server.js                             (~140-line block at
                                                       /api/health; +1 boot
                                                       hook in start())
  /root/kya-hub/UMBRAXON.md                           (this §32 section)

UNCHANGED (per constraint):
  /root/kya-hub/.env                                  (no add/remove;
                                                       HEALTH_PROBE_INTERVAL_MS
                                                       and HEALTH_STALE_CYCLE_MULT
                                                       use in-code defaults)
```

No git commit (repo is not a git repo per the brief).

### 32.F P0-2 — Reverse-proxy reachability after BIND_ADDR hardening (2026-05-12 evening)

Closes the operator gate opened by §32.C / row #10 in the §32.D table.

**Symptom**: Public `https://umbraxon.xyz/api/*` returned 503 / timeout after the §31 P0-1 fix bound `kya-hub` to `127.0.0.1:3000`. Static `/terms` (alias-served by nginx itself) was unaffected.

**Root cause**: `kya-hub-proxy` runs on the user-defined Docker network `generated_default` (`172.18.0.0/16`, gateway `172.18.0.1`) — not on `docker0` (`172.17.0.0/16`). The container's `/etc/hosts` resolves `host.docker.internal` to `172.17.0.1`, but `kya-hub` on `127.0.0.1:3000` was unreachable from any container, and even `172.17.0.1:3000` was unreachable from a container on a non-`docker0` bridge.

**Fix applied**:

1. `.env`: `BIND_ADDR=0.0.0.0` — `kya-hub` listens on all interfaces (still firewalled).
2. UFW: explicit ACCEPT only from the Docker bridge subnet that hosts the proxy —
   `ufw allow from 172.18.0.0/16 to any port 3000 proto tcp comment 'Docker generated_default → kya-hub'`
   (Rule 1 already covered `172.17.0.0/16`. Default INPUT policy remains DROP.)
3. `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy && pm2 restart kya-hub --update-env`.

**Security profile (unchanged from P0-1 intent)**:

- Internet → `:3000` = **DROP** (UFW default; verified externally via yougetsignal.com + 5 s `tcpdump -i any port 3000` showing 0 external SYNs).
- Internet → `:443` → nginx → kya-hub via `172.18.0.1:3000` = **ALLOW** (`/api/health` returns `HTTP 200` in ~30 ms, `/api/whitelist` returns `HTTP 200`).
- Docker containers on `172.17.0.0/16` or `172.18.0.0/16` → `:3000` = **ALLOW** (explicit UFW rules, both still required because `docker0` exists for legacy single-container compose stacks).

**Persistence**:

- UFW rule lives in `/etc/ufw/user.rules` (auto-saved). `systemctl is-enabled ufw` = `enabled`.
- `.env` `BIND_ADDR=0.0.0.0` is sourced by `server.js` on every boot.
- `pm2 save` re-persisted the process list (`/root/.pm2/dump.pm2`), so reboot survives.

**Backup**: pre-fix `.env` preserved at `/root/kya-hub/.env.bak.p0fix.1778614741` (do NOT delete — recovery artifact).

**Future-proofing note**: if a future Docker compose stack creates a new user-defined network for any container that must reach `kya-hub`, repeat step 2 for that subnet (e.g. `ufw allow from 172.19.0.0/16 to any port 3000 proto tcp comment 'Docker <name> → kya-hub'`). Do **not** revert to `BIND_ADDR=127.0.0.1` without first moving `kya-hub` into a container on the same Docker network as the proxy (option #3 in §32.C suggested fixes).

**Resolves gate row #10** in the §32.D table — status flipped to ✅ **CLOSED** in §32.D (2026-05-13 doc sync) + §30.14.1 public smoke note.

---

 zachytáva všetky informácie o projekte ku dňu 2026-05-12 (doplnené §30.14.1 + §32.D gate #10 closure **2026-05-13**). **Phase 1 ✅ + Phase 1.5 ✅ + Phase 2 ✅ + Phase 2.1 ✅ + Phase 2.2 ✅ + Phase 2.3 ✅ + Phase 2.4 ✅ + Phase 2.4 Capacity ✅ + Phase 2.4 Reliability ✅ + Phase 2.5 Payment Production ✅ + Phase 3 Nginx Reverse Proxy ✅ + Phase 3 Netdata Monitoring ✅ + Phase 3D Alby NWC Lightning ✅ + Phase 3E Real LN E2E ✅ + Phase 4 ELITE Production-Ready ✅ + Phase 4 LIVE mainnet anchors ✅ + Phase 4B Manufacturer Onboarding ✅ + Phase 5 CRL Transparency Log ✅ (DRY_RUN) + Phase 5b Multi-Sig ELITE certs ✅ + Production Hardening Sprint 2026-05-12 ✅ + Strategic Sprint 13-item audit response 2026-05-12 ✅ + Cloudflare R2 + Alby unlock refactor 2026-05-12 ✅** dokončené. First two production anchors (GENESIS + LN agent) confirmed in block 949,085 via bitcoind direct backend. Anchor worker LIVE, CRL worker DRY_RUN (waiting for user GO before first KYAR broadcast). Verejný API smoke 2026-05-13: `/api/health`, `/api/tiers`, `/terms` OK (§30.14.1). Off-site backup destination: **Cloudflare R2** (primary, via S3-compatible API in `BACKUP_S3_*`); Backblaze B2 (`B2_*`) retained as legacy fallback. Security audit clean: 0 P0, 3 P1 fixed, 2 P2 fixed, 0 npm CVEs. Pri ďalších zmenách aktualizuj relevantnú sekciu.
