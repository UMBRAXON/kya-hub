-- Integrator API key requests (self-serve form → operator approve)

BEGIN;

CREATE TABLE IF NOT EXISTS integrator_key_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization    VARCHAR(128) NOT NULL,
    contact_email   VARCHAR(256) NOT NULL,
    use_case        TEXT NOT NULL,
    website         VARCHAR(256),
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',
    approved_key_id UUID REFERENCES developer_api_keys(id),
    client_ip       INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at     TIMESTAMPTZ,
    admin_notes     TEXT,
    CONSTRAINT chk_integrator_key_req_status
        CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_integrator_key_requests_status
    ON integrator_key_requests (status, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON integrator_key_requests TO kyahub_app;

COMMIT;
