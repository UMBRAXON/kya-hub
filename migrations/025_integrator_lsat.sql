-- ============================================================================
-- UMBRAXON KYA-Hub — Integrator LSAT-style API access tokens (paid day pass)
-- ============================================================================

CREATE TABLE IF NOT EXISTS integrator_lsat_orders (
    access_id           VARCHAR(64) PRIMARY KEY,
    integrator_key_id   UUID REFERENCES developer_api_keys(id) ON DELETE SET NULL,
    amount_sats         INTEGER NOT NULL,
    invoice_id          VARCHAR(128),
    bolt11              TEXT,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    token_hash          VARCHAR(128),
    token_prefix        VARCHAR(16),
    scopes              TEXT[] NOT NULL DEFAULT ARRAY['agents:read'],
    rate_limit_per_min  INTEGER NOT NULL DEFAULT 300,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at             TIMESTAMPTZ,
    CONSTRAINT chk_lsat_status CHECK (status IN ('pending', 'paid', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_lsat_orders_invoice ON integrator_lsat_orders (invoice_id);
CREATE INDEX IF NOT EXISTS idx_lsat_orders_token ON integrator_lsat_orders (token_hash) WHERE token_hash IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON integrator_lsat_orders TO kyahub_app;
