# Lightning Watchtower Setup — Operator Playbook

**Status:** Strategic Sprint §30 Item 13 — 2026-05-12.
**Audience:** UMBRAXON KYA-Hub operator (single human, root on the
production AX52).
**Risk class:** moderate. A misbehaving watchtower cannot steal funds,
but a missing watchtower means the hub may not catch a counter-party
LDK breach during long offline windows.

This document is **a playbook, not running code**. The KYA-Hub backend
does not interact with the watchtower at runtime. Configuration lives
entirely inside Alby Hub's web UI (or LDK config files when fully
self-hosted).

---

## Why a watchtower

Alby Hub runs an embedded **LDK** (Lightning Development Kit) node. If
our channel counter-party (today: **MegaLith LSP**) tries to broadcast
a stale commitment transaction while our node is offline, an LDK
without a watchtower **will not be able to catch and punish that
breach** if the offline window exceeds the channel's CSV delay
(typically 144 blocks ≈ 24 hours on mainnet).

A watchtower is a third party (or self-hosted second server) that:

1. Holds an *encrypted* copy of every channel-update justice
   transaction we generate.
2. Continuously scans the chain for our channel funding outpoints.
3. If a stale state hits the mempool, broadcasts the justice tx,
   sweeping the counter-party's full balance to our address.

The watchtower **cannot** decrypt our channel data or spend our funds
on its own — it can only watch and punish breaches.

---

## Decision matrix (operator must pick one)

| option | cost | trust model | setup time | recommended for                            |
| ------ | ---- | ----------- | ---------- | ------------------------------------------ |
| **A. Free 3rd-party tower (Voltage Cloud Watchtower)** | €0 | one trusted org — easy to migrate | 5 min | the default; matches our current ops style |
| **B. Free 3rd-party tower (Lightning Labs LiT public tower)** | €0 | one trusted org | 5 min | identical security to A, alternative org |
| **C. Self-hosted LND container on a second cheap VPS** | €4–10/mo | zero third parties, full sovereignty | 1–2 h | once we have ≥1 ELITE customer paying for it |

**Operator default decision (pending confirmation):**
**Option A — Voltage Cloud Watchtower** — until ELITE volume justifies
the self-hosted operational overhead. Voltage is well-established (used
by Strike, River, Fold), free for one tower URI, and EU-region
friendly.

You may switch to Option B at any time (no on-chain action; Alby Hub
re-uploads channel updates to the new tower). Option C is a project
that should follow Item 1+2 backup verification.

---

## Option A — Voltage Cloud Watchtower (RECOMMENDED)

### A1. Provision

