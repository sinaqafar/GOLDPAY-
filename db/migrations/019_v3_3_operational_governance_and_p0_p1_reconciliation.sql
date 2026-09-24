-- 019 — GOLDPAY v3.3 Operational Governance, Provider Runtime State & P0/P1 Integrity Reconciliation

-- 1. DB-Backed Provider Runtime State (Source of Truth for Mode Switching)
CREATE TABLE IF NOT EXISTS core.provider_runtime_state (
    provider_name       VARCHAR(32) PRIMARY KEY DEFAULT 'CUBEPAY',
    active_mode         VARCHAR(32) NOT NULL DEFAULT 'VIP',
    version             INTEGER NOT NULL DEFAULT 1,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    changed_by          TEXT NOT NULL DEFAULT 'SYSTEM_BOOT',
    approved_by         TEXT NOT NULL DEFAULT 'SYSTEM_BOOT',
    reason              TEXT NOT NULL DEFAULT 'Initial institutional baseline',
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT ck_provider_runtime_active_mode CHECK (active_mode IN ('VIP', 'STANDARD'))
);

INSERT INTO core.provider_runtime_state (provider_name, active_mode, version, changed_by, approved_by, reason)
VALUES ('CUBEPAY', 'VIP', 1, 'SYSTEM_BOOT', 'SYSTEM_BOOT', 'Initial production VIP baseline')
ON CONFLICT (provider_name) DO NOTHING;

-- 2. Provider Mode Switch Requests (Four-Eyes Approval Governance)
CREATE TABLE IF NOT EXISTS core.provider_mode_switch_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_name       VARCHAR(32) NOT NULL DEFAULT 'CUBEPAY',
    current_mode        VARCHAR(32) NOT NULL,
    requested_mode      VARCHAR(32) NOT NULL,
    proposed_by         TEXT NOT NULL,
    proposed_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    reason              TEXT NOT NULL,
    status              VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    approved_by         TEXT,
    approved_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT ck_switch_request_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT ck_switch_request_modes CHECK (requested_mode IN ('VIP', 'STANDARD') AND current_mode IN ('VIP', 'STANDARD'))
);

CREATE INDEX IF NOT EXISTS ix_switch_requests_status
    ON core.provider_mode_switch_requests(provider_name, status);

-- 3. Enhance Tiered Idempotency Keys with Lease, Owner Token, and Aggregate Tracking
ALTER TABLE integration.idempotency_keys
    ADD COLUMN IF NOT EXISTS owner_token TEXT,
    ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS aggregate_type TEXT,
    ADD COLUMN IF NOT EXISTS aggregate_id UUID,
    ADD COLUMN IF NOT EXISTS provider_attempt_id UUID;

CREATE INDEX IF NOT EXISTS ix_idempotency_aggregate
    ON integration.idempotency_keys(aggregate_type, aggregate_id);

-- 4. Enhance Core Invoices with Provider Creation Lifecycle State Machine
ALTER TABLE core.invoices
    ADD COLUMN IF NOT EXISTS provider_create_status TEXT NOT NULL DEFAULT 'CREATED',
    ADD COLUMN IF NOT EXISTS provider_create_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_provider_error TEXT,
    ADD COLUMN IF NOT EXISTS provider_effective_expires_at TIMESTAMPTZ;

-- 5. Webhook Endpoints Secret Encryption at Rest
ALTER TABLE core.webhook_endpoints
    ADD COLUMN IF NOT EXISTS secret_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS secret_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS secret_hash CHAR(64);

-- 6. Default Oracle Governance Seeds
INSERT INTO finance.oracle_sources (id, name, source_type, weight_percent, status, max_divergence_bps, updated_by_user_id)
VALUES
    ('COINGECKO', 'CoinGecko Crypto (TON/USD)', 'CEX', 50, 'ACTIVE', 500, '00000000-0000-0000-0000-000000000001'),
    ('COINPAPRIKA', 'CoinPaprika Crypto (TON/USD)', 'CEX', 50, 'ACTIVE', 500, '00000000-0000-0000-0000-000000000001'),
    ('TINDEX_FX', 'Tindex FX (USD/TOMAN)', 'HYBRID', 50, 'ACTIVE', 500, '00000000-0000-0000-0000-000000000001'),
    ('FX_FALLBACK', 'Generic Secondary FX (USD/TOMAN)', 'HYBRID', 50, 'ACTIVE', 500, '00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;
