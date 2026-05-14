# Restore procedures (Strategic Sprint §30 Items 1 + 2)

This document describes how to **restore** from the encrypted backups
produced by `scripts/backup-channel-state.sh` (Item 1) and
`scripts/backup-database.sh` (Item 2). Both use the same encryption
scheme keyed by the env-var **`BACKUP_PASSPHRASE`** (64 hex characters /
32 raw bytes). Lose that passphrase and the backups become unrecoverable
— store it offline (paper / hardware wallet / encrypted vault).

**Destination providers.** As of 2026-05-12 the primary off-site target is
**Cloudflare R2** via S3-compatible API (env `BACKUP_S3_*`). The legacy
Backblaze B2 native CLI path (env `B2_*`) is kept as a fallback and is
still fully supported — if both sets are populated, `BACKUP_S3_*` wins.
Any S3-compatible provider (AWS S3, MinIO, DigitalOcean Spaces, Wasabi)
will also work; only the endpoint URL / region need to change.

## 1. Encryption scheme

```
plaintext.tar.gz
   │
   ▼
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass pass:$BACKUP_PASSPHRASE
   │
   ▼
[ ciphertext: "Salted__" + 8B salt + AES-CBC blocks ]
   │
   ▼
append( HMAC-SHA256( BACKUP_PASSPHRASE, ciphertext ) )      ← 32 bytes
   │
   ▼
file: *.tar.gz.enc   (size = cipher + 32 HMAC bytes)
```

The HMAC tail guarantees tamper-evidence: any single bit flip in the
ciphertext (e.g. from disk corruption, MITM during B2 download) is
detected before decryption is attempted.

The script intentionally uses CBC-with-HMAC-SHA256 (encrypt-then-MAC) instead
of raw `openssl enc -aes-256-gcm` because GCM mode is not universally
exposed via the openssl CLI on all Linux distributions and BTCPay /
Hetzner images. The two constructions are equivalent in our threat model
(operator-only access, encryption at rest, tamper-evident on integrity).

## 2. Restoring the Lightning channel state (Item 1)

> **Alby Hub (LDK) vs classic LND.** This production stack uses **Alby Hub**
> with an embedded **LDK** node. Off-site channel-related state is archived by
> **`scripts/backup-channel-state.sh`** (encrypted tarball of the Alby
> `workdir`, including `ldk/` and `nwc.db`). There is **no** LND-style
> `channel.backup` file from `lncli` in this deployment. If you also run a
> separate LND elsewhere, manage its SCB and seed according to that node’s
> docs — not this section.

> ⚠️ **Read this entire section before doing ANY restore.** Restoring an
> *old* LDK channel store while the on-chain channels have moved forward
> can cause **toxic-channel force-close** with a justice tx that may
> punish *you* (the older state operator). The safe procedure is:
>
> 1. **Never restore while alby-hub is online** — stop it first.
> 2. After restoring, **immediately broadcast a force-close** on every
>    channel (or trust the peer to cooperate close). Do NOT continue
>    routing payments on stale state.
> 3. Only restore on the same Hetzner host (or its replacement) — *do
>    not* run two alby-hub instances pointing at the same channels.

### 2.1 Locate the artifact

Local hot copy (last 30 days):

```bash
ls -lh /root/backups/lightning_channel/channel-state-*.tar.gz.enc
```

Off-Hetzner cold copy (Cloudflare R2 — preferred):

```bash
# Assumes `aws` CLI is installed and BACKUP_S3_* vars are set in .env
source /root/kya-hub/.env
AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
    s3 ls "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-kyahub/}lightning_channel/"

AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
    s3 cp "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-kyahub/}lightning_channel/channel-state-<host>-<ts>.tar.gz.enc" \
    ./restored.tar.gz.enc
```

Legacy Backblaze B2 (still works if you kept the B2_* setup):

```bash
b2 ls b2://${B2_BUCKET}/lightning_channel/                              # CLI v3+
b2 download-file-by-name ${B2_BUCKET} \
    lightning_channel/channel-state-<host>-<ts>.tar.gz.enc ./restored.tar.gz.enc
```

### 2.2 Verify integrity

