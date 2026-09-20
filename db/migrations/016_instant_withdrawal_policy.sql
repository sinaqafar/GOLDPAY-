-- 016_instant_withdrawal_policy.sql
-- GOLDPAY Instant Withdrawal (2% Fee) & Automatic Settlement (0% Fee after 48h hold).
-- SPEC: Instant withdrawal allows immediate settlement with a 2% fee (INSTANT_WITHDRAWAL_FEE),
-- strictly separated from PLATFORM_FEE (15%) and provider fee.
-- Automatic settlement after 48h hold carries a 0% withdrawal fee.

ALTER TABLE finance.payouts
    ADD COLUMN IF NOT EXISTS payout_type VARCHAR(32) NOT NULL DEFAULT 'AUTOMATIC',
    ADD COLUMN IF NOT EXISTS fee_type VARCHAR(64) NOT NULL DEFAULT 'NONE',
    ADD COLUMN IF NOT EXISTS gross_amount_toman NUMERIC(30,0),
    ADD COLUMN IF NOT EXISTS withdrawal_fee_toman NUMERIC(30,0) NOT NULL DEFAULT 0;

ALTER TABLE finance.payouts DROP CONSTRAINT IF EXISTS ck_payout_type;
ALTER TABLE finance.payouts
    ADD CONSTRAINT ck_payout_type CHECK (payout_type IN ('AUTOMATIC', 'INSTANT'));

ALTER TABLE finance.payouts DROP CONSTRAINT IF EXISTS ck_payout_fee_type;
ALTER TABLE finance.payouts
    ADD CONSTRAINT ck_payout_fee_type CHECK (fee_type IN ('NONE', 'INSTANT_WITHDRAWAL_FEE'));
