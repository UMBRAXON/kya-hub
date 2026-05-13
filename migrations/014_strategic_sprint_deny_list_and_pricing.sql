-- ============================================================================
-- Strategic Sprint §31 — Part D (NEW scope: A+B+D, NO custody)
-- ----------------------------------------------------------------------------
-- Operator decision (2026-05-12): hub holds NO bot funds. Penalty system is:
--   A) Tiered upfront pricing  (BASIC 10k, ELITE 80k)
--   B) Tiered re-registration multiplier (3 ^ ban_count, capped at 9×)
--   D) Ban + CRL + reputation drop, plus pubkey_deny_list cooldown
--
-- This migration is idempotent (IF NOT EXISTS / DO $$ guards) so re-running
-- converges to the same state.
-- ============================================================================

BEGIN;

-- 1) Bump active ELITE price 50_000 → 80_000 sats.
--    Historical invoices snapshot price at time of payment, so existing
--    agents are unaffected.
DO $$
DECLARE
    cur_id BIGINT;
    cur_amt INT;
BEGIN
    SELECT id, amount_sats INTO cur_id, cur_amt
    FROM tier_pricing
    WHERE tier_name = 'ELITE' AND effective_until IS NULL
    LIMIT 1;

    IF cur_id IS NULL THEN
        INSERT INTO tier_pricing (tier_name, amount_sats, grade, duration_months,
                                  requires_anchor, base_reputation, changed_by, change_reason)
        VALUES ('ELITE', 80000, 'S', NULL, TRUE, 900, 'migration-014',
                'Strategic Sprint §31 D — ELITE price set 80_000 sats (no bond, no custody)');
    ELSIF cur_amt <> 80000 THEN
        UPDATE tier_pricing SET effective_until = NOW() WHERE id = cur_id;
        INSERT INTO tier_pricing (tier_name, amount_sats, grade, duration_months,
                                  requires_anchor, base_reputation, changed_by, change_reason)
        SELECT tier_name, 80000, grade, duration_months, requires_anchor, base_reputation,
               'migration-014',
               'Strategic Sprint §31 D — ELITE price bump 50_000 → 80_000 sats (operator policy: no bond, no custody)'
        FROM tier_pricing WHERE id = cur_id;
    END IF;
END $$;

-- 2) pubkey_deny_list — re-registration cooldown after ban.
CREATE TABLE IF NOT EXISTS pubkey_deny_list (
    pubkey_hex      VARCHAR(130) PRIMARY KEY,           -- accept hex pubkey (64..130 chars)
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    ban_count       INT NOT NULL DEFAULT 1,
    reason          TEXT,
    evidence_hash   VARCHAR(64),
    added_by        VARCHAR(64) NOT NULL DEFAULT 'system',
    last_kya_id     VARCHAR(20),                        -- last KYA-ID associated with this pubkey
    cleared_at      TIMESTAMPTZ,                         -- operator manual clearance; row stays for history
    cleared_by      VARCHAR(64),
    cleared_reason  TEXT
);
CREATE INDEX IF NOT EXISTS ix_deny_list_expires ON pubkey_deny_list (expires_at);
CREATE INDEX IF NOT EXISTS ix_deny_list_active  ON pubkey_deny_list (expires_at) WHERE cleared_at IS NULL;

COMMENT ON TABLE  pubkey_deny_list IS
'Strategic Sprint §31 D — Pubkey-level cooldown for banned agents. New '
'registration attempts using a denied pubkey are rejected until expires_at. '
'ban_count persists across cooldowns and is used to compute the '
're-registration price multiplier (3^ban_count, capped at 9×).';
COMMENT ON COLUMN pubkey_deny_list.expires_at IS 'After this time, the pubkey can re-register (still paying the multiplied price).';
COMMENT ON COLUMN pubkey_deny_list.ban_count  IS 'Lifetime ban count for this pubkey (does NOT reset on clear/unban).';

-- 3) Grant least-privilege access to the kyahub_app role used by the runtime.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kyahub_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON pubkey_deny_list TO kyahub_app;
    END IF;
END $$;

COMMIT;