```bash
ART=/root/backups/lightning_channel/channel-state-20260512T153409Z.tar.gz.enc
PP=$(grep '^BACKUP_PASSPHRASE=' /root/kya-hub/.env | cut -d= -f2-)
HMAC_BIN=$(tail -c 32 "$ART" | xxd -p -c 64)
CIPHER_LEN=$(($(stat -c%s "$ART") - 32))
COMPUTED=$(head -c "$CIPHER_LEN" "$ART" \
             | openssl dgst -sha256 -hmac "$PP" -hex \
             | awk '{print $NF}')
[[ "$HMAC_BIN" == "$COMPUTED" ]] && echo "HMAC OK" || echo "HMAC MISMATCH — artifact corrupted"
```

### 2.3 Decrypt + unpack

```bash
# 1) strip HMAC tail
CIPHER_LEN=$(($(stat -c%s "$ART") - 32))
head -c "$CIPHER_LEN" "$ART" > /tmp/cipher.bin

# 2) decrypt
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass pass:"$PP" \
    -in /tmp/cipher.bin -out /tmp/channel-state.tar.gz

# 3) inspect (before unpacking on top of live data!)
tar -tzf /tmp/channel-state.tar.gz | head -20

# 4) STOP alby-hub
pm2 stop alby-hub

# 5) move current state aside (DO NOT delete — keep for rollback)
mv /root/kya-hub/albyhub/workdir /root/kya-hub/albyhub/workdir.before-restore-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /root/kya-hub/albyhub/workdir
chown -R 1001:1001 /root/kya-hub/albyhub/workdir
chmod 700 /root/kya-hub/albyhub/workdir

# 6) unpack
tar -xzf /tmp/channel-state.tar.gz -C /root/kya-hub/albyhub/workdir

# 7) verify ldk/ + nwc.db landed
ls /root/kya-hub/albyhub/workdir/

# 8) start alby-hub
pm2 start alby-hub

# 9) check logs for clean start (look for "node started", LDK channel restore)
pm2 logs alby-hub --lines 100 --nostream
```

### 2.4 Static-channel-backup (SCB) emergency-only path

If the LDK channel store is unreadable but you have the SCB file
(`albyhub/workdir/ldk/static_channel_backups/`) you can ask the peer to
cooperate close via [Lightning specs BOLT 2 `error` message] handshakes.
This path is **NOT** automated in this repo and requires manual `bos`
/ `lncli closechannel --force` style intervention from a recovered LND
instance. SCB only enables *funds recovery* not *channel resumption*.

---

## 3. Restoring PostgreSQL (Item 2)

### 3.1 Locate the artifact

```bash
ls -lh /root/backups/postgres/kyahub-*.dump.gz.enc

# Cloudflare R2 (preferred):
source /root/kya-hub/.env
AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-auto}" \
aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
    s3 cp "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-kyahub/}db/kyahub-YYYYMMDD.dump.gz.enc" \
    ./restored.dump.gz.enc

# Legacy B2 (only if BACKUP_S3_* not in use):
b2 download-file-by-name ${B2_BUCKET} \
    db/kyahub-YYYYMMDD.dump.gz.enc ./restored.dump.gz.enc
```

### 3.2 Verify HMAC + decrypt + decompress

```bash
ART=/root/backups/postgres/kyahub-20260512.dump.gz.enc
PP=$(grep '^BACKUP_PASSPHRASE=' /root/kya-hub/.env | cut -d= -f2-)

CIPHER_LEN=$(($(stat -c%s "$ART") - 32))
HMAC_BIN=$(tail -c 32 "$ART" | xxd -p -c 64)
COMPUTED=$(head -c "$CIPHER_LEN" "$ART" \
             | openssl dgst -sha256 -hmac "$PP" -hex \
             | awk '{print $NF}')
[[ "$HMAC_BIN" == "$COMPUTED" ]] || { echo "HMAC MISMATCH"; exit 1; }

head -c "$CIPHER_LEN" "$ART" \
   | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass pass:"$PP" \
   | gunzip -c > /tmp/kyahub.dump
```

### 3.3 Decision: full restore vs into a fresh DB?

