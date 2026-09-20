-- 015_immutable_signing_intent.sql
-- Upgrades signing idempotency to store immutable transaction intent parameters.
-- Binds sign_request_id strictly to a deterministic intent_hash covering:
-- (network, asset, key_reference, wallet_id, from_address, destination_address, amount_atomic, seqno, valid_until, send_mode, bounce, comment, unsigned_hash).
-- Preserves valid_until, seqno, and unsigned_hash identically across logical retries,
-- and adds lease_expires_at to prevent permanent deadlocks on worker crashes.

ALTER TABLE system.signing_requests
    ADD COLUMN IF NOT EXISTS network VARCHAR(32),
    ADD COLUMN IF NOT EXISTS asset VARCHAR(16),
    ADD COLUMN IF NOT EXISTS from_address VARCHAR(128),
    ADD COLUMN IF NOT EXISTS destination_address VARCHAR(128),
    ADD COLUMN IF NOT EXISTS amount_atomic VARCHAR(64),
    ADD COLUMN IF NOT EXISTS seqno INT,
    ADD COLUMN IF NOT EXISTS valid_until INT,
    ADD COLUMN IF NOT EXISTS intent_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS boc_base64 TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Update status constraint to support CLAIMED and FAILED_RETRYABLE
ALTER TABLE system.signing_requests DROP CONSTRAINT IF EXISTS signing_requests_status_check;
ALTER TABLE system.signing_requests ADD CONSTRAINT signing_requests_status_check
    CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'FAILED_RETRYABLE'));

CREATE INDEX IF NOT EXISTS ix_signing_requests_lease ON system.signing_requests (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS ix_signing_requests_intent_hash ON system.signing_requests (intent_hash);

-- Enforce immutability of intent parameters via trigger
CREATE OR REPLACE FUNCTION system.prevent_signing_intent_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.intent_hash IS NOT NULL AND (
        NEW.intent_hash <> OLD.intent_hash OR
        NEW.from_address <> OLD.from_address OR
        NEW.destination_address <> OLD.destination_address OR
        NEW.amount_atomic <> OLD.amount_atomic OR
        NEW.seqno <> OLD.seqno OR
        NEW.valid_until <> OLD.valid_until OR
        NEW.unsigned_hash <> OLD.unsigned_hash
    ) THEN
        RAISE EXCEPTION 'IMMUTABLE_SIGNING_INTENT_VIOLATION: signing request intent parameters cannot be altered once registered';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_signing_intent_mutation ON system.signing_requests;
CREATE TRIGGER trg_prevent_signing_intent_mutation
    BEFORE UPDATE ON system.signing_requests
    FOR EACH ROW
    EXECUTE FUNCTION system.prevent_signing_intent_mutation();
