-- ============================================================================
-- UMBRAXON KYA-Hub — Migrácia 005: Phase 2.3 Trust & Governance Layer
-- ============================================================================
-- Pridáva:
--   - hub_keys: tier-separated signing keys (BASIC/ELITE/ROOT) s rotation support
--   - cert_signing_log: audit log každého cert podpisu (forensics + abuse detection)
--   - appeals: dispute resolution flow pre signed odvolania botov
--   - heartbeats_log: nonce idempotency pre heartbeat (replay protection)
--   - agents: status RETIRED + pubkey blacklist + retired_at/reason
--   - reports: report_nonce UNIQUE per reporter (replay protection)
--   - certificates: signing_key_id (audit ktorý hub key podpísal cert)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) hub_keys — tier-separated signing keys
-- ----------------------------------------------------------------------------
-- BASIC: online key, podpisuje BASIC certs (low-risk)
-- ELITE: cold/restricted key, podpisuje iba ELITE certs (vyžaduje admin gate)
-- ROOT:  master key, slúži iba na rotation iných kľúčov (nikdy nepodpisuje certs)
-- DEPRECATED keys ostávajú pre cert verify (dual-verify rotation window, default 30 dní)

CREATE TABLE IF NOT EXISTS hub_keys (
    id BIGSERIAL PRIMARY KEY,
    key_id VARCHAR(32) UNIQUE NOT NULL,         -- napr. HUB-BASIC-001, HUB-ELITE-002
    role VARCHAR(16) NOT NULL,                  -- BASIC | ELITE | ROOT
    alg VARCHAR(16) NOT NULL DEFAULT 'Ed25519',
    pubkey_hex VARCHAR(64) NOT NULL UNIQUE,     -- 32B raw hex (verejný, audit-friendly)
    -- privkey sa NEUKLADÁ do DB — žije v .env (encrypted) alebo HSM
    -- Tu len sledujeme metadata pre rotation a audit
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | DEPRECATED | REVOKED
    
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deprecated_at TIMESTAMP,
    revoked_at TIMESTAMP,
    deprecation_reason TEXT,
    replaces_key_id VARCHAR(32),                -- ak rotation, link na predchodcu
    
    notes TEXT,
    created_by VARCHAR(64) DEFAULT 'system',
    
    CONSTRAINT hub_keys_role_chk CHECK (role IN ('BASIC', 'ELITE', 'ROOT')),
    CONSTRAINT hub_keys_status_chk CHECK (status IN ('ACTIVE', 'DEPRECATED', 'REVOKED'))
);

-- Iba 1 ACTIVE key per role
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hub_keys_active_role
    ON hub_keys (role) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_hub_keys_pubkey ON hub_keys(pubkey_hex);
CREATE INDEX IF NOT EXISTS idx_hub_keys_role_status ON hub_keys(role, status);


-- ----------------------------------------------------------------------------
-- 2) cert_signing_log — audit každého podpisu certifikátu
-- ----------------------------------------------------------------------------
-- Forenzika: ak niekto získa privkey a začne fake-issue certifikáty mimo hubu,
-- pravdivé certifikáty sú vždy v tomto logu. Mass-issue anomaly detection na
-- tom mieste (sliding window > N podpisov za hodinu → admin alert).

