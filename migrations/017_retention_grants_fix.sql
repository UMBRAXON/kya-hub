-- ============================================================================
-- 017 — Retention worker grants fix (P1 ops hygiene)
-- ============================================================================
-- The retention worker (lib/retention-worker.js) needs DELETE privileges on a
-- small set of high-churn tables to prevent DB bloat.
--
-- Observed in PM2 logs:
--   permission denied for table registration_intents
--   permission denied for table ip_bans
--   permission denied for table volumetric_counters
--
-- This migration grants DELETE (and keeps existing least-privilege stance).
-- Idempotent.
-- ============================================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kyahub_app') THEN
        -- registration_intents: allow retention hard-delete of completed/expired intents
        GRANT DELETE ON TABLE registration_intents TO kyahub_app;

        -- ip_bans: allow retention hard-delete of revoked/expired bans
        GRANT DELETE ON TABLE ip_bans TO kyahub_app;

        -- volumetric_counters: allow pruning old counters
        GRANT DELETE ON TABLE volumetric_counters TO kyahub_app;
    END IF;
END $$;

COMMIT;

