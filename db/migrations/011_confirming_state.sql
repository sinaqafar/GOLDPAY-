-- 011 — Put CONFIRMING into the payout lifecycle.
--
-- The state machine declared BROADCASTED -> CONFIRMING -> SETTLED but the code
-- went straight from BROADCASTED to SETTLED, so CONFIRMING was documentation
-- rather than behaviour.
--
-- It earns its place: "the network accepted this" and "the network has buried
-- it deep enough to be final" are different facts, and an operator watching a
-- payout needs to tell them apart. Without it, a transaction sitting at one
-- confirmation for an hour is indistinguishable from one just broadcast.

ALTER TABLE finance.payouts DROP CONSTRAINT ck_payouts_status;
ALTER TABLE finance.payouts ADD CONSTRAINT ck_payouts_status CHECK (status IN (
    'CREATED','QUEUED','RATE_LOCKED','WAITING_LIQUIDITY',
    'RESERVED','SIGNED','BROADCASTED','CONFIRMING','SETTLED','FAILED','UNKNOWN'));

ALTER TABLE finance.payouts DROP CONSTRAINT ck_payouts_locked_before_send;
ALTER TABLE finance.payouts ADD CONSTRAINT ck_payouts_locked_before_send CHECK (
    status NOT IN ('RESERVED','SIGNED','BROADCASTED','CONFIRMING','SETTLED')
    OR (rate IS NOT NULL AND gram_amount_atomic IS NOT NULL)
);

ALTER TABLE finance.payouts DROP CONSTRAINT ck_payouts_signed_evidence;
ALTER TABLE finance.payouts ADD CONSTRAINT ck_payouts_signed_evidence CHECK (
    status NOT IN ('SIGNED','BROADCASTED','CONFIRMING','SETTLED')
    OR (signed_at IS NOT NULL AND signing_reference IS NOT NULL)
);

-- CONFIRMING holds committed money exactly as BROADCASTED does.
DROP INDEX finance.ux_payouts_merchant_in_flight;
CREATE UNIQUE INDEX ux_payouts_merchant_in_flight
    ON finance.payouts(merchant_id)
    WHERE status IN ('CREATED','QUEUED','RATE_LOCKED','WAITING_LIQUIDITY',
                     'RESERVED','SIGNED','BROADCASTED','CONFIRMING','UNKNOWN');

-- Payouts awaiting finality are their own watch list.
CREATE INDEX ix_payouts_confirming ON finance.payouts(status, broadcasted_at)
    WHERE status = 'CONFIRMING';
