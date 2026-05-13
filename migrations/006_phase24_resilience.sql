-- ============================================================================
-- UMBRAXON KYA-Hub — Migrácia 006: Phase 2.4 Resilience & Scale
-- ============================================================================
-- Pridáva:
--   - Archive tabuľky pre vysoko-frekvenčné logy (action_log, reputation_events,
--     reports, cert_signing_log, rejected_requests)
--   - Indexy pre Sybil graph queries (peer review by reporter, target+reporter pair)
--   - Tabuľka tier_pricing pre dynamický pricing s historiou
--   - audit_purged_kya_hashes pre GDPR purge auditovateľnosť
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) action_log_archive — staré self-action záznamy (po 90 dňoch sa archivujú)
-- ----------------------------------------------------------------------------
-- Schéma identická s action_log + archived_at. Po archive sa origin row mení na NULL
-- iba ak chce admin "compact" (default: hard-delete origin, lebo archive je kópia).
CREATE TABLE IF NOT EXISTS action_log_archive (
    id BIGINT PRIMARY KEY,                  -- pôvodný id zachováme pre cross-reference
    agent_id INTEGER,                       -- bez FK, lebo agent môže byť purged
    kya_id VARCHAR(64),
    action_type VARCHAR(48) NOT NULL,
    target TEXT,
    context JSONB,
    evidence_hash VARCHAR(64),
    signature VARCHAR(256),
    nonce VARCHAR(64),
    score_delta INTEGER,
    rate_limited BOOLEAN,
    rejected_reason TEXT,
    anomaly_flagged BOOLEAN,
    anomaly_reason TEXT,
    bot_timestamp TIMESTAMP,
    received_at TIMESTAMP NOT NULL,
    archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_actarch_kya ON action_log_archive(kya_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_actarch_archived ON action_log_archive(archived_at);


-- ----------------------------------------------------------------------------
-- 2) reputation_events_archive
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reputation_events_archive (
    id BIGINT PRIMARY KEY,
    agent_id INTEGER,
    kya_id VARCHAR(64),
    event_type VARCHAR(48),
    source VARCHAR(32),
    delta INTEGER,
    score_before INTEGER,
    score_after INTEGER,
    zone_before VARCHAR(16),
    zone_after VARCHAR(16),
    reason TEXT,
    evidence JSONB,
    reporter_kya_id VARCHAR(64),
    reporter_pubkey VARCHAR(64),
    related_report_id BIGINT,
    related_action_id BIGINT,
    admin_user VARCHAR(64),
    client_ip INET,
    user_agent TEXT,
    occurred_at TIMESTAMP NOT NULL,
    archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_evarch_kya ON reputation_events_archive(kya_id, occurred_at DESC);


-- ----------------------------------------------------------------------------
-- 3) reports_archive
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports_archive (
    id BIGINT PRIMARY KEY,
    target_agent_id INTEGER,
    target_kya_id VARCHAR(64),
    report_type VARCHAR(48),
    description TEXT,
    evidence JSONB,
    reporter_kya_id VARCHAR(64),
    reporter_pubkey VARCHAR(64),
    reporter_signature VARCHAR(256),
    reporter_ip INET,
    status VARCHAR(24),
    auto_applied_delta INTEGER,
    resolution VARCHAR(32),
    resolution_delta INTEGER,
    resolution_note TEXT,
    resolved_by VARCHAR(64),
    report_nonce VARCHAR(64),
    report_timestamp TIMESTAMP,
    created_at TIMESTAMP,
    resolved_at TIMESTAMP,
    archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reparch_target ON reports_archive(target_kya_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- 4) cert_signing_log_archive
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cert_signing_log_archive (
    id BIGINT PRIMARY KEY,
    serial VARCHAR(64),
    kya_id VARCHAR(64),
    key_id VARCHAR(32),
    role VARCHAR(16),
    signing_purpose VARCHAR(32),
    message_hash VARCHAR(64),
    signature_prefix VARCHAR(16),
    requested_by_admin VARCHAR(64),
    requested_by_ip INET,
    signed_at TIMESTAMP NOT NULL,
    anomaly_flagged BOOLEAN,
    anomaly_reason TEXT,
    archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_signarch_signed ON cert_signing_log_archive(signed_at DESC);


-- ----------------------------------------------------------------------------
-- 5) rejected_requests_archive (Phase 2.2 už má retention 30d, ale chceme history)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rejected_requests_archive (
    id BIGINT PRIMARY KEY,
    path TEXT,
    method VARCHAR(8),
    reason VARCHAR(64),
    http_status INTEGER,
    severity VARCHAR(16),
    client_ip INET,
    kya_id VARCHAR(64),
    user_agent TEXT,
    error_detail TEXT,
    metadata JSONB,
    occurred_at TIMESTAMP NOT NULL,
    archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rejarch_recent ON rejected_requests_archive(occurred_at DESC);


-- ----------------------------------------------------------------------------
-- 6) tier_pricing — dynamický pricing s historiou (live update bez reštartu)
-- ----------------------------------------------------------------------------
-- ACTIVE riadok per tier_name. Pri zmene admin INSERT-uje nový riadok a starý
-- mark-ne ako effective_until=NOW(). Server poller load-uje ACTIVE riadky každú minútu.

CREATE TABLE IF NOT EXISTS tier_pricing (
    id BIGSERIAL PRIMARY KEY,
    tier_name VARCHAR(16) NOT NULL,             -- BASIC | ELITE
    amount_sats INTEGER NOT NULL,
    grade VARCHAR(8) NOT NULL,                  -- B | S
    duration_months INTEGER,                    -- NULL = forever
    requires_anchor BOOLEAN NOT NULL DEFAULT FALSE,
    base_reputation INTEGER NOT NULL,
    
    effective_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    effective_until TIMESTAMP,                  -- NULL = aktuálne aktívna cena
    changed_by VARCHAR(64) DEFAULT 'system',
    change_reason TEXT,
    
    CONSTRAINT tier_pricing_tier_chk CHECK (tier_name IN ('BASIC', 'ELITE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tier_active
    ON tier_pricing (tier_name) WHERE effective_until IS NULL;
CREATE INDEX IF NOT EXISTS idx_tier_history ON tier_pricing(tier_name, effective_from DESC);

-- Seed: pridaj aktuálne defaults ak ešte neexistujú
INSERT INTO tier_pricing (tier_name, amount_sats, grade, duration_months, requires_anchor, base_reputation, change_reason)
SELECT 'BASIC', 10000, 'B', 12, FALSE, 500, 'Initial seed from Phase 2.4 migration'
WHERE NOT EXISTS (SELECT 1 FROM tier_pricing WHERE tier_name = 'BASIC' AND effective_until IS NULL);

INSERT INTO tier_pricing (tier_name, amount_sats, grade, duration_months, requires_anchor, base_reputation, change_reason)
SELECT 'ELITE', 80000, 'S', NULL, TRUE, 900, 'Initial seed from Phase 2.4 migration (ELITE 80k per Strategic Sprint §31 D)'
WHERE NOT EXISTS (SELECT 1 FROM tier_pricing WHERE tier_name = 'ELITE' AND effective_until IS NULL);


-- ----------------------------------------------------------------------------
-- 7) Indexy pre Sybil graph queries
-- ----------------------------------------------------------------------------
-- Detekcia: bot A reportuje (positively) bota B + B reportuje A → "review krúžok"
CREATE INDEX IF NOT EXISTS idx_reports_pos_pair
    ON reports (reporter_kya_id, target_kya_id, created_at DESC)
    WHERE auto_applied_delta IS NOT NULL AND auto_applied_delta > 0;

-- agents.verified_at je defacto registration time → age computation pre Sybil weighting
CREATE INDEX IF NOT EXISTS idx_agents_age ON agents(verified_at) WHERE is_active = TRUE;


-- ----------------------------------------------------------------------------
-- 8) Grants
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, DELETE ON action_log_archive TO kyahub_app;
GRANT SELECT, INSERT, DELETE ON reputation_events_archive TO kyahub_app;
GRANT SELECT, INSERT, DELETE ON reports_archive TO kyahub_app;
GRANT SELECT, INSERT, DELETE ON cert_signing_log_archive TO kyahub_app;
GRANT SELECT, INSERT, DELETE ON rejected_requests_archive TO kyahub_app;

GRANT SELECT, INSERT, UPDATE ON tier_pricing TO kyahub_app;
GRANT USAGE ON SEQUENCE tier_pricing_id_seq TO kyahub_app;

-- Phase 2.4: retention worker potrebuje DELETE permission na origin log tabuľky
-- (pôvodné migrácie dali iba SELECT/INSERT/UPDATE)
GRANT DELETE ON action_log TO kyahub_app;
GRANT DELETE ON reputation_events TO kyahub_app;
GRANT DELETE ON cert_signing_log TO kyahub_app;


COMMIT;
