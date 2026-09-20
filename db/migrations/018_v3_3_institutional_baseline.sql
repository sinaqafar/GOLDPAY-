-- 018 — GOLDPAY v3.3 Enterprise Financial Architecture Institutional Baseline
-- SPEC 118.x / v3.3: PaymentIntents, PaymentAttempts, EvidenceChain, MerkleAnchors,
-- LedgerBlocks, KMSSignatureEvidence, RiskDecisions, OracleGovernance, and TieredIdempotency.

-- 1. Payment Intents & Attempts (Clean pattern without circular FK)
CREATE TABLE IF NOT EXISTS core.payment_intents (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id            UUID NOT NULL REFERENCES core.invoices(id) ON DELETE RESTRICT,
    merchant_id           UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    amount_toman          NUMERIC(30,0) NOT NULL,
    currency              TEXT NOT NULL DEFAULT 'TOMAN',
    status                TEXT NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    succeeded_attempt_id  UUID,
    succeeded_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_payment_intents_status
        CHECK (status IN ('REQUIRES_PAYMENT','PROCESSING','SUCCEEDED','FAILED','CANCELLED')),
    CONSTRAINT ck_payment_intents_amount CHECK (amount_toman > 0)
);

CREATE INDEX IF NOT EXISTS ix_payment_intents_invoice ON core.payment_intents(invoice_id);
CREATE INDEX IF NOT EXISTS ix_payment_intents_merchant ON core.payment_intents(merchant_id, status);

CREATE TABLE IF NOT EXISTS core.payment_attempts (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_intent_id        UUID NOT NULL REFERENCES core.payment_intents(id) ON DELETE RESTRICT,
    invoice_id               UUID NOT NULL REFERENCES core.invoices(id) ON DELETE RESTRICT,
    attempt_number           INTEGER NOT NULL DEFAULT 1,
    provider                 TEXT NOT NULL,
    provider_mode            TEXT NOT NULL,
    provider_version         TEXT NOT NULL,
    provider_order_id        TEXT NOT NULL,
    authority_or_uid         TEXT,
    payment_url              TEXT,
    pay_amount_rial          NUMERIC(20,0) NOT NULL,
    pay_amount_toman         NUMERIC(20,0) NOT NULL,
    provider_fee_snapshot    NUMERIC(20,0),
    provider_config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    status                   TEXT NOT NULL DEFAULT 'INITIATED',
    error_code               TEXT,
    error_message            TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finalized_at             TIMESTAMPTZ,
    UNIQUE(payment_intent_id, attempt_number),
    CONSTRAINT ck_payment_attempts_status
        CHECK (status IN ('INITIATED','PENDING_GATEWAY','VERIFIED','FAILED','EXPIRED','DUPLICATE_SUPERSEDED')),
    CONSTRAINT ck_payment_attempts_mode CHECK (provider_mode IN ('VIP','STANDARD'))
);

