-- ============================================================================
-- UMBRAXON KYA-Hub — Phase 4 (ELITE Production-Ready)
-- ----------------------------------------------------------------------------
-- 1. pending_anchors                — pridáme metadata pre OP_RETURN worker
--      cert_serial            (ktorý cert sa anchoruje)
--      cert_hash              (sha256 canonical cert_body, 32B hex)
--      op_return_hex          (full 36B OP_RETURN payload: KYA1 magic + cert_hash)
--      block_height           (po confirmácii)
--      block_hash             (po confirmácii)
--      max_attempts           (default 3)
--      next_attempt_at        (back-off scheduling)
--      payload_format         (default 'KYA1', umožní budúce verzie)
--
-- 2. agents                          — anchor_status check constraint + block_height
--      anchor_block_height
--
-- 3. webhook_deliveries              — priority queue
--      agent_tier             (BASIC/ELITE/NULL)
--      priority               (1..10, vyššie = skôr)
--      processing_started_at  (worker checkout)
--
-- 4. anchor_audit                    — všetky anchor pokusy, broadcast,
--                                       confirmation, reissue (kompletný forenzný log)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. pending_anchors extension
-- ----------------------------------------------------------------------------
ALTER TABLE pending_anchors
    ADD COLUMN IF NOT EXISTS cert_serial      VARCHAR(64),
    ADD COLUMN IF NOT EXISTS cert_hash        VARCHAR(64),
    ADD COLUMN IF NOT EXISTS op_return_hex    VARCHAR(160),
    ADD COLUMN IF NOT EXISTS block_height     BIGINT,
    ADD COLUMN IF NOT EXISTS block_hash       VARCHAR(64),
    ADD COLUMN IF NOT EXISTS max_attempts     INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS next_attempt_at  TIMESTAMP,
    ADD COLUMN IF NOT EXISTS payload_format   VARCHAR(16) NOT NULL DEFAULT 'KYA1',
    ADD COLUMN IF NOT EXISTS reissued_cert_serial VARCHAR(64);

-- Idempotency: prevent duplicate broadcast of same cert_hash
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_anchor_cert_hash
    ON pending_anchors (cert_hash)
    WHERE cert_hash IS NOT NULL;

-- Worker scheduling index
CREATE INDEX IF NOT EXISTS idx_pending_anchors_next_attempt
    ON pending_anchors (status, next_attempt_at)
    WHERE status IN ('PENDING', 'BROADCAST', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_pending_anchors_txid
    ON pending_anchors (bitcoin_txid)
    WHERE bitcoin_txid IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. agents — anchor block height + status enum widening
-- ----------------------------------------------------------------------------
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS anchor_block_height BIGINT,
    ADD COLUMN IF NOT EXISTS anchor_confirmed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_agents_anchored
    ON agents (anchor_status)
    WHERE anchor_status IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. webhook_deliveries — tier priority
-- ----------------------------------------------------------------------------
ALTER TABLE webhook_deliveries
    ADD COLUMN IF NOT EXISTS agent_tier            VARCHAR(16),
    ADD COLUMN IF NOT EXISTS priority              SMALLINT NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP;

-- Priority queue index — pending webhooks, ELITE first
CREATE INDEX IF NOT EXISTS idx_webhook_priority_pending
    ON webhook_deliveries (priority DESC, received_at ASC)
    WHERE processed = FALSE;

CREATE INDEX IF NOT EXISTS idx_webhook_tier
    ON webhook_deliveries (agent_tier)
    WHERE agent_tier IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. anchor_audit — forensic log
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anchor_audit (
    id              BIGSERIAL PRIMARY KEY,
    pending_anchor_id BIGINT REFERENCES pending_anchors(id) ON DELETE SET NULL,
    agent_id        INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    kya_id          VARCHAR(64),
    event_type      VARCHAR(32) NOT NULL,
        -- 'QUEUED', 'BROADCAST_ATTEMPT', 'BROADCAST_OK', 'BROADCAST_FAIL',
        -- 'CONFIRMED', 'CERT_REISSUED', 'FAILED_TERMINAL', 'FORCED_BY_ADMIN', 'DRY_RUN'
    cert_serial     VARCHAR(64),
    cert_hash       VARCHAR(64),
    bitcoin_txid    VARCHAR(64),
    fee_sats        INTEGER,
    block_height    BIGINT,
    detail          JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_anchor_audit_pa ON anchor_audit (pending_anchor_id);
CREATE INDEX IF NOT EXISTS idx_anchor_audit_kya ON anchor_audit (kya_id);
CREATE INDEX IF NOT EXISTS idx_anchor_audit_event ON anchor_audit (event_type, created_at DESC);

COMMENT ON TABLE anchor_audit IS
    'Phase 4: forensic log of every state transition for OP_RETURN anchors.';

-- ----------------------------------------------------------------------------
-- 5. GRANTs for kyahub_app (least-privilege app role)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON anchor_audit TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE anchor_audit_id_seq TO kyahub_app;
-- pending_anchors / agents / webhook_deliveries / certificates už mali grants z migrácie 001
-- ich nové stĺpce sa automaticky pokryjú existujúcimi table-level grants.
