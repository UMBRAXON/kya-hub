-- ============================================================================
-- UMBRAXON KYA-Hub — Migrácia 021: M2M Lightning node lookup index
-- ============================================================================

BEGIN;

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS lightning_node_id VARCHAR(128);

COMMENT ON COLUMN agents.lightning_node_id IS
    'Lightning node pubkey or node@host from manifest payment_hints (type=lightning_node_id) at registration.';

CREATE INDEX IF NOT EXISTS idx_agents_lightning_node_id
    ON agents (lightning_node_id)
    WHERE lightning_node_id IS NOT NULL AND lightning_node_id <> '';

CREATE INDEX IF NOT EXISTS idx_intents_ln_node
    ON registration_intents (agent_pubkey, status)
    WHERE status = 'PENDING_PAYMENT';

COMMIT;