**Always restore into a fresh DB first**, verify, then swap.

```bash
# 1) stop the hub
pm2 stop kya-hub kya-anchor-worker kya-crl-worker

# 2) create restore target
sudo -u postgres createdb kyahub_restore
sudo -u postgres psql -c "GRANT ALL ON DATABASE kyahub_restore TO kyahub;"

# 3) restore (custom format)
pg_restore --no-owner --no-acl -d kyahub_restore /tmp/kyahub.dump

# 4) sanity check
PGPASSWORD="$DB_PASSWORD" psql -U "$DB_USER" -d kyahub_restore \
   -c "SELECT COUNT(*) FROM agents; SELECT COUNT(*) FROM certificates;"

# 5) if happy, swap names (atomic with brief downtime)
sudo -u postgres psql <<SQL
ALTER DATABASE kyahub RENAME TO kyahub_before_restore_$(date -u +%Y%m%d);
ALTER DATABASE kyahub_restore RENAME TO kyahub;
SQL

# 6) restart hub
pm2 start kya-hub kya-anchor-worker kya-crl-worker
pm2 logs kya-hub --lines 50 --nostream
```

### 3.4 Forwards-restore (replay anchor / CRL workers)

After a DB restore, the on-chain state may be ahead of what's in the DB
(if the DB snapshot is older than the last broadcast tx). Run:

```bash
# Forces anchor worker to re-confirm any PENDING/BROADCASTED anchors by re-querying bitcoind
pm2 restart kya-anchor-worker --update-env

# Same for CRL worker — it will see PENDING_CONFIRMATION rows and re-poll their txids
pm2 restart kya-crl-worker --update-env
```

