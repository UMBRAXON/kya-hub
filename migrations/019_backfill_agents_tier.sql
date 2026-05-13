-- ============================================================================
-- UMBRAXON KYA-Hub — Migration 019: Backfill agents.tier (remove UNKNOWN / NULL)
-- ----------------------------------------------------------------------------
-- Dashboard a Prometheus agregujú COALESCE(tier,'UNKNOWN'). Legacy riadky
-- mali tier NULL, prázdny reťazec, alebo 'UNKNOWN' z pôvodného backfillu
-- (conduct_grade mimo B/S). Táto migrácia znovu odvodí BASIC vs ELITE z
-- conduct_grade, platobných súm (tier_pricing), anchorov a pending_anchors,
-- a zvyšok bezpečne zmapuje na BASIC.
-- ============================================================================

-- 1) Tier z conduct_grade (zhodné s logikou v 001_phase1_security.sql)
UPDATE agents
SET tier = 'ELITE'
WHERE (tier IS NULL OR TRIM(tier) = '' OR UPPER(TRIM(tier)) = 'UNKNOWN')
  AND conduct_grade = 'S';

UPDATE agents
SET tier = 'BASIC'
WHERE (tier IS NULL OR TRIM(tier) = '' OR UPPER(TRIM(tier)) = 'UNKNOWN')
  AND conduct_grade = 'B';

-- 2) ELITE podľa aktívnej ceny v tier_pricing (initial / current / payment)
UPDATE agents a
SET tier = 'ELITE'
WHERE (a.tier IS NULL OR TRIM(a.tier) = '' OR UPPER(TRIM(a.tier)) = 'UNKNOWN')
  AND EXISTS (
      SELECT 1
      FROM tier_pricing e
      WHERE e.tier_name = 'ELITE'
        AND e.effective_until IS NULL
        AND (
            a.initial_deposit = e.amount_sats
            OR a.current_deposit = e.amount_sats
            OR a.payment_amount_sats = e.amount_sats
        )
  );

-- 3) BASIC podľa aktívnej ceny v tier_pricing
UPDATE agents a
SET tier = 'BASIC'
WHERE (a.tier IS NULL OR TRIM(a.tier) = '' OR UPPER(TRIM(a.tier)) = 'UNKNOWN')
  AND EXISTS (
      SELECT 1
      FROM tier_pricing b
      WHERE b.tier_name = 'BASIC'
        AND b.effective_until IS NULL
        AND (
            a.initial_deposit = b.amount_sats
            OR a.current_deposit = b.amount_sats
            OR a.payment_amount_sats = b.amount_sats
        )
  );

-- 4) ELITE signály: anchor / pending anchor / elite listing
UPDATE agents a
SET tier = 'ELITE'
WHERE (a.tier IS NULL OR TRIM(a.tier) = '' OR UPPER(TRIM(a.tier)) = 'UNKNOWN')
  AND (
      a.anchor_txid IS NOT NULL
      OR (a.anchor_status IS NOT NULL AND TRIM(a.anchor_status) <> '')
      OR EXISTS (
          SELECT 1 FROM pending_anchors pa
          WHERE pa.agent_id = a.id AND UPPER(TRIM(pa.tier)) = 'ELITE'
      )
      OR a.elite_listing_status IS NOT NULL
  );

-- 5) Fallback: zostávajúci neplatný tier → BASIC (typicky starý legacy riadok)
UPDATE agents
SET tier = 'BASIC'
WHERE tier IS NULL OR TRIM(tier) = '' OR UPPER(TRIM(tier)) = 'UNKNOWN';

COMMENT ON COLUMN agents.tier IS 'BASIC | ELITE — backfilled by migration 019 when previously UNKNOWN/NULL';
