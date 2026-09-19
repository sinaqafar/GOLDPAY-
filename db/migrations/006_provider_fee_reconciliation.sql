-- 006 — Record the provider fee we EXPECTED alongside the one the provider
-- actually reported, and flag any divergence.
--
-- The configured PROVIDER_FEE_PERCENT is an expectation, not an observation.
-- CubePay's documented API does not guarantee a field for the fee it deducted,
-- so treating our own configured 9% as fact would let a silent rate change go
-- unnoticed while the ledger kept reporting a margin that was never earned.
--
--   Config  → Expected
--   Provider evidence → Actual
--   Reconciliation → Expected vs Actual
--
-- `provider_fee_status` says which of those we are looking at:
--
--   CONFIG_ESTIMATED   the provider reported nothing; expected only
--   PROVIDER_CONFIRMED the provider reported a figure and it matched
--   MISMATCH           the provider reported a different figure
--   UNAVAILABLE        verification could not be completed

ALTER TABLE core.payments
    ADD COLUMN provider_fee_expected    NUMERIC(30,0),
    ADD COLUMN provider_fee_actual      NUMERIC(30,0),
    ADD COLUMN provider_fee_source      TEXT,
    ADD COLUMN provider_fee_verified_at TIMESTAMPTZ,
    ADD COLUMN provider_fee_difference  NUMERIC(30,0),
    ADD COLUMN provider_fee_status      TEXT;

ALTER TABLE core.payments ADD CONSTRAINT ck_payments_provider_fee_status CHECK (
    provider_fee_status IS NULL
    OR provider_fee_status IN ('CONFIG_ESTIMATED','PROVIDER_CONFIRMED','MISMATCH','UNAVAILABLE')
);

ALTER TABLE core.payments ADD CONSTRAINT ck_payments_provider_fee_nonneg CHECK (
    (provider_fee_expected IS NULL OR provider_fee_expected >= 0)
    AND (provider_fee_actual IS NULL OR provider_fee_actual >= 0)
);

-- A confirmed or mismatched status requires the provider to have actually
-- reported something; otherwise the status would be claiming knowledge we
-- do not have.
ALTER TABLE core.payments ADD CONSTRAINT ck_payments_provider_fee_evidence CHECK (
    provider_fee_status NOT IN ('PROVIDER_CONFIRMED','MISMATCH')
    OR provider_fee_actual IS NOT NULL
);

-- Finding every payment whose fee disagreed is a routine finance question.
CREATE INDEX ix_payments_provider_fee_mismatch
    ON core.payments(provider_fee_status, created_at)
    WHERE provider_fee_status = 'MISMATCH';
