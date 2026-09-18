-- 007 — Refund model.
--
-- The STRUCTURE is defined here; financial execution stays disabled until the
-- provider's actual refund behaviour is known.
--
-- The reason is specific, not caution for its own sake: CubePay's published API
-- documents payments and status queries but does not define how a refund treats
-- the fee it already took. Until that is settled, any rule we wrote about
-- reversing the platform's 15% would be a guess — and SPEC 121.107 forbids
-- inventing a financial rule.
--
-- So the fee components are stored SEPARATELY from the start:
--
--     original_amount
--     original_platform_fee
--     original_provider_fee
--     platform_fee_reversal      <- decided by policy, once known
--     provider_fee_reversal      <- decided by the provider contract
--     actual_refund_amount
--
-- When the contract is known, only the policy that fills those reversal columns
-- has to be written. The ledger, the payment core and this table do not change.

CREATE TABLE core.refunds (
    id                     UUID PRIMARY KEY,
    payment_id             UUID NOT NULL REFERENCES core.payments(id) ON DELETE RESTRICT,
    merchant_id            UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,

    -- Snapshot of what is being reversed, taken at request time so a later
    -- change to fees or configuration cannot rewrite history.
    original_amount        NUMERIC(30,0) NOT NULL,
    original_platform_fee  NUMERIC(30,0) NOT NULL,
    original_provider_fee  NUMERIC(30,0),

    requested_amount       NUMERIC(30,0) NOT NULL,

    -- Filled in once the refund policy is settled. NULL means undecided, which
    -- is why execution cannot proceed while they are null.
    platform_fee_reversal  NUMERIC(30,0),
    provider_fee_reversal  NUMERIC(30,0),
    actual_refund_amount   NUMERIC(30,0),

    status                 TEXT NOT NULL,
    reason                 TEXT NOT NULL,

    -- Who asked, and who approved. A refund moves money away from a merchant,
    -- so it is an audited action like any other.
    requested_by_type      TEXT NOT NULL,
    requested_by_id        UUID,
    approved_by_id         UUID,

    provider_refund_id     TEXT,
    failure_code           TEXT,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at            TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,

    CONSTRAINT ck_refunds_status CHECK (status IN (
        'REQUESTED','BLOCKED_POLICY_UNDEFINED','APPROVED','PROCESSING',
        'SUCCEEDED','FAILED','UNKNOWN','REJECTED')),
    CONSTRAINT ck_refunds_amount_positive CHECK (requested_amount > 0),
    CONSTRAINT ck_refunds_not_more_than_original
        CHECK (requested_amount <= original_amount),
    CONSTRAINT ck_refunds_requester CHECK (requested_by_type IN ('MERCHANT','ADMIN','SYSTEM')),
    -- SPEC 121.86: a completed refund must state exactly what was returned.
    CONSTRAINT ck_refunds_completed_amount CHECK (
        status <> 'SUCCEEDED' OR actual_refund_amount IS NOT NULL
    )
);

CREATE INDEX ix_refunds_payment ON core.refunds(payment_id);
CREATE INDEX ix_refunds_merchant_status ON core.refunds(merchant_id, status);
CREATE INDEX ix_refunds_open ON core.refunds(status, created_at)
    WHERE status IN ('REQUESTED','BLOCKED_POLICY_UNDEFINED','APPROVED','PROCESSING','UNKNOWN');

-- SPEC 121.86: total refunds against one payment may never exceed what was
-- actually collected. Enforced in the application inside a locking transaction
-- AND defended here, because an application bug must not be able to over-refund
-- (SPEC 89.76 — both layers defend the invariant).
CREATE OR REPLACE FUNCTION core.assert_refund_within_limit()
RETURNS TRIGGER AS $$
DECLARE
    already NUMERIC(30,0);
    collected NUMERIC(30,0);
BEGIN
    SELECT COALESCE(SUM(requested_amount), 0) INTO already
      FROM core.refunds
     WHERE payment_id = NEW.payment_id
       AND status NOT IN ('FAILED','REJECTED')
       AND id <> NEW.id;

    SELECT verified_amount INTO collected
      FROM core.payments WHERE id = NEW.payment_id;

    IF collected IS NULL THEN
        RAISE EXCEPTION 'cannot refund a payment with no verified amount';
    END IF;

    IF already + NEW.requested_amount > collected THEN
        RAISE EXCEPTION 'refund total %/% exceeds the collected amount',
            already + NEW.requested_amount, collected;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refund_within_limit
    BEFORE INSERT OR UPDATE OF requested_amount ON core.refunds
    FOR EACH ROW EXECUTE FUNCTION core.assert_refund_within_limit();
