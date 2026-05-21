-- UMBRAXON KYA-Hub — Migrácia 028: operator sponsor pool codes (growth)

CREATE TABLE IF NOT EXISTS sponsor_pool_codes (
    code VARCHAR(32) PRIMARY KEY,
    tier_name VARCHAR(16) NOT NULL DEFAULT 'BASIC',
    max_uses INTEGER NOT NULL CHECK (max_uses > 0),
    uses_count INTEGER NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
    expires_at TIMESTAMPTZ,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT sponsor_pool_codes_tier_chk CHECK (tier_name IN ('BASIC', 'ELITE'))
);

CREATE TABLE IF NOT EXISTS sponsor_pool_redemptions (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(32) NOT NULL REFERENCES sponsor_pool_codes(code),
    kya_id VARCHAR(32) NOT NULL,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sponsor_pool_redemptions_kya
    ON sponsor_pool_redemptions (kya_id, redeemed_at DESC);

COMMENT ON TABLE sponsor_pool_codes IS
    'Operator-issued registration promo codes (growth). Redeem at register when SPONSOR_POOL_REGISTER_HOOK enabled.';

GRANT SELECT, INSERT, UPDATE ON sponsor_pool_codes TO kyahub_app;
GRANT SELECT, INSERT ON sponsor_pool_redemptions TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE sponsor_pool_redemptions_id_seq TO kyahub_app;
