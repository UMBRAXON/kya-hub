-- ============================================================================
-- UMBRAXON KYA-Hub — Phase 4B (Manufacturer Onboarding)
-- ----------------------------------------------------------------------------
-- B2B trust layer: AI agent manufacturers register themselves with KYA-Hub,
-- get admin-verified after KYC, then sign pre-attestations for the agents
-- they produce. Agents arriving with a valid manufacturer attestation get:
--   - `manufacturer_verified=true` flag on the agent row (already supported
--     in lib/sybil-resistance.js — 1.20× weight bonus)
--   - +50 starting reputation bonus (BASIC: 500+50, ELITE: 900+50)
--   - First-class manufacturer info in the issued certificate
--
-- Difference from prior `TRUSTED_MANUFACTURERS` env-var list (Phase 1.5):
--   - DB-backed (queryable, admin-mutable, auditable) instead of an env list
--   - Verified-at-time-of-onboarding (KYC by operator) instead of static trust
--   - Per-mfr tier (BRONZE/SILVER/GOLD) reflecting due diligence depth
--   - Per-agent attestation records (forensic trail: who attested what when)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. manufacturers
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manufacturers (
    id                  SERIAL PRIMARY KEY,
    manufacturer_id     VARCHAR(64) NOT NULL UNIQUE,        -- e.g. "UMBRAXON_LAB"
    name                VARCHAR(128) NOT NULL,
    legal_entity        VARCHAR(255),
    country             VARCHAR(8),                          -- ISO 3166-1 alpha-2
    contact_email       VARCHAR(255),
    homepage            TEXT,
    description         TEXT,
    pubkey_ed25519      VARCHAR(64) NOT NULL UNIQUE,         -- 32B hex
    status              VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        -- 'PENDING' | 'VERIFIED' | 'SUSPENDED' | 'REVOKED'
    tier                VARCHAR(16) NOT NULL DEFAULT 'BRONZE',
        -- 'BRONZE' | 'SILVER' | 'GOLD' — higher tier = stronger KYC + bigger rep bonus
    rep_bonus           INTEGER NOT NULL DEFAULT 50,         -- starting-score bonus per attested agent
    verified_at         TIMESTAMP,
    verified_by         VARCHAR(64),                          -- admin user
    suspended_at        TIMESTAMP,
    suspended_by        VARCHAR(64),
    suspend_reason      TEXT,
    revoked_at          TIMESTAMP,
    revoked_by          VARCHAR(64),
    revoke_reason       TEXT,
    -- KYC payload (operator notes; intentionally free-form JSONB)
    kyc_metadata        JSONB,
    -- counters (maintained by triggers / app code)
    attestation_count   INTEGER NOT NULL DEFAULT 0,
    agent_count         INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_mfr_status CHECK (status IN ('PENDING','VERIFIED','SUSPENDED','REVOKED')),
    CONSTRAINT chk_mfr_tier   CHECK (tier IN ('BRONZE','SILVER','GOLD')),
    CONSTRAINT chk_mfr_pubkey_hex CHECK (pubkey_ed25519 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_mfr_mid CHECK (manufacturer_id ~ '^[A-Z0-9_]+$')
);

CREATE INDEX IF NOT EXISTS idx_mfr_status ON manufacturers (status);
CREATE INDEX IF NOT EXISTS idx_mfr_tier ON manufacturers (tier);

COMMENT ON TABLE manufacturers IS
    'Phase 4B: trusted AI agent manufacturer registry. Replaces static TRUSTED_MANUFACTURERS env var.';

-- ----------------------------------------------------------------------------
-- 2. manufacturer_attestations
-- ----------------------------------------------------------------------------
-- One row per attestation submitted by a manufacturer. The manufacturer
-- signs the canonical hash of an agent manifest (BEFORE the agent registers)
-- and submits it to KYA-Hub via POST /api/manufacturer/attestation. When the
-- agent later registers with that exact manifest hash, the attestation is
-- consumed (linked via agent_id) and the agent inherits manufacturer_verified.
--
-- Attestation uniqueness: (manufacturer_id, agent_manifest_hash). An mfr can
-- attest the same hash twice (idempotency) but only one row stored.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manufacturer_attestations (
    id                  BIGSERIAL PRIMARY KEY,
    manufacturer_id     INTEGER NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
    manufacturer_ext_id VARCHAR(64) NOT NULL,         -- denormalized for fast lookup
    agent_manifest_hash VARCHAR(64) NOT NULL,         -- 32B hex
    expected_agent_pubkey VARCHAR(64),                 -- optional pin (mfr commits to which bot)
    expected_agent_name VARCHAR(64),                  -- optional pin
    mfr_signature       VARCHAR(128) NOT NULL,        -- Ed25519 64B hex
    attestation_metadata JSONB,                        -- free-form notes (model, sku, build_id...)
    attested_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at          TIMESTAMP,                     -- optional: mfr-imposed validity window
    -- Lifecycle
    agent_id            INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    consumed_at         TIMESTAMP,                     -- when the agent registered using this attestation
    revoked_at          TIMESTAMP,
    revoked_by          VARCHAR(64),                   -- 'mfr' | admin user
    revoke_reason       TEXT,
    CONSTRAINT chk_att_mhash CHECK (agent_manifest_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_att_sig   CHECK (mfr_signature ~ '^[0-9a-f]{128}$'),
    CONSTRAINT chk_att_pubkey CHECK (expected_agent_pubkey IS NULL OR expected_agent_pubkey ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mfr_attestation
    ON manufacturer_attestations (manufacturer_id, agent_manifest_hash);

CREATE INDEX IF NOT EXISTS idx_mfr_att_hash ON manufacturer_attestations (agent_manifest_hash);
CREATE INDEX IF NOT EXISTS idx_mfr_att_pubkey ON manufacturer_attestations (expected_agent_pubkey)
    WHERE expected_agent_pubkey IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mfr_att_pending
    ON manufacturer_attestations (attested_at DESC)
    WHERE agent_id IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mfr_att_agent ON manufacturer_attestations (agent_id) WHERE agent_id IS NOT NULL;

COMMENT ON TABLE manufacturer_attestations IS
    'Phase 4B: signed pre-attestations from manufacturers for agents they produce. Consumed on agent registration.';

-- ----------------------------------------------------------------------------
-- 3. Optional FK from agents.manufacturer_id (existing VARCHAR column) to
--    manufacturers.manufacturer_id — we do NOT enforce this as a hard FK
--    because legacy agents may have manufacturer_id values from the env-var
--    era that no longer correspond to a DB row.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_agents_mfr_id ON agents (manufacturer_id)
    WHERE manufacturer_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. updated_at trigger for manufacturers
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _mfr_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_manufacturers_updated_at ON manufacturers;
CREATE TRIGGER trg_manufacturers_updated_at
    BEFORE UPDATE ON manufacturers
    FOR EACH ROW EXECUTE FUNCTION _mfr_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 5. registration_intents: link to consumed attestation
--    (so the finalisation step in registerAgent() can call
--    markAttestationConsumed without re-running the lookup)
-- ----------------------------------------------------------------------------
ALTER TABLE registration_intents
    ADD COLUMN IF NOT EXISTS mfr_attestation_id BIGINT,
    ADD COLUMN IF NOT EXISTS mfr_tier VARCHAR(16);

-- ----------------------------------------------------------------------------
-- 6. agents: per-agent attestation pointer (for forensic lookups)
-- ----------------------------------------------------------------------------
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS mfr_attestation_id BIGINT,
    ADD COLUMN IF NOT EXISTS mfr_tier VARCHAR(16);

CREATE INDEX IF NOT EXISTS idx_agents_mfr_att ON agents (mfr_attestation_id)
    WHERE mfr_attestation_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 7. GRANTs for kyahub_app
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON manufacturers TO kyahub_app;
GRANT SELECT, INSERT, UPDATE ON manufacturer_attestations TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE manufacturers_id_seq TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE manufacturer_attestations_id_seq TO kyahub_app;
