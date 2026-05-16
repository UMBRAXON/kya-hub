-- ============================================================================
-- UMBRAXON KYA-Hub — Developer webhook outbox (retry queue)
-- ============================================================================
-- Outbound integrator webhooks (manifest developer_webhooks) with backoff.
-- Separate from webhook_deliveries (inbound BTCPay/Alby idempotency).
-- ============================================================================

CREATE TABLE IF NOT EXISTS developer_webhook_outbox (
    id                  BIGSERIAL PRIMARY KEY,
    delivery_id         VARCHAR(64) NOT NULL UNIQUE,
    kya_id              VARCHAR(64) NOT NULL,
    event               VARCHAR(64) NOT NULL,
    target_url          TEXT NOT NULL,
    payload             JSONB NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 5,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_http_status    INTEGER,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at        TIMESTAMPTZ,
    CONSTRAINT chk_devwh_status CHECK (status IN ('pending', 'delivered', 'failed', 'dead'))
);

CREATE INDEX IF NOT EXISTS idx_devwh_outbox_pending
    ON developer_webhook_outbox (next_attempt_at ASC)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_devwh_outbox_kya
    ON developer_webhook_outbox (kya_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON developer_webhook_outbox TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE developer_webhook_outbox_id_seq TO kyahub_app;
