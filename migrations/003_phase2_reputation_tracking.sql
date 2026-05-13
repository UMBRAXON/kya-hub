-- ============================================================================
-- UMBRAXON KYA-Hub — Migrácia 003: Phase 2 Reputation Tracking
-- ============================================================================
-- Pridáva:
--   - Tabuľka reputation_events (audit log všetkých score zmien)
--   - Tabuľka reports (external reports proti agentom)
--   - Tabuľka action_log (signed self-reports botov, idempotent cez nonce)
--   - Stĺpce v agents pre liveness tracking + dormancy
--   - Index na rýchle vyhľadávanie posledných eventov per agent
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Rozšírenie tabuľky agents — liveness
-- ----------------------------------------------------------------------------
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS heartbeat_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_dormant BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS last_score_change_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(last_heartbeat_at) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_agents_dormant ON agents(is_dormant) WHERE is_dormant = TRUE;


-- ----------------------------------------------------------------------------
-- 2) Tabuľka reputation_events — kompletný audit log
-- ----------------------------------------------------------------------------
-- Každá zmena skóre (slashing/bonus/decay) sa zapíše tu. Slúži ako audit trail
-- a podklad pre history endpoint. NIKDY sa nemaže (append-only).

CREATE TABLE IF NOT EXISTS reputation_events (
    id BIGSERIAL PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kya_id VARCHAR(64) NOT NULL,
    
    -- Event metadata
    event_type VARCHAR(48) NOT NULL,        -- napr. SUCCESSFUL_OPERATION, FRAUD_PROVEN, DECAY_INACTIVITY
    source VARCHAR(32) NOT NULL,            -- 'self', 'peer', 'admin', 'system', 'decay'
    delta INTEGER NOT NULL,                 -- +1, -50, atď.
    score_before INTEGER NOT NULL,
    score_after INTEGER NOT NULL,
    zone_before VARCHAR(16),
    zone_after VARCHAR(16),
    
    -- Context
    reason TEXT,                            -- ľudský popis (napr. "FRAUD report #42 approved by admin")
    evidence JSONB,                         -- arbitrary structured data (txid, hash, ...)
    
    -- Reference na zdroj eventu
    reporter_kya_id VARCHAR(64),            -- ak je source='peer'
    reporter_pubkey VARCHAR(64),            -- raw Ed25519 pubkey reportéra
    related_report_id BIGINT,               -- ak je source='peer' alebo 'admin', odkaz na reports.id
    related_action_id BIGINT,               -- ak je source='self', odkaz na action_log.id
    admin_user VARCHAR(64),                 -- ak source='admin', kto to urobil
    
    -- Network
    client_ip INET,
    user_agent TEXT,
    
    -- Timing
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_repevents_agent ON reputation_events(agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_repevents_kya ON reputation_events(kya_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_repevents_type ON reputation_events(event_type);


-- ----------------------------------------------------------------------------
-- 3) Tabuľka reports — external reports proti agentom
-- ----------------------------------------------------------------------------
-- Niekto (peer agent, anonymný user, admin) reportuje zlé správanie.
-- Auto-aplikované sú len peer reports od trusted reporters (zóna ≥ NEUTRAL).
-- Serious slashing vyžaduje admin review (PENDING_REVIEW → RESOLVED).

CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    
    -- Target
    target_agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    target_kya_id VARCHAR(64) NOT NULL,
    
    -- Report content
    report_type VARCHAR(48) NOT NULL,       -- FRAUD, SPAM, POOR_QUALITY, MISCONDUCT, FALSE_CLAIMS
    description TEXT NOT NULL,
    evidence JSONB,                         -- { url, txid, hash, peer_signatures, ... }
    
    -- Reporter (voliteľné — môže byť anonymný)
    reporter_kya_id VARCHAR(64),            -- ak peer
    reporter_pubkey VARCHAR(64),            -- ak peer alebo signed user
    reporter_signature VARCHAR(256),         -- ak peer/signed user (Ed25519 nad description+evidence)
    reporter_ip INET,
    
    -- Lifecycle
    status VARCHAR(24) NOT NULL DEFAULT 'PENDING_REVIEW',  -- AUTO_APPLIED, PENDING_REVIEW, RESOLVED_VALID, RESOLVED_INVALID, DUPLICATE, ESCALATED
    auto_applied_delta INTEGER,             -- ak AUTO_APPLIED (peer report), aký delta sa pridal
    resolution VARCHAR(32),                 -- VALID, INVALID, INSUFFICIENT_EVIDENCE, OUT_OF_SCOPE
    resolution_delta INTEGER,                -- delta pri RESOLVED_VALID
    resolution_note TEXT,
    resolved_by VARCHAR(64),                 -- admin user
    
    -- Timing
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_kya_id) WHERE reporter_kya_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(report_type);


-- ----------------------------------------------------------------------------
-- 4) Tabuľka action_log — signed self-reports botov
-- ----------------------------------------------------------------------------
-- Bot hlási svoje akcie (success/fail). Idempotent cez (kya_id, nonce).
-- Nie všetky actions menia skóre — niektoré sú iba audit (napr. USER_INTERACTION).
-- Pravidlá mapovania action_type → delta sú v lib/reputation.js (SELF_ACTION_RULES).

CREATE TABLE IF NOT EXISTS action_log (
    id BIGSERIAL PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kya_id VARCHAR(64) NOT NULL,
    
    action_type VARCHAR(48) NOT NULL,       -- VERIFICATION_SUCCESS, VERIFICATION_FAIL, ...
    target TEXT,                            -- voľný identifikátor (user-xxx, tx-hash, atď.)
    context JSONB,
    evidence_hash VARCHAR(64),              -- voliteľný sha256 evidencie (proof)
    
    -- Signature (povinný — bot dokazuje že action skutočne pochádza od neho)
    signature VARCHAR(256) NOT NULL,
    nonce VARCHAR(64) NOT NULL,              -- unique per (kya_id, nonce) → idempotency
    
    -- Outcome
    score_delta INTEGER NOT NULL DEFAULT 0,  -- 0 ak je len logged, +/- ak menil skóre
    rate_limited BOOLEAN DEFAULT FALSE,      -- ak rate-limit zabránil aplikácii
    rejected_reason TEXT,                    -- ak rejected (bad sig, replay, atď.)
    
    -- Timing
    bot_timestamp TIMESTAMP,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT action_log_idem UNIQUE (kya_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_action_agent ON action_log(agent_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_type ON action_log(action_type);


-- ----------------------------------------------------------------------------
-- 5) Grants pre kyahub_app
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON reputation_events TO kyahub_app;
GRANT USAGE ON SEQUENCE reputation_events_id_seq TO kyahub_app;

GRANT SELECT, INSERT, UPDATE ON reports TO kyahub_app;
GRANT USAGE ON SEQUENCE reports_id_seq TO kyahub_app;

GRANT SELECT, INSERT, UPDATE ON action_log TO kyahub_app;
GRANT USAGE ON SEQUENCE action_log_id_seq TO kyahub_app;

-- Update existujúce certificate rights na revocation
-- (UPDATE už grantovaný v 002 — len si potvrdíme že kyahub_app smie revokovať)


COMMIT;
