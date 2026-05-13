-- ============================================================================
-- UMBRAXON KYA-Hub — Migrácia 004: Phase 2.2 Anti-Abuse Layer
-- ============================================================================
-- Pridáva:
--   - rejected_requests: audit log všetkých zamietnutých requestov
--   - ip_bans: temporary IP bans (s expiráciou)
--   - signature_failures: per-kya counter pre bad sig auto-slash
--   - pow_challenges: proof-of-work challenges pre /api/pay
--   - Index na rýchle lookupy
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) rejected_requests — audit log
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rejected_requests (
    id BIGSERIAL PRIMARY KEY,
    
    -- What
    path TEXT NOT NULL,                     -- napr. /api/agent/UMBRA-X/action
    method VARCHAR(8) NOT NULL,             -- GET/POST
    reason VARCHAR(64) NOT NULL,            -- BAD_SIGNATURE, REPLAY, BAD_ADMIN_KEY, RATE_LIMITED, IP_BANNED, ...
    http_status INTEGER NOT NULL,
    severity VARCHAR(16) NOT NULL DEFAULT 'low',  -- 'low' | 'medium' | 'high' | 'critical'
    
    -- Who
    client_ip INET NOT NULL,
    kya_id VARCHAR(64),                     -- ak je v URL params
    user_agent TEXT,
    
    -- Context
    error_detail TEXT,                      -- skrátený error message
    metadata JSONB,                         -- arbitrary extra info (nonce, signature prefix, atd.)
    
    -- Timing
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rej_ip ON rejected_requests(client_ip, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_rej_kya ON rejected_requests(kya_id, occurred_at DESC) WHERE kya_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rej_reason ON rejected_requests(reason, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_rej_recent ON rejected_requests(occurred_at DESC);


-- ----------------------------------------------------------------------------
-- 2) ip_bans — aktívne IP bany
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ip_bans (
    id BIGSERIAL PRIMARY KEY,
    client_ip INET NOT NULL,
    
    reason VARCHAR(64) NOT NULL,            -- AUTO_FAIL2BAN, ADMIN_MANUAL, KNOWN_ABUSE_IP, ...
    severity VARCHAR(16) NOT NULL DEFAULT 'medium',
    rejection_count INTEGER DEFAULT 0,      -- koľko violations viedlo k tomuto banu
    notes TEXT,
    
    banned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,                   -- NULL = trvalý ban
    revoked_at TIMESTAMP,                   -- ak admin manuálne unbannol
    revoked_by VARCHAR(64),
    revoke_reason TEXT,
    
    banned_by VARCHAR(64) DEFAULT 'system'  -- 'system' alebo admin user
);

-- Aktívne bany: NOT revoked AND (expires_at IS NULL OR expires_at > NOW())
CREATE INDEX IF NOT EXISTS idx_ipban_active ON ip_bans(client_ip)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ipban_expires ON ip_bans(expires_at)
    WHERE revoked_at IS NULL AND expires_at IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 3) signature_failures — per-kya counter pre auto-slash
-- ----------------------------------------------------------------------------
-- Každý bad signature attempt sa zapíše. Po N v okne 1h → auto-slash agenta.

CREATE TABLE IF NOT EXISTS signature_failures (
    id BIGSERIAL PRIMARY KEY,
    kya_id VARCHAR(64) NOT NULL,
    client_ip INET,
    endpoint VARCHAR(64) NOT NULL,          -- 'action' | 'heartbeat' | 'report'
    failure_type VARCHAR(32) NOT NULL,      -- BAD_SIGNATURE, BAD_NONCE, BAD_TIMESTAMP
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sigfail_kya ON signature_failures(kya_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sigfail_recent ON signature_failures(occurred_at DESC);


-- ----------------------------------------------------------------------------
-- 4) pow_challenges — proof-of-work challenges pre drahé endpointy
-- ----------------------------------------------------------------------------
-- Client požiada o challenge, vypočíta sha256(challenge + nonce) s N leading zeros,
-- pošle dôkaz s payment requestom. Hub overí.

CREATE TABLE IF NOT EXISTS pow_challenges (
    id BIGSERIAL PRIMARY KEY,
    challenge_id VARCHAR(64) UNIQUE NOT NULL,
    challenge VARCHAR(64) NOT NULL,         -- 32B random hex
    difficulty INTEGER NOT NULL,             -- počet leading zero bits (typicky 16-20)
    purpose VARCHAR(32) NOT NULL DEFAULT 'pay',
    client_ip INET,
    
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    solved_at TIMESTAMP,
    solution_nonce VARCHAR(64),              -- riešenie (audit)
    solution_iterations INTEGER              -- koľko iterácií trvalo (orientácia)
);

CREATE INDEX IF NOT EXISTS idx_pow_id ON pow_challenges(challenge_id);
CREATE INDEX IF NOT EXISTS idx_pow_expires ON pow_challenges(expires_at)
    WHERE solved_at IS NULL;


-- ----------------------------------------------------------------------------
-- 5) Anomaly flags pre action_log (pridanie stĺpcov k existujúcej tabuľke)
-- ----------------------------------------------------------------------------
-- Príznak že action bola flagged ako anomálna (napr. target spam) a auto-slash bol aplikovaný.
ALTER TABLE action_log
    ADD COLUMN IF NOT EXISTS anomaly_flagged BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS anomaly_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_action_target ON action_log(kya_id, target, received_at DESC)
    WHERE target IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 6) Grants
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON rejected_requests TO kyahub_app;
GRANT USAGE ON SEQUENCE rejected_requests_id_seq TO kyahub_app;

GRANT SELECT, INSERT, UPDATE ON ip_bans TO kyahub_app;
GRANT USAGE ON SEQUENCE ip_bans_id_seq TO kyahub_app;

GRANT SELECT, INSERT, DELETE ON signature_failures TO kyahub_app;
GRANT USAGE ON SEQUENCE signature_failures_id_seq TO kyahub_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON pow_challenges TO kyahub_app;
GRANT USAGE ON SEQUENCE pow_challenges_id_seq TO kyahub_app;


COMMIT;
