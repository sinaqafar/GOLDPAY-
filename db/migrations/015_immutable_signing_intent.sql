-- 015_immutable_signing_intent.sql
-- Upgrades signing idempotency to store immutable transaction intent parameters.
-- Binds sign_request_id strictly to (destination, amount, seqno, valid_until, unsigned_hash).
-- Guarantees that valid_until and seqno are preserved identically across logical retries,
-- and adds lease_expires_at to prevent permanent deadlocks on worker crashes.

ALTER TABLE system.signing_requests
    ADD COLUMN IF NOT EXISTS from_address VARCHAR(128),
    ADD COLUMN IF NOT EXISTS destination_address VARCHAR(128),
    ADD COLUMN IF NOT EXISTS amount_atomic VARCHAR(64),
    ADD COLUMN IF NOT EXISTS seqno INT,
    ADD COLUMN IF NOT EXISTS valid_until INT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Update status constraint to support CLAIMED and FAILED_RETRYABLE
ALTER TABLE system.signing_requests DROP CONSTRAINT IF EXISTS signing_requests_status_check;
ALTER TABLE system.signing_requests ADD CONSTRAINT signing_requests_status_check
    CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'FAILED_RETRYABLE'));

CREATE INDEX IF NOT EXISTS ix_signing_requests_lease ON system.signing_requests (status, lease_expires_at);