CREATE TABLE IF NOT EXISTS cert_signing_log (
    id BIGSERIAL PRIMARY KEY,
    serial VARCHAR(64),                          -- CERT serial (NULL pre non-cert sign ops, napr. agent.action verify-loop)
    kya_id VARCHAR(64),
    key_id VARCHAR(32) NOT NULL,                 -- foreign key na hub_keys.key_id
    role VARCHAR(16) NOT NULL,                   -- BASIC/ELITE/ROOT
    
    signing_purpose VARCHAR(32) NOT NULL,        -- 'cert_issue' | 'cert_reissue' | 'cert_revoke_attest' | 'misc_sign'
    message_hash VARCHAR(64) NOT NULL,           -- sha256 message ktorý sa podpisoval
    signature_prefix VARCHAR(16),                -- prvých 16 hex zo signature (audit-print friendly)
    
    requested_by_admin VARCHAR(64),              -- ak išlo o admin-triggered reissue
    requested_by_ip INET,
    
    signed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    -- Anomálie flag: po post-mortem analýze môže admin nastaviť
    anomaly_flagged BOOLEAN DEFAULT FALSE,
    anomaly_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_signlog_recent ON cert_signing_log(signed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signlog_kya ON cert_signing_log(kya_id, signed_at DESC) WHERE kya_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signlog_key ON cert_signing_log(key_id, signed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signlog_anomaly ON cert_signing_log(anomaly_flagged, signed_at DESC) WHERE anomaly_flagged = TRUE;


-- ----------------------------------------------------------------------------
-- 3) appeals — dispute resolution flow
-- ----------------------------------------------------------------------------
-- Operátor bota môže podať signed appeal proti konkrétnemu reputation_event
-- (auto-slash, anomaly-slash, peer report apply, atď.). Admin to v 72h prejde
-- a buď UPHELD (reverse event) alebo DISMISSED (no-op). Bez admin akcie sa po
-- SLA automaticky UPHELD (failsafe pro-agent).

CREATE TABLE IF NOT EXISTS appeals (
    id BIGSERIAL PRIMARY KEY,
    
    -- Predmet apelácie
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kya_id VARCHAR(64) NOT NULL,
    against_event_id BIGINT REFERENCES reputation_events(id) ON DELETE SET NULL,
    against_event_type VARCHAR(48),              -- snapshot eventu (kvôli audit aj keď event je zmazaný)
    against_delta INTEGER,                       -- snapshot delta
    
    -- Status
    status VARCHAR(24) NOT NULL DEFAULT 'PENDING',  -- PENDING | UPHELD | DISMISSED | EXPIRED_AUTO_UPHELD | WITHDRAWN
    priority VARCHAR(16) NOT NULL DEFAULT 'NORMAL', -- LOW | NORMAL | HIGH (escalated)
    
    -- Submitter (kryptograficky overený operator)
    submitted_by_pubkey VARCHAR(64) NOT NULL,    -- musí sa zhodovať s agents.agent_pubkey
    appeal_text TEXT NOT NULL,                   -- 20-4000 chars
    evidence JSONB,                              -- voliteľné štruktúrované evidence
    evidence_hash VARCHAR(64),                   -- sha256 evidence pre cert anchor (Phase 3)
    
    -- Replay protection
    signature VARCHAR(256) NOT NULL,             -- Ed25519 signature nad canonical payload
    nonce VARCHAR(64) NOT NULL,                  -- unique per submitter
    bot_timestamp TIMESTAMP,                     -- klientske timestamp
    
    -- Lifecycle
    submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sla_deadline TIMESTAMP NOT NULL,             -- typicky submitted_at + 72h
    resolved_at TIMESTAMP,
    resolved_by VARCHAR(64),
    admin_resolution VARCHAR(32),                -- UPHELD | DISMISSED | AUTO_UPHELD_SLA
    resolution_note TEXT,
    reverse_event_id BIGINT REFERENCES reputation_events(id) ON DELETE SET NULL, -- ak UPHELD, ID reverz eventu
    
    -- Network audit
    client_ip INET,
    user_agent TEXT,
    
    CONSTRAINT appeals_status_chk CHECK (status IN ('PENDING', 'UPHELD', 'DISMISSED', 'EXPIRED_AUTO_UPHELD', 'WITHDRAWN')),
    CONSTRAINT appeals_priority_chk CHECK (priority IN ('LOW', 'NORMAL', 'HIGH'))
);

-- 1 appeal per (agent, event) — bot nemôže donekonečna re-appealovať
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appeal_per_event
    ON appeals (kya_id, against_event_id)
    WHERE against_event_id IS NOT NULL;

-- Replay: ten istý nonce od toho istého pubkey nemôže byť dvakrát
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appeal_nonce
    ON appeals (submitted_by_pubkey, nonce);

CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status, sla_deadline);
CREATE INDEX IF NOT EXISTS idx_appeals_kya ON appeals(kya_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_appeals_pending ON appeals(sla_deadline) WHERE status = 'PENDING';


-- ----------------------------------------------------------------------------
-- 4) heartbeats_log — replay protection pre heartbeat
-- ----------------------------------------------------------------------------
-- Heartbeat doteraz nebol replay-protected. Pridáme UNIQUE(kya_id, nonce).
-- Cleanup: rows staršie ako 24h sa mažú (heartbeat replay window je krátky).

CREATE TABLE IF NOT EXISTS heartbeats_log (
    id BIGSERIAL PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kya_id VARCHAR(64) NOT NULL,
    nonce VARCHAR(64) NOT NULL,
    
    client_ip INET,
    bot_timestamp TIMESTAMP,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT heartbeats_idem UNIQUE (kya_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_hb_agent_recent ON heartbeats_log(agent_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_hb_cleanup ON heartbeats_log(received_at);


-- ----------------------------------------------------------------------------
-- 5) Rozšírenie agents — RETIRED state + pubkey blacklist
-- ----------------------------------------------------------------------------
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS retired_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS retire_reason TEXT,
    ADD COLUMN IF NOT EXISTS retire_signature VARCHAR(256),  -- proof že to bol skutočne owner
    ADD COLUMN IF NOT EXISTS pubkey_blacklisted BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_agents_retired ON agents(retired_at) WHERE retired_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_blacklist ON agents(agent_pubkey) WHERE pubkey_blacklisted = TRUE;


-- ----------------------------------------------------------------------------
-- 6) reports — replay protection cez nonce
-- ----------------------------------------------------------------------------
ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS report_nonce VARCHAR(64),
    ADD COLUMN IF NOT EXISTS report_timestamp TIMESTAMP;

-- UNIQUE iba pre signed reports (reporter_pubkey NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reports_replay
    ON reports (reporter_pubkey, report_nonce)
    WHERE reporter_pubkey IS NOT NULL AND report_nonce IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 7) certificates — link na signing key (pre rotation audit)
-- ----------------------------------------------------------------------------
ALTER TABLE certificates
    ADD COLUMN IF NOT EXISTS signing_key_id VARCHAR(32);   -- foreign key na hub_keys.key_id

CREATE INDEX IF NOT EXISTS idx_certs_signing_key ON certificates(signing_key_id) WHERE signing_key_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 8) Grants
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON hub_keys TO kyahub_app;
GRANT USAGE ON SEQUENCE hub_keys_id_seq TO kyahub_app;

GRANT SELECT, INSERT, UPDATE ON cert_signing_log TO kyahub_app;
GRANT USAGE ON SEQUENCE cert_signing_log_id_seq TO kyahub_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON appeals TO kyahub_app;
GRANT USAGE ON SEQUENCE appeals_id_seq TO kyahub_app;

GRANT SELECT, INSERT, DELETE ON heartbeats_log TO kyahub_app;
GRANT USAGE ON SEQUENCE heartbeats_log_id_seq TO kyahub_app;


COMMIT;
