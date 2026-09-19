-- 013_persistent_signing_idempotency.sql
-- Persistent atomic store for signing idempotency.
-- Ensures that across worker restarts, multiple instances, and network retries,
-- a sign_request_id is processed atomically and can never authorize duplicate signatures.

CREATE TABLE IF NOT EXISTS system.signing_requests (
    id UUID PRIMARY KEY,
    sign_request_id VARCHAR(128) NOT NULL,
    payout_id UUID REFERENCES finance.payouts(id) ON DELETE RESTRICT,
    signer_name VARCHAR(64) NOT NULL,
    key_reference VARCHAR(256) NOT NULL,
    unsigned_hash VARCHAR(128) NOT NULL,
    signing_reference VARCHAR(512),
    raw_signature TEXT,
    status VARCHAR(32) NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    signed_at TIMESTAMPTZ,
    CONSTRAINT ux_signing_requests_idempotency UNIQUE (sign_request_id)
);

CREATE INDEX IF NOT EXISTS ix_signing_requests_payout ON system.signing_requests (payout_id);
