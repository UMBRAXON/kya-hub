-- ============================================================================
-- UMBRAXON KYA-Hub — Strategic Sprint 2026-05-12 (Section 30)
-- Migration 012: Off-Hetzner backup audit + Volumetric AML limits
-- ----------------------------------------------------------------------------
-- Two domains in one migration because both are ops/audit tables that are
-- written from cron jobs and read from the admin API:
--
--   1) backup_log               (Item 1+2+11 — every backup leaves an audit row)
--   2) volumetric_limits        (Item 4 — thresholds, editable by admin API)
--      volumetric_counters      (Item 4 — sliding-window event log)
--
-- All tables grant SELECT/INSERT/UPDATE to kyahub_app; DELETE is intentionally
-- withheld (rows are aged out by the admin/cron pruner using soft fields).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) backup_log — append-only audit trail of every encrypted backup taken
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_log (
    id              BIGSERIAL PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    -- 'lightning_channel' | 'postgres' | 'dac8_export' | 'esg_report'
    backup_kind     VARCHAR(64) NOT NULL,
    -- canonical relative path in the off-site bucket OR local dir
    object_path     TEXT NOT NULL,
    -- destination: 'b2', 'local', 'b2+local'
    destination     VARCHAR(32) NOT NULL,
    size_bytes      BIGINT,
    sha256          CHAR(64),
    encryption      VARCHAR(64) NOT NULL DEFAULT 'AES-256-GCM',
    -- 'OK', 'FAIL', 'PARTIAL' (e.g. local OK, B2 upload failed)
    status          VARCHAR(16) NOT NULL DEFAULT 'OK',
    error_message   TEXT,
    -- arbitrary structured payload (e.g. B2 fileId, source size, fileCount)
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    host            TEXT,
    -- for retention-pruner audit
    pruned_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_backup_log_kind_started
    ON backup_log (backup_kind, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_log_status_started
    ON backup_log (status, started_at DESC);

COMMENT ON TABLE  backup_log    IS 'Strategic Sprint 2026-05-12 §30 — one row per off-Hetzner encrypted backup attempt (Items 1, 2, 11).';
COMMENT ON COLUMN backup_log.backup_kind IS 'lightning_channel | postgres | dac8_export | esg_report';
COMMENT ON COLUMN backup_log.destination IS 'b2 | local | b2+local';
COMMENT ON COLUMN backup_log.sha256      IS 'sha256 hex digest of the encrypted artifact (post-encryption)';
COMMENT ON COLUMN backup_log.pruned_at   IS 'timestamp when the cold/hot retention pruner deleted the artifact';


-- ---------------------------------------------------------------------------
-- 2) volumetric_limits — admin-editable AML / fraud thresholds (Item 4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS volumetric_limits (
    id              SERIAL PRIMARY KEY,
    -- unique slug, e.g. 'agent:per_day_sats', 'global:per_hour_regs'
    limit_key       VARCHAR(96) UNIQUE NOT NULL,
    -- threshold (sats, or count, depending on the key)
    threshold_value BIGINT NOT NULL CHECK (threshold_value >= 0),
    -- rolling window in seconds (e.g. 86400 = 24h)
    window_seconds  INTEGER NOT NULL CHECK (window_seconds > 0),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    -- 'sats' | 'count'
    unit            VARCHAR(16) NOT NULL DEFAULT 'sats',
    -- 'global' | 'per_agent' | 'per_ip'
    scope           VARCHAR(16) NOT NULL DEFAULT 'global',
    description     TEXT,
    -- short rationale for the most recent change (regulator-defensible)
    change_reason   TEXT,
    last_changed_by VARCHAR(64),
    last_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_volumetric_limits_enabled
    ON volumetric_limits (enabled) WHERE enabled = TRUE;

COMMENT ON TABLE volumetric_limits IS
    'Strategic Sprint 2026-05-12 §30 Item 4 — AML/fraud volumetric thresholds. Admin endpoint GET/POST /api/admin/volumetric-limits.';


-- ---------------------------------------------------------------------------
-- 3) volumetric_counters — append-only event log (sliding window)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS volumetric_counters (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    limit_key       VARCHAR(96) NOT NULL,
    -- nullable for global scope; set for per_agent / per_ip
    subject_id      VARCHAR(96),
    -- magnitude of this event (e.g. sats spent on anchor)
    amount          BIGINT NOT NULL DEFAULT 1 CHECK (amount >= 0),
    -- audit / forensic context (e.g. {"kya_id":"UMBRA-AB12CD","tx":"<txid>"})
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_volumetric_counters_key_time
    ON volumetric_counters (limit_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_volumetric_counters_subject_time
    ON volumetric_counters (limit_key, subject_id, occurred_at DESC)
    WHERE subject_id IS NOT NULL;

COMMENT ON TABLE volumetric_counters IS
    'Strategic Sprint 2026-05-12 §30 Item 4 — per-event sliding-window log feeding volumetric_limits enforcement.';


-- ---------------------------------------------------------------------------
-- 4) Seed default limits (idempotent — uses ON CONFLICT)
-- ---------------------------------------------------------------------------
INSERT INTO volumetric_limits (limit_key, threshold_value, window_seconds, unit, scope, description, change_reason)
VALUES
    ('agent:per_day_sats', 200000, 86400, 'sats', 'per_agent',
     'Max outbound sats (fees + anchor cost) per agent per rolling 24h. Caps individual-agent burn rate.',
     'Initial seed (Strategic Sprint 2026-05-12 §30 Item 4 default).'),
    ('global:per_hour_regs', 1000, 3600, 'count', 'global',
     'Max new agent registrations system-wide per rolling 1h. Protects against runaway sybil bursts.',
     'Initial seed (Strategic Sprint 2026-05-12 §30 Item 4 default).'),
    ('global:per_day_anchor_sats', 50000, 86400, 'sats', 'global',
     'Max sats spent on OP_RETURN anchors system-wide per rolling 24h. Caps daily on-chain cost ceiling.',
     'Initial seed (Strategic Sprint 2026-05-12 §30 Item 4 default).')
ON CONFLICT (limit_key) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 5) Permissions (kyahub_app gets SELECT/INSERT/UPDATE; no DELETE)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kyahub_app') THEN
        GRANT SELECT, INSERT, UPDATE ON TABLE backup_log          TO kyahub_app;
        GRANT USAGE, SELECT ON SEQUENCE backup_log_id_seq         TO kyahub_app;

        GRANT SELECT, INSERT, UPDATE ON TABLE volumetric_limits   TO kyahub_app;
        GRANT USAGE, SELECT ON SEQUENCE volumetric_limits_id_seq  TO kyahub_app;

        GRANT SELECT, INSERT, UPDATE ON TABLE volumetric_counters TO kyahub_app;
        GRANT USAGE, SELECT ON SEQUENCE volumetric_counters_id_seq TO kyahub_app;
    END IF;
END $$;

COMMIT;
