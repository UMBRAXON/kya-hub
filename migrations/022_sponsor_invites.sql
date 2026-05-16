-- ============================================================================
-- UMBRAXON KYA-Hub — Sponsor invites (PoW bypass for invited registration)
-- ============================================================================
-- Requires: agents, manufacturers, registration_intents (Phase 4B+)
-- Feature flag: SPONSOR_INVITE_ENABLED (default off in .env)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sponsor_invites (
    id                      BIGSERIAL PRIMARY KEY,
    invite_id               VARCHAR(64) NOT NULL UNIQUE,
    sponsor_kind            VARCHAR(16) NOT NULL,
        -- 'AGENT' | 'MANUFACTURER'
    sponsor_agent_kya_id    VARCHAR(64),
    sponsor_manufacturer_id INTEGER REFERENCES manufacturers(id) ON DELETE SET NULL,
    sponsor_manufacturer_ext_id VARCHAR(64),
    invitee_pubkey          VARCHAR(64) NOT NULL,
    expected_agent_name     VARCHAR(64),
    tier_requested          VARCHAR(16) NOT NULL,
    status                  VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        -- 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'REVOKED'
    expires_at              TIMESTAMP NOT NULL,
    consumed_at             TIMESTAMP,
    consumed_agent_kya_id   VARCHAR(64),
    registration_intent_id  VARCHAR(64),
    client_ip               INET,
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_sinv_kind CHECK (sponsor_kind IN ('AGENT', 'MANUFACTURER')),
    CONSTRAINT chk_sinv_status CHECK (status IN ('PENDING', 'CONSUMED', 'EXPIRED', 'REVOKED')),
    CONSTRAINT chk_sinv_tier CHECK (tier_requested IN ('BASIC', 'ELITE')),
    CONSTRAINT chk_sinv_pubkey CHECK (invitee_pubkey ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_sinv_status_expires ON sponsor_invites (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_sinv_invitee_pubkey ON sponsor_invites (invitee_pubkey);
CREATE INDEX IF NOT EXISTS idx_sinv_sponsor_agent ON sponsor_invites (sponsor_agent_kya_id)
    WHERE sponsor_agent_kya_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sinv_sponsor_mfr ON sponsor_invites (sponsor_manufacturer_id)
    WHERE sponsor_manufacturer_id IS NOT NULL;

COMMENT ON TABLE sponsor_invites IS
    'One-time registration invites: bind invitee_pubkey, bypass PoW on /api/v1/register (not payment).';

CREATE TABLE IF NOT EXISTS sponsor_invite_events (
    id                  BIGSERIAL PRIMARY KEY,
    invite_id           VARCHAR(64) NOT NULL REFERENCES sponsor_invites(invite_id) ON DELETE CASCADE,
    event_type          VARCHAR(32) NOT NULL,
        -- ISSUED | CONSUMED | EXPIRED | REVOKED | INVITEE_CRL | INVITEE_SLASH | SPONSOR_PENALIZED | SPONSOR_SUSPENDED
    agent_kya_id        VARCHAR(64),
    metadata            JSONB,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sinv_ev_invite ON sponsor_invite_events (invite_id, created_at DESC);

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS sponsor_invite_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS sponsored_by_kya_id VARCHAR(64);

ALTER TABLE registration_intents
    ADD COLUMN IF NOT EXISTS sponsor_invite_id VARCHAR(64);

-- Agent sponsors: monthly invite quota helper (rolling calendar month)
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS sponsor_invites_issued_month CHAR(7),
    ADD COLUMN IF NOT EXISTS sponsor_invites_issued_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS sponsor_invite_suspended_until TIMESTAMP;

COMMENT ON COLUMN agents.sponsor_invites_issued_month IS 'YYYY-MM calendar month for sponsor_invites_issued_count reset.';

GRANT SELECT, INSERT, UPDATE ON sponsor_invites TO kyahub_app;
GRANT SELECT, INSERT ON sponsor_invite_events TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE sponsor_invites_id_seq TO kyahub_app;
GRANT USAGE, SELECT ON SEQUENCE sponsor_invite_events_id_seq TO kyahub_app;
