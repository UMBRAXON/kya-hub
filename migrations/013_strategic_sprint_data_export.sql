-- ============================================================================
-- UMBRAXON KYA-Hub — Strategic Sprint 2026-05-12 (Section 30)
-- Migration 013: GDPR data-export audit
-- ----------------------------------------------------------------------------
-- Backs Item 8: `GET /api/agent/:kya_id/data-export`. Every successful export
-- (or attempted export) leaves an audit trail so we can:
--   - prove to a regulator that we honoured a Subject Access Request,
--   - rate-limit / detect abuse (an attacker who learnt an agent's key but
--     not its config could try to exfiltrate the agent's data),
--   - serve the previously-generated archive via signed URL on a re-poll
--     within the validity window without regenerating.
--
-- Grants: SELECT / INSERT / UPDATE to kyahub_app, no DELETE.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS data_exports (
    id              BIGSERIAL PRIMARY KEY,
    kya_id          VARCHAR(20) NOT NULL,
    -- agent_id is nullable on purpose: if the agent was hard-purged between
    -- the export and an audit query, we still keep the row.
    agent_id        INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    -- 'PENDING' (request received, building archive)
    -- 'READY'   (archive built, can be downloaded until expires_at)
    -- 'EXPIRED' (archive on-disk was removed by the pruner)
    -- 'FAILED'  (build error)
    status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    -- one-time download token (random 32-byte hex). Stored hashed (sha256)
    -- so even with a DB leak the token alone doesn't grant download.
    download_token_sha256 CHAR(64),
    expires_at      TIMESTAMPTZ,
    archive_path    TEXT,
    archive_size_bytes BIGINT,
    archive_sha256  CHAR(64),
    request_signature TEXT,
    request_nonce   VARCHAR(128),
    request_timestamp TIMESTAMPTZ,
    client_ip       INET,
    user_agent      TEXT,
    -- usable for "5 exports per agent per month" if we ever add a limit
    error_message   TEXT,
    -- arbitrary forensic payload (counts, hash of returned JSON, etc.)
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    downloaded_at   TIMESTAMPTZ,
    download_count  INTEGER NOT NULL DEFAULT 0,
    -- soft-prune marker set when the on-disk archive is deleted
    pruned_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_data_exports_kya_id_time
    ON data_exports (kya_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_exports_status_expires
    ON data_exports (status, expires_at);
-- Allow the public download endpoint to look up by hashed token in O(log n).
CREATE INDEX IF NOT EXISTS idx_data_exports_dl_token
    ON data_exports (download_token_sha256)
    WHERE download_token_sha256 IS NOT NULL;

COMMENT ON TABLE data_exports IS
    'Strategic Sprint 2026-05-12 §30 Item 8 — GDPR Subject Access Request audit. One row per /api/agent/:kya_id/data-export call.';
COMMENT ON COLUMN data_exports.download_token_sha256 IS
    'sha256 hex of the one-time download token returned to the agent. The plaintext token is NEVER persisted.';
COMMENT ON COLUMN data_exports.expires_at IS
    'Hard expiry (default request_time + 1h). After this the archive is unreachable even with the token.';
COMMENT ON COLUMN data_exports.pruned_at IS
    'When the retention pruner deleted the on-disk archive (independent of expires_at).';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kyahub_app') THEN
        GRANT SELECT, INSERT, UPDATE ON TABLE data_exports        TO kyahub_app;
        GRANT USAGE, SELECT ON SEQUENCE data_exports_id_seq        TO kyahub_app;
    END IF;
END $$;

COMMIT;
