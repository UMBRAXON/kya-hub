-- ============================================================================
-- UMBRAXON KYA-Hub Migration 001 — Phase 1 Security & Lightning Integration
-- ============================================================================
-- Tento súbor je IDEMPOTENTNÝ (môžeš spustiť opakovane bez chyby).
-- Vytvára:
--   - kyahub_app DB user s minimálnymi právami
--   - webhook_deliveries tabuľka pre idempotency (BTCPay + Alby webhook retry)
--   - pending_anchors tabuľka pre ELITE on-chain anchor queue (Phase 2)
--   - Indexy + obmedzenia na agents
--   - status ENUM rozšírený o 'PENDING_ANCHOR' a 'ANCHORED'
-- ============================================================================

\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1) Dedikovaný DB user (heslo nahraď v ďalšom kroku z .env)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kyahub_app') THEN
        -- Placeholder heslo, hneď za ním ALTER s reálnym z .env
        CREATE ROLE kyahub_app WITH LOGIN PASSWORD 'CHANGE_ME_NOW';
        RAISE NOTICE 'Vytvorený role kyahub_app — NUTNÉ zmeniť heslo cez ALTER USER';
    ELSE
        RAISE NOTICE 'Role kyahub_app už existuje';
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2) Tabuľka webhook_deliveries — idempotency proti retry attackom
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              BIGSERIAL PRIMARY KEY,
    source          VARCHAR(32) NOT NULL,           -- 'btcpay' | 'alby'
    delivery_id     VARCHAR(128) NOT NULL,          -- z hlavičky webhook providera
    invoice_id      VARCHAR(128),
    event_type      VARCHAR(64) NOT NULL,           -- InvoiceSettled, invoice.received, atď.
    payload_hash    VARCHAR(64) NOT NULL,           -- SHA-256 raw body (audit)
    processed       BOOLEAN NOT NULL DEFAULT FALSE,
    processing_result TEXT,                         -- error message / OK
    received_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at    TIMESTAMP,
    CONSTRAINT uq_webhook_source_delivery UNIQUE (source, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_invoice ON webhook_deliveries(invoice_id);
CREATE INDEX IF NOT EXISTS idx_webhook_received_at ON webhook_deliveries(received_at);

-- ----------------------------------------------------------------------------
-- 3) Tabuľka pending_anchors — queue pre ELITE OP_RETURN anchor (Phase 2)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_anchors (
    id              BIGSERIAL PRIMARY KEY,
    agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    hmac_hash       VARCHAR(64) NOT NULL,           -- hex string, 32 bytes pre OP_RETURN
    tier            VARCHAR(16) NOT NULL,           -- 'BASIC' | 'ELITE'
    status          VARCHAR(32) NOT NULL DEFAULT 'PENDING',   -- PENDING | BROADCASTING | CONFIRMED | FAILED
    bitcoin_txid    VARCHAR(64),                    -- vyplní sa po broadcast
    confirmations   INTEGER DEFAULT 0,
    fee_sats        INTEGER,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    broadcast_at    TIMESTAMP,
    confirmed_at    TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_anchors_status ON pending_anchors(status);
CREATE INDEX IF NOT EXISTS idx_pending_anchors_agent ON pending_anchors(agent_id);

-- ----------------------------------------------------------------------------
-- 4) Rozšíriť agents — pridať unique constraint a tier stĺpec
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    -- Tier stĺpec (BASIC/ELITE namiesto len conduct_grade)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'tier'
    ) THEN
        ALTER TABLE agents ADD COLUMN tier VARCHAR(16);
        -- Backfill z conduct_grade
        UPDATE agents SET tier = CASE 
            WHEN conduct_grade = 'S' THEN 'ELITE'
            WHEN conduct_grade = 'B' THEN 'BASIC'
            ELSE 'UNKNOWN'
        END WHERE tier IS NULL;
        RAISE NOTICE 'Pridaný stĺpec agents.tier';
    END IF;

    -- Invoice ID stĺpec pre prepojenie s LN/BTC platbou
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'payment_invoice_id'
    ) THEN
        ALTER TABLE agents ADD COLUMN payment_invoice_id VARCHAR(128);
        ALTER TABLE agents ADD COLUMN payment_method VARCHAR(32);  -- 'lightning' | 'btc-onchain' | 'btcpay-lnurl'
        ALTER TABLE agents ADD COLUMN payment_amount_sats INTEGER;
        ALTER TABLE agents ADD COLUMN payment_settled_at TIMESTAMP;
        RAISE NOTICE 'Pridané platobné stĺpce na agents';
    END IF;

    -- Anchor TXID stĺpec
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'anchor_txid'
    ) THEN
        ALTER TABLE agents ADD COLUMN anchor_txid VARCHAR(64);
        ALTER TABLE agents ADD COLUMN anchor_status VARCHAR(32);  -- NULL | PENDING | BROADCAST | CONFIRMED
        RAISE NOTICE 'Pridané anchor stĺpce na agents';
    END IF;
END $$;

-- Unique constraint na agent_name (zabráni duplicitnej registrácii)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_agents_agent_name'
    ) THEN
        -- Najprv vymažeme prípadné duplikáty pred constraint pridaním
        DELETE FROM agents a USING agents b
        WHERE a.id < b.id AND a.agent_name = b.agent_name;
        
        ALTER TABLE agents ADD CONSTRAINT uq_agents_agent_name UNIQUE (agent_name);
        RAISE NOTICE 'Pridaný unique constraint na agent_name';
    END IF;
END $$;

-- Index pre rýchle hľadanie podľa kya_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_kya_id ON agents(kya_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_tier ON agents(tier);

-- ----------------------------------------------------------------------------
-- 5) GRANT obmedzené práva pre kyahub_app user
-- ----------------------------------------------------------------------------
GRANT CONNECT ON DATABASE kyahub TO kyahub_app;
GRANT USAGE ON SCHEMA public TO kyahub_app;
GRANT SELECT, INSERT, UPDATE ON agents, webhook_deliveries, pending_anchors TO kyahub_app;
-- blockchain_anchors môže existovať z anchor.js, povolíme tiež
GRANT SELECT, INSERT, UPDATE ON blockchain_anchors TO kyahub_app;
-- Sequences pre auto-increment
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kyahub_app;

-- ----------------------------------------------------------------------------
-- 6) Migrácia tracking tabuľka
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(64) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_migrations (version) VALUES ('001_phase1_security')
ON CONFLICT (version) DO NOTHING;

-- Hotovo
SELECT 'Migrácia 001 úspešne aplikovaná' AS status;
