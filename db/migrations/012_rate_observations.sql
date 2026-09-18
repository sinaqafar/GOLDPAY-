-- 012 — Persist what each quote was derived from.
--
-- Two gaps this closes.
--
-- The deviation guard compared each new rate to the previous one held in
-- process memory, so the first quote after a restart was compared to nothing
-- and any move, however implausible, was accepted. Persisting the last good
-- quote makes the guard survive a deploy.
--
-- And a payout recorded only the derived rate, so months later it was
-- impossible to say which two market observations priced it. For a settlement
-- that moved real money, "we cannot reconstruct how this price was reached" is
-- not an acceptable answer.

ALTER TABLE finance.rate_quotes
    ADD COLUMN crypto_value        NUMERIC(40,18),
    ADD COLUMN crypto_source       TEXT,
    ADD COLUMN crypto_observed_at  TIMESTAMPTZ,
    ADD COLUMN fx_value            NUMERIC(40,18),
    ADD COLUMN fx_source           TEXT,
    ADD COLUMN fx_observed_at      TIMESTAMPTZ,
    ADD COLUMN calculated_at       TIMESTAMPTZ;

CREATE INDEX ix_rate_quotes_recent ON finance.rate_quotes(created_at DESC);
