-- ============================================================================
-- 007 — Phase 2.4 follow-up: Capacity & Performance optimizations
-- ============================================================================
-- Pridáva archive tabuľku pre webhook_deliveries (môže rásť o 1k+ row/deň pri
-- viacerých botoch), grants pre retention worker a indexy pre rýchlejší
-- archivačný SELECT na zvyšných log-tabuľkách.
-- Idempotent — môže byť spustený opakovane.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) webhook_deliveries_archive
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_deliveries_archive (
    id                BIGINT PRIMARY KEY,
    source            VARCHAR(32)  NOT NULL,
    delivery_id       VARCHAR(128) NOT NULL,
    invoice_id        VARCHAR(128),
    event_type        VARCHAR(64)  NOT NULL,
    payload_hash      VARCHAR(64)  NOT NULL,
    processed         BOOLEAN      NOT NULL DEFAULT false,
    processing_result TEXT,
    received_at       TIMESTAMP    NOT NULL,
    processed_at      TIMESTAMP,
    archived_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wh_archive_received_at
    ON webhook_deliveries_archive(received_at);
CREATE INDEX IF NOT EXISTS idx_wh_archive_invoice_id
    ON webhook_deliveries_archive(invoice_id);

-- ----------------------------------------------------------------------------
-- 2) Indexy pre rýchly retention SELECT (covering index na timestamp + id)
-- ----------------------------------------------------------------------------
-- action_log: už má idx na received_at, doplníme partial pre staršie ako 60 dní
CREATE INDEX IF NOT EXISTS idx_action_log_received_at
    ON action_log(received_at);

CREATE INDEX IF NOT EXISTS idx_repevent_occurred_at
    ON reputation_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_reports_created_at
    ON reports(created_at);

CREATE INDEX IF NOT EXISTS idx_certsign_signed_at
    ON cert_signing_log(signed_at);

CREATE INDEX IF NOT EXISTS idx_rejreq_occurred_at
    ON rejected_requests(occurred_at);

-- ----------------------------------------------------------------------------
-- 3) Grants pre kyahub_app (retention worker needs DELETE on webhook_deliveries)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, DELETE ON webhook_deliveries          TO kyahub_app;
GRANT SELECT, INSERT, DELETE ON webhook_deliveries_archive  TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE webhook_deliveries_id_seq    TO kyahub_app;

-- ----------------------------------------------------------------------------
-- 4) heartbeats_log retention preparation (pridávame archive, ak existuje)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='heartbeats_log') THEN
        CREATE TABLE IF NOT EXISTS heartbeats_log_archive (
            LIKE heartbeats_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS
        );
        BEGIN
            ALTER TABLE heartbeats_log_archive
                ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END;
        GRANT SELECT, INSERT, DELETE ON heartbeats_log         TO kyahub_app;
        GRANT SELECT, INSERT, DELETE ON heartbeats_log_archive TO kyahub_app;
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 5) VACUUM-friendly: označiť log tabuľky ako "frequently updated"
-- ----------------------------------------------------------------------------
ALTER TABLE action_log         SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE reputation_events  SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE webhook_deliveries SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE rejected_requests  SET (autovacuum_vacuum_scale_factor = 0.05);

-- DONE