CREATE INDEX IF NOT EXISTS ix_payment_attempts_intent_lookup
    ON core.payment_attempts(payment_intent_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS ix_payment_attempts_provider_order
    ON core.payment_attempts(provider, provider_order_id);

-- 2. Evidence Chain & Merkle Anchors
CREATE TABLE IF NOT EXISTS integration.evidence_chain (
    sequence_id            BIGSERIAL PRIMARY KEY,
    evidence_id            UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    payment_attempt_id     UUID REFERENCES core.payment_attempts(id) ON DELETE RESTRICT,
    payment_id             UUID REFERENCES core.payments(id) ON DELETE RESTRICT,
    provider               TEXT NOT NULL,
    previous_hash          CHAR(64) NOT NULL,
    payload_hash           CHAR(64) NOT NULL,
    current_hash           CHAR(64) NOT NULL,
    raw_payload_encrypted  TEXT NOT NULL,
    recorded_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS ix_evidence_chain_seq ON integration.evidence_chain(sequence_id);

CREATE TABLE IF NOT EXISTS integration.evidence_merkle_anchors (
    id                       BIGSERIAL PRIMARY KEY,
    window_start             TIMESTAMPTZ NOT NULL,
    window_end               TIMESTAMPTZ NOT NULL,
    start_sequence_id        BIGINT NOT NULL,
    end_sequence_id          BIGINT NOT NULL,
    record_count             INTEGER NOT NULL,
    merkle_root              CHAR(64) NOT NULL,
    external_worm_uri        TEXT NOT NULL,
    external_worm_version_id TEXT,
    anchored_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 3. Critical Event Receipts (Real-time WORM anchor for high-value financial events)
CREATE TABLE IF NOT EXISTS integration.critical_event_receipts (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type                TEXT NOT NULL,
    aggregate_type            TEXT NOT NULL,
    aggregate_id              UUID NOT NULL,
    payload_hash              CHAR(64) NOT NULL,
    signature_kms_key_id      TEXT NOT NULL,
    cryptographic_signature   TEXT NOT NULL,
    external_worm_uri         TEXT NOT NULL,
    external_worm_version_id  TEXT,
    anchored_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_critical_receipt_event
        CHECK (event_type IN ('PAYMENT_VERIFIED','REFUND_EXECUTED','PAYOUT_SIGNED','TREASURY_MOVEMENT'))
);

CREATE INDEX IF NOT EXISTS ix_critical_receipts_lookup
    ON integration.critical_event_receipts(aggregate_type, aggregate_id);

-- 4. Oracle Governance & Audit Ledger
CREATE TABLE IF NOT EXISTS finance.oracle_sources (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    source_type         TEXT NOT NULL,
    weight_percent      INTEGER NOT NULL CHECK (weight_percent >= 0 AND weight_percent <= 100),
    status              TEXT NOT NULL DEFAULT 'ACTIVE',
    max_divergence_bps  INTEGER NOT NULL DEFAULT 500,
    last_rate           NUMERIC(40,18),
    last_updated_at     TIMESTAMPTZ,
    updated_by_user_id  UUID NOT NULL,
    CONSTRAINT ck_oracle_source_type CHECK (source_type IN ('CEX','DEX','HYBRID','MANUAL')),
    CONSTRAINT ck_oracle_source_status CHECK (status IN ('ACTIVE','INACTIVE','DEGRADED'))
);

CREATE TABLE IF NOT EXISTS finance.oracle_change_history (
    id                      BIGSERIAL PRIMARY KEY,
    oracle_source_id        TEXT NOT NULL REFERENCES finance.oracle_sources(id) ON DELETE RESTRICT,
    previous_weight         INTEGER NOT NULL,
    new_weight              INTEGER NOT NULL,
    previous_status         TEXT NOT NULL,
    new_status              TEXT NOT NULL,
    previous_divergence_bps INTEGER NOT NULL,
    new_divergence_bps      INTEGER NOT NULL,
    change_reason           TEXT NOT NULL,
    updated_by_user_id      UUID NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS ix_oracle_history_source
    ON finance.oracle_change_history(oracle_source_id, created_at DESC);

-- 5. Active Wallets & Cryptographically Chained Wallet History
CREATE TABLE IF NOT EXISTS core.merchant_wallets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id  UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    network      TEXT NOT NULL DEFAULT 'mainnet',
    asset        TEXT NOT NULL DEFAULT 'GRAM',
    address      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'SECURITY_HOLD',
    hold_until   TIMESTAMPTZ NOT NULL,
    verified_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_merchant_wallets_status
        CHECK (status IN ('ACTIVE','SECURITY_HOLD','DISABLED','REVOKED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_merchant_single_active_wallet
    ON core.merchant_wallets(merchant_id, network, asset)
    WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS core.merchant_wallet_history (
    sequence_id          BIGSERIAL PRIMARY KEY,
    id                   UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    merchant_id          UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    wallet_id            UUID REFERENCES core.merchant_wallets(id) ON DELETE RESTRICT,
    old_wallet_address   TEXT,
    new_wallet_address   TEXT NOT NULL,
    network              TEXT NOT NULL,
    actor_type           TEXT NOT NULL,
    actor_id             TEXT NOT NULL,
    telegram_session_id  UUID,
    ip_address           INET,
    user_agent           TEXT,
    hold_duration_hours  INTEGER NOT NULL DEFAULT 24,
    hold_until           TIMESTAMPTZ NOT NULL,
    cancelled_at         TIMESTAMPTZ,
    cancellation_reason  TEXT,
    previous_hash        CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    current_hash         CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS ix_wallet_history_merchant
    ON core.merchant_wallet_history(merchant_id, sequence_id DESC);

-- 6. Monotonic Ledger Sequence & Ledger Blocks
ALTER TABLE finance.journals
    ADD COLUMN IF NOT EXISTS journal_sequence BIGSERIAL;

ALTER TABLE finance.journal_entries
    ADD COLUMN IF NOT EXISTS entry_sequence BIGSERIAL;

CREATE TABLE IF NOT EXISTS finance.ledger_blocks (
    block_id                BIGSERIAL PRIMARY KEY,
    start_journal_sequence  BIGINT NOT NULL,
    end_journal_sequence    BIGINT NOT NULL,
    entry_count             INTEGER NOT NULL,
    previous_block_hash     CHAR(64) NOT NULL,
    merkle_root_hash        CHAR(64) NOT NULL,
    current_block_hash      CHAR(64) NOT NULL,
    external_worm_uri       TEXT,
    external_worm_version_id TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS ix_ledger_blocks_seq
    ON finance.ledger_blocks(start_journal_sequence, end_journal_sequence);

-- 7. KMS Signature Evidence for TON Payouts
CREATE TABLE IF NOT EXISTS finance.kms_signature_evidence (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_id           UUID NOT NULL UNIQUE REFERENCES finance.payouts(id) ON DELETE RESTRICT,
    kms_key_id          TEXT NOT NULL,
    sign_request_id     TEXT NOT NULL UNIQUE,
    payload_raw_hash    CHAR(64) NOT NULL,
    signature_hash      CHAR(64) NOT NULL,
    signed_boc_hash     CHAR(64) NOT NULL,
    signed_boc_uri      TEXT,
    destination_address TEXT NOT NULL,
    amount_nanogram     NUMERIC(40,0) NOT NULL,
    signed_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS ix_kms_sign_evidence_payout
    ON finance.kms_signature_evidence(payout_id);

-- 8. Versioned Risk Decision Audit Log
CREATE TABLE IF NOT EXISTS risk.risk_decisions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type          TEXT NOT NULL,
    entity_id            UUID NOT NULL,
    merchant_id          UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    score                INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    level                TEXT NOT NULL,
    decision             TEXT NOT NULL,
    risk_engine_version  TEXT NOT NULL DEFAULT 'v1.0.0',
    rule_policy_hash     CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    rules_triggered      JSONB NOT NULL DEFAULT '[]'::jsonb,
    context_snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb,
    evaluated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_risk_decisions_level CHECK (level IN ('LOW','MEDIUM','HIGH')),
    CONSTRAINT ck_risk_decisions_decision CHECK (decision IN ('ALLOW','MONITOR','HOLD','REJECT','REVIEW'))
);

CREATE INDEX IF NOT EXISTS ix_risk_decisions_merchant
    ON risk.risk_decisions(merchant_id, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS ix_risk_decisions_entity
    ON risk.risk_decisions(entity_type, entity_id);

-- 9. Tiered Idempotency Keys (Replacing generic system keys with financial retention support)
CREATE TABLE IF NOT EXISTS integration.idempotency_keys (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace         TEXT NOT NULL,
    idempotency_key   TEXT NOT NULL,
    request_hash      CHAR(64) NOT NULL,
    state             TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    response_status   INTEGER,
    response_body     JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at      TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ,
    UNIQUE(namespace, idempotency_key),
    CONSTRAINT ck_idempotency_state CHECK (state IN ('IN_PROGRESS','COMPLETED','FAILED'))
);

CREATE INDEX IF NOT EXISTS ix_idempotency_lookup
    ON integration.idempotency_keys(namespace, idempotency_key);
CREATE INDEX IF NOT EXISTS ix_idempotency_expiry
    ON integration.idempotency_keys(expires_at)
    WHERE state = 'IN_PROGRESS';
