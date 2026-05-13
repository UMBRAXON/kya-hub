-- ============================================================================
-- UMBRAXON KYA-Hub — Phase 5b (Multi-Sig ELITE certs)
-- ----------------------------------------------------------------------------
-- ELITE certifikáty teraz môžu byť (default: SÚ) podpísané 2-of-3 multi-sig
-- (BASIC + ELITE + ROOT). Stará single-sig schéma zostáva podporovaná pre
-- backward compat — verifier akceptuje obidva proof typy.
--
-- Tento migrácia pridáva:
--   - `certificates.proof_type` — string 'Ed25519Signature2020' alebo
--      'Ed25519MultiSignature2020'. Default 'Ed25519Signature2020' pre legacy
--      certs, aplikácia ho explicitne nastavuje pri nových.
--   - `certificates.proof_threshold` — int, 1 pre single-sig, 2..N pre multi.
--   - `certificates.proof_signing_roles` — text[] použitých rol (debug, audit).
--   - Backfill existujúcich riadkov: extract z `cert_body->'proof'` pomocou
--      JSONB operátorov.
-- ============================================================================

BEGIN;

ALTER TABLE certificates
    ADD COLUMN IF NOT EXISTS proof_type           VARCHAR(64),
    ADD COLUMN IF NOT EXISTS proof_threshold      INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS proof_signing_roles  TEXT[];

-- Backfill: derive from existing cert_body->'proof' JSONB.
UPDATE certificates
SET proof_type = COALESCE(
        cert_body->'proof'->>'type',
        'Ed25519Signature2020'
    )
WHERE proof_type IS NULL;

-- For multi-sig rows backfilled later (none exist yet at migration time),
-- derive threshold and signing roles from the proof block.
UPDATE certificates
SET proof_threshold = COALESCE(
        NULLIF(cert_body->'proof'->>'threshold', '')::int,
        1
    )
WHERE proof_threshold IS NULL OR proof_threshold = 1;

-- Index for filtering / counting per proof type (lightweight).
CREATE INDEX IF NOT EXISTS idx_certs_proof_type ON certificates (proof_type)
    WHERE proof_type IS NOT NULL;

COMMENT ON COLUMN certificates.proof_type IS
    'Phase 5b: Ed25519Signature2020 (single-sig) or Ed25519MultiSignature2020 (2-of-3).';
COMMENT ON COLUMN certificates.proof_threshold IS
    'Number of valid signatures required (1 for single-sig, e.g. 2 for 2-of-3).';
COMMENT ON COLUMN certificates.proof_signing_roles IS
    'Roles that contributed signatures, in order, e.g. ARRAY[''BASIC'',''ELITE'',''ROOT''].';

COMMIT;
