-- ============================================================================
-- UMBRAXON KYA-Hub — Developer API keys (integrator / plug-in auth)
-- ============================================================================
-- Phase 2 Platform API. Keys are hashed at rest; plain key shown once at create.
-- Scopes gate future write/admin integrator routes; read endpoints stay public.
-- ============================================================================

CREATE TABLE IF NOT EXISTS developer_api_keys (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_prefix          VARCHAR(16) NOT NULL,
    key_hash            VARCHAR(128) NOT NULL UNIQUE,
    label               VARCHAR(128),
    owner_contact       VARCHAR(256),
    scopes              TEXT[] NOT NULL DEFAULT ARRAY['agents:read'],
    tier                VARCHAR(32) NOT NULL DEFAULT 'free',
    rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at        TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    CONSTRAINT chk_devkey_tier CHECK (tier IN ('free', 'pro', 'enterprise'))
);

CREATE INDEX IF NOT EXISTS idx_developer_api_keys_prefix ON developer_api_keys (key_prefix)
    WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON developer_api_keys TO kyahub_app;
