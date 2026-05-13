-- ============================================================================
-- UMBRAXON KYA-Hub — Migration 016: ELITE public listing liveness (heartbeat fees)
-- ============================================================================
-- ELITE cert remains valid; public /api/whitelist/elite only lists agents with
-- elite_listing_status = 'LISTED'. GRACE = delisted but recoverable with 150 SAT
-- heartbeat; DELISTED = requires 5000 SAT reactivation (or one free / calendar year).
-- ============================================================================

BEGIN;

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS elite_listing_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS elite_listing_heartbeat_paid_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS elite_listing_next_due_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS elite_listing_grace_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS elite_listing_miss_streak INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS elite_listing_free_reactivation_year INTEGER;

CREATE TABLE IF NOT EXISTS elite_listing_payment_receipts (
    id              BIGSERIAL PRIMARY KEY,
    invoice_id      VARCHAR(128) NOT NULL,
    payment_hash    VARCHAR(128),
    kya_id          VARCHAR(32) NOT NULL,
    kind            VARCHAR(24) NOT NULL,
    amount_sats     INTEGER NOT NULL,
    source          VARCHAR(16) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_elite_listing_invoice UNIQUE (invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_elite_listing_receipts_kya ON elite_listing_payment_receipts(kya_id);

COMMENT ON COLUMN agents.elite_listing_status IS 'LISTED | GRACE | DELISTED — ELITE public index only when LISTED';
COMMENT ON COLUMN agents.elite_listing_next_due_at IS 'Pay ELITE_LISTING_HEARTBEAT_SATS before this instant to stay LISTED';

-- Backfill existing anchored ELITE agents: treat as paid-through "now", next due +30d
UPDATE agents SET
    elite_listing_status = 'LISTED',
    elite_listing_heartbeat_paid_at = COALESCE(anchor_confirmed_at, verified_at, NOW()),
    elite_listing_next_due_at = COALESCE(anchor_confirmed_at, verified_at, NOW()) + INTERVAL '30 days',
    elite_listing_grace_until = NULL,
    elite_listing_miss_streak = 0
WHERE tier = 'ELITE'
  AND anchor_status = 'ANCHORED'
  AND is_active = TRUE
  AND retired_at IS NULL
  AND (elite_listing_status IS NULL OR elite_listing_next_due_at IS NULL);

GRANT SELECT, INSERT ON elite_listing_payment_receipts TO kyahub_app;
GRANT USAGE ON SEQUENCE elite_listing_payment_receipts_id_seq TO kyahub_app;

COMMIT;
