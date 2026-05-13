-- ============================================================================
-- UMBRAXON KYA-Hub — Migrácia 002: Phase 1.5 Identity & Certificates
-- ============================================================================
-- Pridáva:
--   - Tabuľka certificates (vystavené podpísané certifikáty agentov)
--   - Tabuľka auth_challenges (nonces pre challenge-response autentifikáciu)
--   - Tabuľka registration_intents (preauth fáza pred platbou)
--   - Nové stĺpce v agents pre manifest hash, manufacturer, cert signature
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Rozšírenie tabuľky agents
-- ----------------------------------------------------------------------------
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS protocol_version VARCHAR(16) DEFAULT '1.0',
    ADD COLUMN IF NOT EXISTS manifest_hash VARCHAR(64),       -- sha256 of canonical manifest
    ADD COLUMN IF NOT EXISTS manifest_signature TEXT,          -- bot Ed25519 signature (hex)
    ADD COLUMN IF NOT EXISTS manufacturer_id VARCHAR(64),      -- napr. UMBRAXON_LAB, OPENAI...
    ADD COLUMN IF NOT EXISTS manufacturer_verified BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS cert_issued_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS cert_serial VARCHAR(64) UNIQUE,   -- unikátny SN certifikátu
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS revoke_reason TEXT;

-- Index na rýchle hľadanie podľa pubkey
CREATE INDEX IF NOT EXISTS idx_agents_pubkey ON agents(agent_pubkey) WHERE agent_pubkey IS NOT NULL AND agent_pubkey <> '';
CREATE INDEX IF NOT EXISTS idx_agents_manufacturer ON agents(manufacturer_id) WHERE manufacturer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_cert_serial ON agents(cert_serial) WHERE cert_serial IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 2) Tabuľka certificates — verzionované cert dokumenty
-- ----------------------------------------------------------------------------
-- Hub môže časom vystaviť viac certifikátov pre jedného agenta (napr. po reissue
-- pri zmene tier-u alebo revocation+reissue). Posledný platný má `is_current=true`.

CREATE TABLE IF NOT EXISTS certificates (
    id BIGSERIAL PRIMARY KEY,
    serial VARCHAR(64) UNIQUE NOT NULL,             -- unikátny SN (napr. CERT-XXXXXX-N)
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kya_id VARCHAR(64) NOT NULL,
    
    -- Plné JSON telo certifikátu (W3C VC-compatible)
    cert_body JSONB NOT NULL,
    
    -- Podpis hubu cez canonical JSON of cert_body (bez 'proof' poľa)
    -- Formát: hex Ed25519 signature (128 znakov = 64 bajtov)
    hub_signature VARCHAR(256) NOT NULL,
    
    -- Pubkey ktorým bol cert podpísaný (pre key rotation support)
    issuer_pubkey VARCHAR(64) NOT NULL,
    
    -- Lifecycle
    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    valid_until TIMESTAMP,                          -- NULL = forever (ELITE)
    revoked_at TIMESTAMP,
    revoke_reason TEXT,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    
    -- Audit
    issued_by VARCHAR(64) DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_certs_agent ON certificates(agent_id);
CREATE INDEX IF NOT EXISTS idx_certs_kya_id ON certificates(kya_id);
CREATE INDEX IF NOT EXISTS idx_certs_current ON certificates(kya_id, is_current) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_certs_revoked ON certificates(revoked_at) WHERE revoked_at IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 3) Tabuľka auth_challenges — nonces pre challenge-response flow
-- ----------------------------------------------------------------------------
-- Bot požiada o challenge → uložíme nonce → bot ho podpíše → my overíme +
-- označíme ako used (one-time). Expiruje po ~5 minútach.

CREATE TABLE IF NOT EXISTS auth_challenges (
    id BIGSERIAL PRIMARY KEY,
    challenge_id VARCHAR(64) UNIQUE NOT NULL,       -- UUID-like id
    nonce VARCHAR(64) NOT NULL,                     -- 32-byte hex random
    pubkey VARCHAR(64),                             -- voliteľne — viaže challenge na konkrétny pubkey
    purpose VARCHAR(32) NOT NULL DEFAULT 'register', -- 'register', 'verify', 'reissue', ...
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    used_by_ip INET
);

CREATE INDEX IF NOT EXISTS idx_challenges_id ON auth_challenges(challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenges_expires ON auth_challenges(expires_at) WHERE used_at IS NULL;


-- ----------------------------------------------------------------------------
-- 4) Tabuľka registration_intents — pre-payment validated requests
-- ----------------------------------------------------------------------------
-- Po POST /api/register/initiate vytvoríme intent. Obsahuje validovaný manifest,
-- bot signature, manufacturer attestation. Pri webhook InvoiceSettled si ho
-- pull-neme cez registration_id (uložený v metadata BTCPay invoice) a dokončíme
-- registráciu agenta s overenými údajmi.

CREATE TABLE IF NOT EXISTS registration_intents (
    id BIGSERIAL PRIMARY KEY,
    registration_id VARCHAR(64) UNIQUE NOT NULL,    -- UUID-like
    
    -- Agent identifikácia
    agent_name VARCHAR(64) NOT NULL,
    agent_pubkey VARCHAR(64) NOT NULL,              -- Ed25519 pubkey
    
    -- Manifest a podpisy
    manifest JSONB NOT NULL,
    manifest_hash VARCHAR(64) NOT NULL,             -- sha256
    manifest_signature VARCHAR(256) NOT NULL,        -- bot Ed25519 podpis
    
    -- Manufacturer attestation (voliteľné)
    manufacturer_id VARCHAR(64),
    manufacturer_signature VARCHAR(256),
    manufacturer_verified BOOLEAN DEFAULT FALSE,
    manufacturer_bonus INTEGER DEFAULT 0,           -- reputation bonus
    
    -- Tier + platba
    tier_requested VARCHAR(16) NOT NULL,
    invoice_id VARCHAR(64),                          -- po /api/pay sa naviaže
    
    -- Lifecycle
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING_PAYMENT', -- PENDING_PAYMENT, PAID, EXPIRED, COMPLETED, FAILED
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,                   -- typicky created_at + 1 hour
    completed_at TIMESTAMP,
    
    -- Audit
    client_ip INET,
    user_agent TEXT,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_intents_reg_id ON registration_intents(registration_id);
CREATE INDEX IF NOT EXISTS idx_intents_invoice ON registration_intents(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intents_pubkey ON registration_intents(agent_pubkey);
CREATE INDEX IF NOT EXISTS idx_intents_status ON registration_intents(status, expires_at);


-- ----------------------------------------------------------------------------
-- 5) Grants pre kyahub_app (least-privilege app user)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON certificates TO kyahub_app;
GRANT USAGE ON SEQUENCE certificates_id_seq TO kyahub_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_challenges TO kyahub_app;
GRANT USAGE ON SEQUENCE auth_challenges_id_seq TO kyahub_app;

GRANT SELECT, INSERT, UPDATE ON registration_intents TO kyahub_app;
GRANT USAGE ON SEQUENCE registration_intents_id_seq TO kyahub_app;

-- agents tabuľka už existuje, len explicit grant pre nové stĺpce nie je potrebný
-- (UPDATE oprávnenie sa vzťahuje na celý riadok)


COMMIT;
