-- 015_immutable_signing_intent.sql
-- Upgrades signing idempotency to store immutable transaction intent parameters.
-- Binds sign_request_id strictly to a deterministic intent_hash covering:
-- (network, asset, key_reference, wallet_id, from_address, destination_address, amount_atomic, seqno, valid_until, send_mode, bounce, comment, unsigned_hash).
-- Preserves valid_until, seqno, and unsigned_hash identically across logical retries,
-- and adds lease_expires_at and claim_token to prevent deadlocks and stale-worker race conditions.

ALTER TABLE system.signing_requests
    ADD COLUMN IF NOT EXISTS network VARCHAR(32),
    ADD COLUMN IF NOT EXISTS asset VARCHAR(16),
    ADD COLUMN IF NOT EXISTS key_reference VARCHAR(256),
    ADD COLUMN IF NOT EXISTS wallet_id INT DEFAULT 698983191,
    ADD COLUMN IF NOT EXISTS from_address VARCHAR(128),
    ADD COLUMN IF NOT EXISTS destination_address VARCHAR(128),
    ADD COLUMN IF NOT EXISTS amount_atomic VARCHAR(64),
    ADD COLUMN IF NOT EXISTS seqno INT,
    ADD COLUMN IF NOT EXISTS valid_until INT,
    ADD COLUMN IF NOT EXISTS send_mode INT DEFAULT 3,
    ADD COLUMN IF NOT EXISTS bounce BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS comment VARCHAR(128),
    ADD COLUMN IF NOT EXISTS intent_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS boc_base64 TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS claim_token UUID;

-- Update status constraint to support CLAIMED and FAILED_RETRYABLE
ALTER TABLE system.signing_requests DROP CONSTRAINT IF EXISTS signing_requests_status_check;
ALTER TABLE system.signing_requests ADD CONSTRAINT signing_requests_status_check
    CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'FAILED_RETRYABLE'));

CREATE INDEX IF NOT EXISTS ix_signing_requests_lease ON system.signing_requests (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS ix_signing_requests_intent_hash ON system.signing_requests (intent_hash);

-- Enforce strict immutability of intent parameters via trigger using IS DISTINCT FROM
CREATE OR REPLACE FUNCTION system.prevent_signing_intent_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.intent_hash IS NOT NULL AND (
        NEW.intent_hash IS DISTINCT FROM OLD.intent_hash OR
        NEW.unsigned_hash IS DISTINCT FROM OLD.unsigned_hash OR
        NEW.network IS DISTINCT FROM OLD.network OR
        NEW.asset IS DISTINCT FROM OLD.asset OR
        NEW.key_reference IS DISTINCT FROM OLD.key_reference OR
        NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR
        NEW.from_address IS DISTINCT FROM OLD.from_address OR
        NEW.destination_address IS DISTINCT FROM OLD.destination_address OR
        NEW.amount_atomic IS DISTINCT FROM OLD.amount_atomic OR
        NEW.seqno IS DISTINCT FROM OLD.seqno OR
        NEW.valid_until IS DISTINCT FROM OLD.valid_until OR
        NEW.send_mode IS DISTINCT FROM OLD.send_mode OR
        NEW.bounce IS DISTINCT FROM OLD.bounce OR
        NEW.comment IS DISTINCT FROM OLD.comment
    ) THEN
        RAISE EXCEPTION 'IMMUTABLE_SIGNING_INTENT_VIOLATION: signing request intent parameters cannot be altered or set to NULL once registered';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_signing_intent_mutation ON system.signing_requests;
CREATE TRIGGER trg_prevent_signing_intent_mutation
    BEFORE UPDATE ON system.signing_requests
    FOR EACH ROW
    EXECUTE FUNCTION system.prevent_signing_intent_mutation();
