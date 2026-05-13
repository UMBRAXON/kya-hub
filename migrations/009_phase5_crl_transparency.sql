-- ============================================================================
-- UMBRAXON KYA-Hub — Phase 5 (Revocation Transparency Log)
-- ----------------------------------------------------------------------------
-- Goal: every cert revocation is recorded as a tamper-evident event,
-- batched into a Merkle tree once a day, and anchored on-chain via a single
-- OP_RETURN (magic "KYAR"). Relying parties can verify offline (signed JSON
-- CRL) AND on-chain (mempool.space → txid → KYAR root).
--
-- Tables:
--   1. revocation_events — append-only ledger of every revocation
--   2. crl_anchors       — one row per batched on-chain anchor (Merkle root)
--   3. crl_signed_files  — index of generated signed JSON CRL files
--      (operator-served via nginx)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. revocation_events
-- ----------------------------------------------------------------------------
-- One row per cert revocation. Population sources (hooks added later):
--   - lib/reputation-engine.js (SUSPENDED zone)
--   - lib/retire-service.js (voluntary retire + GDPR purge)
--   - admin reissue endpoint (when reissue replaces a current cert,
--     the OLD cert is logged here as a "REISSUED" revocation event)
--   - direct admin revoke (future endpoint)
--
-- revocation_hash: deterministic sha256 of canonicalized record. Locked at
-- insert; serves as the leaf hash in the Merkle tree for this epoch.
--
-- crl_anchored_at: NULL until the row has been bundled into an OP_RETURN
-- anchor. After anchoring, crl_anchor_id points to crl_anchors.id and
-- merkle_proof stores the inclusion path.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS revocation_events (
    id                  BIGSERIAL PRIMARY KEY,
    cert_serial         VARCHAR(64) NOT NULL,
    kya_id              VARCHAR(64) NOT NULL,
    agent_id            INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    revoked_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_by          VARCHAR(64) NOT NULL DEFAULT 'system',
        -- 'system' (auto from rep engine), 'admin' (manual), 'owner' (retire), 'gdpr_purge'
    revocation_reason   TEXT,
    revocation_category VARCHAR(32) NOT NULL DEFAULT 'OTHER',
        -- 'SUSPENDED_ZONE' | 'VOLUNTARY_RETIRE' | 'GDPR_PURGE'
        -- | 'REISSUED' | 'ADMIN_REVOKE' | 'OTHER'
    cert_hash           VARCHAR(64),   -- sha256 of revoked cert body (informational)
    revocation_hash     VARCHAR(64) NOT NULL,   -- leaf for Merkle tree
    -- Anchor linkage
    crl_anchor_id       BIGINT,        -- FK to crl_anchors.id once anchored
    crl_anchored_at     TIMESTAMP,
    merkle_leaf_index   INTEGER,       -- 0-based position in the anchored tree
    merkle_proof        JSONB,         -- array of {pos:'left'|'right', hash} from leaf to root
    -- Forensic fields
    admin_user          VARCHAR(64),
    client_ip           INET,
    detail              JSONB,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- An idempotency guard: same cert_serial cannot have two un-anchored
    -- pending revocation events. After anchoring (crl_anchor_id IS NOT NULL),
    -- the partial unique index allows historical re-revocation in edge cases
    -- (e.g. reissue → revoke → re-reissue → revoke).
    CONSTRAINT chk_revoked_by CHECK (revoked_by IN ('system','admin','owner','gdpr_purge','anchor-worker','retire-service','reputation-engine'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_revevent_serial_pending
    ON revocation_events (cert_serial)
    WHERE crl_anchor_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_revevent_kya ON revocation_events (kya_id);
CREATE INDEX IF NOT EXISTS idx_revevent_revoked_at ON revocation_events (revoked_at DESC);
CREATE INDEX IF NOT EXISTS idx_revevent_unanchored
    ON revocation_events (created_at)
    WHERE crl_anchor_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_revevent_anchor ON revocation_events (crl_anchor_id);

COMMENT ON TABLE revocation_events IS
    'Phase 5: append-only revocation ledger. Each row is a leaf in the next CRL Merkle anchor.';

-- ----------------------------------------------------------------------------
-- 2. crl_anchors
-- ----------------------------------------------------------------------------
-- One row per CRL epoch broadcast. Epoch ID = unix-day at anchor time (UTC),
-- which gives clear daily cadence and trivial offline lookup.
-- OP_RETURN payload layout (36 bytes total, same envelope size as KYA1):
--   4 bytes  : magic "KYAR" (0x4B 0x59 0x41 0x52)
--   32 bytes : Merkle root (sha256)
--
-- An optional supplemental 4-byte epoch_id can be carried in the parallel
-- signed JSON CRL file (NOT on-chain) to keep the payload at 36 B for
-- consistency with KYA1.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crl_anchors (
    id                  BIGSERIAL PRIMARY KEY,
    epoch_id            INTEGER NOT NULL,        -- unix-day (UTC) when anchored
    epoch_label         VARCHAR(32) NOT NULL,    -- e.g. 'CRL-2026-05-12'
    merkle_root         VARCHAR(64) NOT NULL,    -- sha256 hex of Merkle root
    leaf_count          INTEGER NOT NULL,
    op_return_hex       VARCHAR(160) NOT NULL,   -- 4B KYAR + 32B root = 72 hex chars
    status              VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        -- 'PENDING' | 'DRY_RUN' | 'BROADCAST' | 'ANCHORED' | 'FAILED'
    bitcoin_txid        VARCHAR(64),
    fee_sats            INTEGER,
    broadcast_at        TIMESTAMP,
    confirmed_at        TIMESTAMP,
    block_height        BIGINT,
    block_hash          VARCHAR(64),
    confirmations       INTEGER,
    attempts            INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 3,
    last_error          TEXT,
    next_attempt_at     TIMESTAMP,
    -- Cryptographic signature on the CRL JSON body by ROOT key (Phase 5b)
    crl_signature_hex   TEXT,
    crl_signed_by_role  VARCHAR(16),
    crl_signed_by_pubkey VARCHAR(64),
    -- Snapshot of all leaves and tree levels — useful for offline proof verify
    tree_snapshot       JSONB,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_crl_status CHECK (status IN ('PENDING','DRY_RUN','BROADCAST','ANCHORED','FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crl_epoch ON crl_anchors (epoch_id);
CREATE INDEX IF NOT EXISTS idx_crl_status ON crl_anchors (status);
CREATE INDEX IF NOT EXISTS idx_crl_root ON crl_anchors (merkle_root);
CREATE INDEX IF NOT EXISTS idx_crl_txid ON crl_anchors (bitcoin_txid) WHERE bitcoin_txid IS NOT NULL;

COMMENT ON TABLE crl_anchors IS
    'Phase 5: one row per daily CRL epoch. Anchors revocation Merkle root on Bitcoin via KYAR OP_RETURN.';

-- Backward-link FK now that crl_anchors exists
ALTER TABLE revocation_events
    ADD CONSTRAINT fk_revevent_crl_anchor
    FOREIGN KEY (crl_anchor_id) REFERENCES crl_anchors(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- 3. crl_signed_files
-- ----------------------------------------------------------------------------
-- Index of signed daily CRL JSON files (Phase 5b "offline cacheable CRL").
-- The file content is stored on disk under /root/kya-hub/public/crl/ but
-- this row tracks generation metadata + hash for tamper detection.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crl_signed_files (
    id                  BIGSERIAL PRIMARY KEY,
    crl_anchor_id       BIGINT REFERENCES crl_anchors(id) ON DELETE CASCADE,
    epoch_id            INTEGER NOT NULL,
    epoch_label         VARCHAR(32) NOT NULL,
    file_path           TEXT NOT NULL,
    file_sha256         VARCHAR(64) NOT NULL,
    file_size_bytes     INTEGER NOT NULL,
    signed_by_role      VARCHAR(16) NOT NULL,
    signed_by_pubkey    VARCHAR(64) NOT NULL,
    signature_hex       TEXT NOT NULL,
    revocation_count    INTEGER NOT NULL,
    bitcoin_txid        VARCHAR(64),
    merkle_root         VARCHAR(64) NOT NULL,
    generated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crl_signed_epoch ON crl_signed_files (epoch_id);
CREATE INDEX IF NOT EXISTS idx_crl_signed_anchor ON crl_signed_files (crl_anchor_id);

COMMENT ON TABLE crl_signed_files IS
    'Phase 5b: tracks ROOT-signed daily CRL JSON files served from /crl/ for offline verification.';

-- pgcrypto for sha256 digest used in backfill (idempotent)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 4. GRANTs for kyahub_app
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON revocation_events TO kyahub_app;
GRANT SELECT, INSERT, UPDATE ON crl_anchors TO kyahub_app;
GRANT SELECT, INSERT, UPDATE ON crl_signed_files TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE revocation_events_id_seq TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE crl_anchors_id_seq TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE crl_signed_files_id_seq TO kyahub_app;

-- ----------------------------------------------------------------------------
-- 5. Backfill (one-time): emit a revocation_event for every already-revoked
--    cert that has no corresponding row yet. revocation_hash is computed
--    from { cert_serial, kya_id, revoked_at-iso, revocation_reason } so the
--    Merkle commitment over historical revocations remains deterministic.
-- ----------------------------------------------------------------------------
INSERT INTO revocation_events (
    cert_serial, kya_id, agent_id, revoked_at, revoked_by,
    revocation_reason, revocation_category, cert_hash, revocation_hash, detail
)
SELECT
    c.serial,
    c.kya_id,
    c.agent_id,
    c.revoked_at,
    CASE
        WHEN COALESCE(c.revoke_reason, '') ILIKE '%reissued_with_anchor%' THEN 'anchor-worker'
        WHEN COALESCE(c.revoke_reason, '') ILIKE '%gdpr%' THEN 'gdpr_purge'
        WHEN COALESCE(c.revoke_reason, '') ILIKE '%voluntary retire%' THEN 'owner'
        WHEN COALESCE(c.revoke_reason, '') ILIKE '%suspended%' THEN 'reputation-engine'
        ELSE 'system'
    END AS revoked_by,
    LEFT(c.revoke_reason, 500),
    CASE
        WHEN COALESCE(c.revoke_reason, '') ILIKE '%reissued_with_anchor%' THEN 'REISSUED'
        WHEN COALESCE(c.revoke_reason, '') ILIKE '%gdpr%' THEN 'GDPR_PURGE'
        WHEN COALESCE(c.revoke_reason, '') ILIKE '%voluntary retire%' THEN 'VOLUNTARY_RETIRE'
        WHEN COALESCE(c.revoke_reason, '') ILIKE '%suspended%' THEN 'SUSPENDED_ZONE'
        ELSE 'OTHER'
    END AS revocation_category,
    NULL,
    -- Deterministic leaf hash for backfill (NB: live revocations after this
    -- migration use lib/crl.js computeRevocationHash which uses the SAME
    -- canonical form, so leaves are interchangeable across history & live).
    ENCODE(DIGEST(
        c.serial || '|' || c.kya_id || '|' ||
        TO_CHAR(c.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' ||
        COALESCE(LEFT(c.revoke_reason, 500), '')
    , 'sha256'), 'hex'),
    JSONB_BUILD_OBJECT('backfilled', true, 'source', 'migration_009')
FROM certificates c
WHERE c.revoked_at IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM revocation_events r WHERE r.cert_serial = c.serial
  );
