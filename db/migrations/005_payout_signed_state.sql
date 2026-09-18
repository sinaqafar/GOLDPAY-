-- 005 — Separate the SIGNED stage of a payout from BROADCASTED.
--
-- SPEC PART 90.10 (Recipe — Signing) and SPEC 5496–5501 ("Signed But Not
-- Broadcast"). Signing and broadcasting are two distinct external operations
-- with two distinct failure modes:
--
--   * a signature may exist while the broadcast outcome is still unknown;
--   * a worker must NOT build and sign a second transaction for a payout that
--     already has a signed payload, or the same money can leave twice.
--
-- Collapsing both into BROADCASTED made that ambiguity unrepresentable, so a
-- crash between "signer returned" and "network accepted" could not be
-- described — and therefore could not be recovered correctly.

ALTER TABLE finance.payouts
    ADD COLUMN signed_at          TIMESTAMPTZ,
    -- Opaque reference to the signed payload held by the signer/KMS.
    -- SPEC 118.37 / 5485-5487: never key material, only a handle.
    ADD COLUMN signing_reference  TEXT;

-- Widen the status domain. The old constraint is replaced rather than extended
-- so the allowed set stays in one readable place.
ALTER TABLE finance.payouts DROP CONSTRAINT ck_payouts_status;
ALTER TABLE finance.payouts ADD CONSTRAINT ck_payouts_status CHECK (status IN (
    'CREATED','QUEUED','RATE_LOCKED','WAITING_LIQUIDITY',
    'RESERVED','SIGNED','BROADCASTED','SETTLED','FAILED','UNKNOWN'));

-- A payout may only be past RATE_LOCKED once the rate is actually locked.
ALTER TABLE finance.payouts DROP CONSTRAINT ck_payouts_locked_before_send;
ALTER TABLE finance.payouts ADD CONSTRAINT ck_payouts_locked_before_send CHECK (
    status NOT IN ('RESERVED','SIGNED','BROADCASTED','SETTLED')
    OR (rate IS NOT NULL AND gram_amount_atomic IS NOT NULL)
);

-- SIGNED and everything after it must carry the signing evidence, so the
-- "did we already sign?" question is answerable from the row alone.
ALTER TABLE finance.payouts ADD CONSTRAINT ck_payouts_signed_evidence CHECK (
    status NOT IN ('SIGNED','BROADCASTED','SETTLED')
    OR (signed_at IS NOT NULL AND signing_reference IS NOT NULL)
);

-- SIGNED holds committed money exactly like RESERVED and BROADCASTED do, so it
-- belongs in the in-flight set that blocks a second concurrent payout.
DROP INDEX finance.ux_payouts_merchant_in_flight;
CREATE UNIQUE INDEX ux_payouts_merchant_in_flight
    ON finance.payouts(merchant_id)
    WHERE status IN ('CREATED','QUEUED','RATE_LOCKED','WAITING_LIQUIDITY',
                     'RESERVED','SIGNED','BROADCASTED','UNKNOWN');

-- Signed-but-not-broadcast payouts need their own scan: they are the most
-- dangerous state to leave unattended.
CREATE INDEX ix_payouts_signed ON finance.payouts(status, signed_at)
    WHERE status = 'SIGNED';
