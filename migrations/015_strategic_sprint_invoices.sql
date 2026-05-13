-- ============================================================================
-- Strategic Sprint §31 C — PDF Invoice Generator
-- ----------------------------------------------------------------------------
-- Stores one row per generated invoice. PDF lives on disk under
--   /root/kya-hub/invoices/<YYYY>/<MM>/UMX-<ts>-<KYA_ID>.pdf
-- and optionally is mirrored to R2 at the same relative path under
--   kyahub/invoices/...  (subject to R2 backup-script auto-prefer)
--
-- Idempotency: `payment_hash` is UNIQUE. If a webhook is replayed we no-op.
-- Backfill: invoice_number is freely insertable (we generate UMX-YYYYMMDD-NNNN
-- from invoiced_at + a per-day sequence). Historical rows are inserted with
-- the actual payment_settled_at timestamp.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS invoices (
    id                      BIGSERIAL PRIMARY KEY,
    invoice_number          VARCHAR(64) UNIQUE NOT NULL,
    agent_id                INT REFERENCES agents(id) ON DELETE SET NULL,
    kya_id                  VARCHAR(20) NOT NULL,
    tier                    VARCHAR(16) NOT NULL,
    issued_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at                 TIMESTAMPTZ,
    paid_amount_sats        BIGINT NOT NULL,
    paid_amount_eur         NUMERIC(14, 2),
    btc_rate_at_payment     NUMERIC(14, 2),         -- EUR per BTC at payment time
    payment_method          VARCHAR(32),             -- 'btcpay' | 'lightning' | 'backfill'
    payment_hash            VARCHAR(128) UNIQUE,
    payment_preimage_sha    VARCHAR(64),
    pdf_local_path          TEXT,
    pdf_r2_uri              TEXT,
    pdf_sha256              VARCHAR(64),
    pdf_bytes               INT,
    meta                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    regenerated_count       INT NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_invoices_kya_id ON invoices (kya_id);
CREATE INDEX IF NOT EXISTS ix_invoices_issued_at ON invoices (issued_at DESC);
CREATE INDEX IF NOT EXISTS ix_invoices_agent_id ON invoices (agent_id);

COMMENT ON TABLE invoices IS
'Strategic Sprint §31 C — issued PDF invoices. PDFs on disk + optional R2 mirror. '
'Idempotent via payment_hash; safe to call generator twice. paid_amount_eur '
'and btc_rate_at_payment are snapshotted at issuance time so historical '
'records stay correct even when the EUR rate moves.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kyahub_app') THEN
        GRANT SELECT, INSERT, UPDATE ON invoices TO kyahub_app;
        GRANT USAGE, SELECT ON SEQUENCE invoices_id_seq TO kyahub_app;
    END IF;
END $$;

COMMIT;
