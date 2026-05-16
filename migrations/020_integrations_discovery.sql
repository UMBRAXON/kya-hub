-- ============================================================================
-- UMBRAXON KYA-Hub — Migrácia 020: discovery_opt_in + delegation_pass audit
-- ============================================================================
-- Non-custodial integrations: public discovery index flag + optional short-lived
-- delegation pass ledger (audit / future revoke-by-jti).
-- ============================================================================

BEGIN;

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS discovery_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN agents.discovery_opt_in IS
    'TRUE when manifest.integrations.discovery_opt_in was true at registration; used for /api/discovery feed.';

CREATE INDEX IF NOT EXISTS idx_agents_discovery_opt_in
    ON agents (discovery_opt_in, tier, reputation_score DESC)
    WHERE discovery_opt_in = TRUE AND is_active = TRUE AND status = 'VERIFIED';

CREATE TABLE IF NOT EXISTS delegation_pass_ledger (
    jti                 VARCHAR(64) PRIMARY KEY,
    kya_id              VARCHAR(64) NOT NULL,
    agent_id            INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    caveats_hash        VARCHAR(64) NOT NULL,
    issued_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at          TIMESTAMP NOT NULL,
    client_ip           INET
);

CREATE INDEX IF NOT EXISTS idx_delegation_pass_kya
    ON delegation_pass_ledger (kya_id, issued_at DESC);

COMMENT ON TABLE delegation_pass_ledger IS
    'Audit trail of hub-issued KYA delegation passes (L402-style); hub never holds spend authority.';

GRANT SELECT, INSERT ON delegation_pass_ledger TO kyahub_app;

CREATE TABLE IF NOT EXISTS delegation_request_nonces (
    kya_id      VARCHAR(64) NOT NULL,
    nonce       VARCHAR(64) NOT NULL,
    used_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (kya_id, nonce)
);

COMMENT ON TABLE delegation_request_nonces IS
    'Replay protection for POST /api/agent/:kya_id/delegation-pass (agent-signed request).';

GRANT SELECT, INSERT ON delegation_request_nonces TO kyahub_app;

COMMIT;