1. Browse [https://voltage.cloud/](https://voltage.cloud/) and sign in.
2. Dashboard → **Watchtowers** → **New** → choose the **Free** tier.
3. Copy the watchtower URI displayed. It looks like:

   ```
   03cba6f5ab02af6a82e69a85e10c8ee0e6ad7c3f06ea3d8d3cda0a91f6bf3a72d5@watchtower.voltage.io:9911
   ```

   Format: `<pubkey hex>@<host>:<port>`. The pubkey is the watchtower's
   identity; the host/port is its connection endpoint.

### A2. Add the URI to Alby Hub

Alby Hub does not yet expose a watchtower picker in its web UI
(verified 2026-05-12 by checking the Alby Hub release notes through
[https://github.com/getAlby/hub/releases](https://github.com/getAlby/hub/releases)).
Two pathways exist:

#### A2.a — Wait for upstream UI support (recommended low-risk path)

Alby Hub publicly tracks watchtower support in their roadmap. Set a
calendar reminder for **2026-09** to re-check.

Meanwhile, our risk exposure is bounded because:

- We are online >99% of the time (PM2 + uptime monitoring).
- MegaLith has been an honest LSP since onboarding (no breach
  attempts; reputable Bitcoin-only LSP).
- Channel size is small (1 M sats inbound, ≤22k sats hub outbound
  in the worst case) — even a 100% loss would be ~€5.

We accept this exposure for the moment.

#### A2.b — Manual LDK config injection (advanced, NOT recommended yet)

If you must enable watchtower NOW before Alby Hub's UI support lands:

1. Stop Alby Hub:
   ```bash
   pm2 stop alby-hub
   ```

2. Back up the LDK workdir FIRST (the Item 1 hourly job covers this,
   but trigger a fresh manual snapshot):
   ```bash
   /root/kya-hub/scripts/backup-channel-state.sh
   ```

3. Edit Alby Hub's nostr-wallet-connect config and append the
   watchtower URI to the LDK config block. (Exact JSON path varies
   per Alby Hub release; consult the Alby Hub repo's
   `nwc/internal/config/config.go` for the canonical key name.)

4. Restart Alby Hub: `pm2 start alby-hub --update-env`.

5. Watch logs for `Connected to watchtower <pubkey>` (in
   `/root/.pm2/logs/alby-hub-out.log`). If you see a connection error,
   roll back to the backup taken in step 2 (see
   `docs/RESTORE-PROCEDURES.md`).

> ⚠ **Stop and ask before executing A2.b.** This restarts `alby-hub`,
> which momentarily breaks the Lightning side of `/api/pay`. The
> operator brief explicitly flags alby-hub restarts as risky.

### A3. Verify

After Alby Hub re-connects, run:

```bash
pm2 logs alby-hub --lines 200 | grep -i 'watch'
```

You should see one of:

- `connected to watchtower 03cba6f5…`
- `subscribed to channel … from watchtower`
- `tower update for channel … sent`

---

## Option B — Lightning Labs LiT public tower

Same procedure as Option A but the URI comes from
[https://terminal.lightning.engineering/](https://terminal.lightning.engineering/)
→ "Use our public watchtower" toggle. URI prefix
`02cd1f4055...@towers.lightning.engineering:8443` (subject to change;
always copy from the live UI).

The trust model is identical to Voltage (one trusted org; cannot steal
funds). Choose B over A if you prefer the Lightning Labs operator's
historical track record.

---

## Option C — Self-hosted LND container (later)

Skipped in v1. This is a 1–2 hour project that requires:

- A second VPS (Hetzner CX11 €4.51/mo is sufficient, 1 vCPU, 4 GB RAM,
  20 GB disk).
- An LND release pre-built for `linux/amd64`.
- Configuring `wtclient` (LND's watchtower-client) on the Alby Hub
  side and `wtserver` on the second VPS.
- Periodic chain-tip sync via a public Bitcoin neutrino backend OR
  a second bitcoind (pruned mode is fine; ~10 GB).

This is documented separately in a TODO file
`docs/WATCHTOWER-SELFHOSTED.md` (placeholder; create when ready). The
operator picks the timeline.

---

## Alby Hub watchtower support — verified facts (2026-05-12)

| question                                                | answer (as of 2026-05-12)             |
| ------------------------------------------------------- | ------------------------------------- |
| Does Alby Hub support a watchtower URI in the web UI?   | **No** — issue tracked upstream.      |
| Can I inject via LDK config file?                       | Yes (Option A2.b above), advanced.    |
| Does Alby Hub auto-back-up channel state to disk?       | Yes — that's what Item 1 archives.    |
| Does Alby Hub have a built-in fallback if it sees a stale broadcast? | Partial — it broadcasts justice tx on its own next start-up if back online within the CSV window, but **cannot** punish breaches that happen during a >24 h outage. |
| Does Alby Hub support multiple watchtowers?             | Not currently. Pick one.              |

> 🔄 **Re-check date:** 2026-09-01. Add this to the operator's
> calendar.

---

## Telegram alert (when the operator opts in)

Once a watchtower is configured (Option A2.b or B), add a Netdata
alert that pages the operator if Alby Hub logs lose the
`connected to watchtower` line for >30 min:

```yaml
# /etc/netdata/health.d/alby-watchtower.conf
alarm: alby_watchtower_disconnected
on: log.alby-hub
lookup: count -30m unaligned of WatchtowerConnected
units: events
crit: $this == 0
info: Alby Hub has not logged a watchtower-connected event in 30 min
```

(Adjust regex to whatever string Alby Hub emits at your version.)

---

## Operator action items

| # | action                                                                    | priority | gate                                                                                       |
| - | ------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| 1 | Sign up for Voltage Cloud and claim a free watchtower URI                 | LOW      | none                                                                                       |
| 2 | Wait for Alby Hub web UI watchtower picker (planned 2026-09-ish)          | LOW      | upstream release                                                                           |
| 3 | OR: trigger Option A2.b manually after stopping `alby-hub`                | OPTIONAL | only if ELITE traffic >€100/mo; requires fresh channel state backup first                  |
| 4 | OR: stand up Option C self-hosted on a second Hetzner CX11                | OPTIONAL | only when ELITE volume justifies the €5/mo + operational overhead                         |
| 5 | Add the Netdata Telegram alert from §"Telegram alert" above               | LOW      | requires a watchtower already configured                                                   |

---

## Why this is the LOW-priority item

Until ELITE volume justifies the operational risk, the cost-vs-benefit
of a watchtower is dominated by the small channel sizes we run. A
breach loss is capped at ~€5–10 on today's channel sizes, while
operating a self-hosted tower costs ~€5/mo continuously.

When ELITE revenue reaches ~€100/mo and channels are >5 M sat, this
item gets re-promoted to MEDIUM.

---

_Document maintained by UMBRAXON s.r.o. Last upstream verification:
2026-05-12._