If a cert exists on-chain (`certificates.anchor_txid IS NOT NULL`) but
the DB restore is missing rows, the worker will **NOT** re-broadcast (it
respects the unique constraint on `pending_anchors` and the anchor
worker's `(agent_id, status=BROADCASTED)` filter). You'll need to insert
back the missing row(s) manually from the on-chain OP_RETURN payload —
contact engineering before doing this manually.

---

## 4. Disaster recovery: lost server, recovered from off-site bucket only

```
1. Spin up fresh Hetzner host (Debian/Ubuntu, same OS major version).
2. apt install nodejs npm postgresql-15 openssl awscli
   # (or `apt install rclone` if you prefer rclone over awscli)
3. git clone / scp the /root/kya-hub repo or restore it from a separate
   git mirror (not part of this backup scheme — kept on GitHub).
4. Reconstruct .env: keep BACKUP_PASSPHRASE in a sealed envelope (offline).
   DB_PASSWORD / BTCPAY_API_KEY / ADMIN_API_KEY etc must be re-issued.
5. createdb kyahub
6. Restore PostgreSQL (§ 3 above).
7. Restore Lightning channel state (§ 2 above).
8. Restore /root/kya-hub/.env (manual — never store this in the bucket).
9. pm2 start ecosystem.config.js
10. Verify with: node scripts/test-item1-channel-backup.js
                node scripts/test-item2-database-backup.js
```

---

## 4.5 Backup restore drill (quarterly runbook)

Run this drill every quarter on a throwaway host (or in a `docker run`
container with awscli + openssl + postgresql-client installed). The goal
is to confirm three things are still true:

1. The off-site bucket is readable with the credentials in your password
   manager.
2. `BACKUP_PASSPHRASE` (in the sealed envelope) still decrypts a recent
   artifact.
3. The decrypted artifact passes its integrity check (HMAC tail + `pg_restore`
   sanity).

```bash
# --- 1) Download the most recent encrypted artifact from R2 ----------------
export BACKUP_S3_ENDPOINT="<paste from your secrets store>"
export BACKUP_S3_REGION=auto
export AWS_ACCESS_KEY_ID="<paste>"
export AWS_SECRET_ACCESS_KEY="<paste>"
export BACKUP_S3_BUCKET="<paste>"
export BACKUP_S3_PREFIX="kyahub/"
export BACKUP_PASSPHRASE="<paste from sealed envelope>"

DRILL_DIR=$(mktemp -d)
cd "$DRILL_DIR"

# List the latest DB dumps
aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
    s3 ls "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}db/" --recursive \
    | sort -k1,2 | tail -3

# Pull the most recent
LATEST=$(aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
            s3 ls "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}db/" \
            | awk '{print $4}' | sort | tail -1)
aws --endpoint-url "$BACKUP_S3_ENDPOINT" \
    s3 cp "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}db/${LATEST}" \
       ./drill-artifact.enc

# --- 2) Verify HMAC tail ----------------------------------------------------
SIZE=$(stat -c%s drill-artifact.enc)
CIPHER_LEN=$((SIZE - 32))
HMAC_BIN=$(tail -c 32 drill-artifact.enc | xxd -p -c 64)
COMPUTED=$(head -c "$CIPHER_LEN" drill-artifact.enc \
             | openssl dgst -sha256 -hmac "$BACKUP_PASSPHRASE" -hex \
             | awk '{print $NF}')
if [[ "$HMAC_BIN" != "$COMPUTED" ]]; then
    echo "FAIL: HMAC mismatch — artifact corrupted or wrong passphrase"; exit 1
fi
echo "OK: HMAC tail valid"

# --- 3) Decrypt + decompress + check pg_dump magic --------------------------
head -c "$CIPHER_LEN" drill-artifact.enc \
   | openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt \
                 -pass pass:"$BACKUP_PASSPHRASE" \
   | gunzip -c > drill.dump
MAGIC=$(head -c 5 drill.dump | xxd -p)
if [[ "$MAGIC" != "$(printf 'PGDMP' | xxd -p)" ]]; then
    echo "FAIL: decrypted output is not a pg_dump custom-format archive"; exit 1
fi
echo "OK: decrypted PGDMP archive, $(stat -c%s drill.dump) bytes"

# --- 4) Optionally restore into a throwaway DB ------------------------------
# (only in an isolated container — never on the production postgres host)
# createdb drill_$(date -u +%Y%m%d)
# pg_restore --no-owner --no-acl -d drill_$(date -u +%Y%m%d) drill.dump

# --- 5) Repeat for lightning channel state ---------------------------------
# Same flow against s3://$BUCKET/${BACKUP_S3_PREFIX}lightning_channel/
# After decrypt, `tar -tzf` should list `ldk/` + `nwc.db`.

cd / && rm -rf "$DRILL_DIR"
```

Track each drill in a log (date + operator + artifact tested + result).
A failed drill blocks the next sprint until the root cause is fixed.

---

## 5. Rotating `BACKUP_PASSPHRASE`

**Do not rotate without a transition plan.** Old artifacts encrypted
with the old passphrase remain readable only with the old passphrase.

Procedure:

1. Generate new passphrase: `node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'`.
2. Place the new passphrase in a secondary env var:
   `BACKUP_PASSPHRASE_NEW=<new-pp>`.
3. Wait one full **`BACKUP_HOT_RETENTION_DAYS`** cycle (default 30 d) so
   every category has a backup under both keys (decryptable + verifiable).
4. Confirm decryptability via `scripts/test-item1-channel-backup.js` +
   `scripts/test-item2-database-backup.js` against arbitrary old & new
   artifacts.
5. Swap: `BACKUP_PASSPHRASE=<new-pp>` and remove `BACKUP_PASSPHRASE_NEW`.
6. Old artifacts (still encrypted with the old passphrase) keep working
   on restore *if you keep the old passphrase archived offline*.

---

## 6. Cron schedule

Installed by the operator via `crontab -e`:

```
# Hourly Lightning channel state backup (Item 1)
17 * * * * /root/kya-hub/scripts/backup-channel-state.sh >> /var/log/kya-channel-backup.log 2>&1

# Daily PostgreSQL backup at 02:00 UTC (Item 2)
0 2 * * * /root/kya-hub/scripts/backup-database.sh >> /var/log/kya-db-backup.log 2>&1
```

Each script handles its own dedupe + retention pruning. Cron failures
surface as Telegram CRITICAL alerts (deduped by the script's own
`channel_backup_*` / `db_backup_*` dedupe keys).
