-- 002 — double-entry ledger, balances, payouts, treasury and liquidity.
-- SPEC 118.16-118.29, 119.x. The ledger is the source of truth; `balances` is a
-- projection of it (SPEC 103941/103942: on disagreement, the ledger wins).

-- SPEC 118.16 / 118.17 — Chart of accounts
CREATE TABLE finance.ledger_accounts (
    id            UUID PRIMARY KEY,
    -- NOT globally unique: every merchant owns a row carrying the same code
    -- ('MERCHANT_LIABILITY_TOMAN'), distinguished by owner_id.
    account_code  TEXT NOT NULL,
    account_type  TEXT NOT NULL,
    owner_type    TEXT,
    owner_id      UUID,
    currency      TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_accounts_type
        CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE','MEMO')),
    CONSTRAINT ck_accounts_currency CHECK (currency IN ('TOMAN','GRAM')),
    CONSTRAINT ck_accounts_status CHECK (status IN ('ACTIVE','CLOSED')),
    CONSTRAINT ck_accounts_owner_type
        CHECK (owner_type IS NULL OR owner_type IN ('MERCHANT','USER','PLATFORM')),
    -- An owned account must name both its owner type and id; a system account
    -- must name neither.
    CONSTRAINT ck_accounts_owner
        CHECK ((owner_type IS NULL) = (owner_id IS NULL))
);

CREATE INDEX ix_accounts_owner ON finance.ledger_accounts(owner_type, owner_id);

-- A merchant has exactly one liability account per code.
CREATE UNIQUE INDEX ux_accounts_owner_code
    ON finance.ledger_accounts(owner_type, owner_id, account_code)
    WHERE owner_id IS NOT NULL;

-- System accounts (no owner) are unique by code alone.
CREATE UNIQUE INDEX ux_accounts_system_code
    ON finance.ledger_accounts(account_code)
    WHERE owner_id IS NULL;

-- SPEC 118.18 — Journals. `operation_id` is the idempotency anchor: the same
-- business operation can never post twice (SPEC 119.41: three identical
-- callbacks must produce exactly ONE economic result).
CREATE TABLE finance.journals (
    id              UUID PRIMARY KEY,
    reference_type  TEXT NOT NULL,
    reference_id    UUID NOT NULL,
    operation_id    TEXT NOT NULL UNIQUE,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_journals_reference ON finance.journals(reference_type, reference_id);

-- SPEC 118.19 — Journal entries
CREATE TABLE finance.journal_entries (
    id          UUID PRIMARY KEY,
    journal_id  UUID NOT NULL REFERENCES finance.journals(id) ON DELETE RESTRICT,
    account_id  UUID NOT NULL REFERENCES finance.ledger_accounts(id) ON DELETE RESTRICT,

    debit       NUMERIC(40,0) NOT NULL DEFAULT 0,
    credit      NUMERIC(40,0) NOT NULL DEFAULT 0,

    currency    TEXT NOT NULL,
    /** Which balance bucket this entry moves, for the projection. */
    bucket      TEXT NOT NULL DEFAULT 'AVAILABLE',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (debit >= 0),
    CHECK (credit >= 0),
    CHECK (NOT (debit > 0 AND credit > 0)),
    CHECK (debit > 0 OR credit > 0),
    CONSTRAINT ck_entries_currency CHECK (currency IN ('TOMAN','GRAM')),
    CONSTRAINT ck_entries_bucket
        CHECK (bucket IN ('AVAILABLE','PENDING','SETTLING','REVIEW_HOLD'))
);

CREATE INDEX ix_entries_journal ON finance.journal_entries(journal_id);
CREATE INDEX ix_entries_account ON finance.journal_entries(account_id);

-- SPEC 118.20 / 103938 — every journal must balance: SUM(debit) = SUM(credit).
-- Enforced by a DEFERRED constraint trigger so the check runs at COMMIT, after
-- all the entries of the journal have been inserted.
CREATE FUNCTION finance.assert_journal_balanced() RETURNS trigger AS $$
DECLARE
    v_debit  NUMERIC(40,0);
    v_credit NUMERIC(40,0);
    v_cur    TEXT;
BEGIN
    -- Balance must hold per currency: a TOMAN leg can never offset a GRAM leg.
    FOR v_cur IN
        SELECT DISTINCT currency FROM finance.journal_entries WHERE journal_id = NEW.id
    LOOP
        SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
          INTO v_debit, v_credit
          FROM finance.journal_entries
         WHERE journal_id = NEW.id AND currency = v_cur;

        IF v_debit <> v_credit THEN
            RAISE EXCEPTION
                'LEDGER_UNBALANCED: journal % currency % debit=% credit=%',
                NEW.id, v_cur, v_debit, v_credit
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM finance.journal_entries WHERE journal_id = NEW.id) THEN
        RAISE EXCEPTION 'LEDGER_EMPTY_JOURNAL: journal % has no entries', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_balanced
    AFTER INSERT ON finance.journals
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION finance.assert_journal_balanced();

-- SPEC 118.45 / 118.46 — journals and their entries are immutable history.
CREATE FUNCTION finance.prevent_financial_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_FINANCIAL_RECORD: % on %.% is not permitted',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journals_immutable
    BEFORE UPDATE OR DELETE ON finance.journals
    FOR EACH ROW EXECUTE FUNCTION finance.prevent_financial_mutation();

CREATE TRIGGER trg_journal_entries_immutable
    BEFORE UPDATE OR DELETE ON finance.journal_entries
    FOR EACH ROW EXECUTE FUNCTION finance.prevent_financial_mutation();

-- SPEC 118.21 / 118.22 — balance projection with non-negative buckets.
CREATE TABLE finance.balances (
    account_id   UUID PRIMARY KEY REFERENCES finance.ledger_accounts(id) ON DELETE RESTRICT,
    available    NUMERIC(40,0) NOT NULL DEFAULT 0,
    pending      NUMERIC(40,0) NOT NULL DEFAULT 0,
    settling     NUMERIC(40,0) NOT NULL DEFAULT 0,
    review_hold  NUMERIC(40,0) NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- SPEC REQ-FIN-003: no bucket may ever go negative.
    CHECK (available   >= 0),
    CHECK (pending     >= 0),
    CHECK (settling    >= 0),
    CHECK (review_hold >= 0)
);

-- SPEC 118.25 — Treasury accounts (funded manually by the owner only).
CREATE TABLE finance.treasury_accounts (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    network     TEXT NOT NULL,
    asset       TEXT NOT NULL,
    address     TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL,
    -- Confirmed on-chain balance in atomic units (nanoGRAM).
    confirmed_balance_atomic  NUMERIC(40,0) NOT NULL DEFAULT 0,
    -- SPEC 56.15: reserve that is never spendable by payouts.
    safety_reserve_atomic     NUMERIC(40,0) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_treasury_status CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
    CONSTRAINT ck_treasury_balance_nonneg CHECK (confirmed_balance_atomic >= 0),
    CONSTRAINT ck_treasury_reserve_nonneg CHECK (safety_reserve_atomic >= 0)
);

-- SPEC 118.26 — Treasury movements. Funding is always manual.
CREATE TABLE finance.treasury_transactions (
    id                   UUID PRIMARY KEY,
    treasury_account_id  UUID NOT NULL
        REFERENCES finance.treasury_accounts(id) ON DELETE RESTRICT,
    direction            TEXT NOT NULL,
    asset                TEXT NOT NULL,
    amount_atomic        NUMERIC(40,0) NOT NULL,
    external_tx_hash     TEXT,
    status               TEXT NOT NULL,
    -- SPEC 118.27: funding may only ever be recorded as MANUAL.
    source               TEXT NOT NULL DEFAULT 'MANUAL',
    payout_id            UUID,
    detected_at          TIMESTAMPTZ,
    confirmed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_treasury_tx_direction CHECK (direction IN ('IN','OUT')),
    CONSTRAINT ck_treasury_tx_status CHECK (status IN ('DETECTED','CONFIRMED','FAILED')),
    CONSTRAINT ck_treasury_tx_amount CHECK (amount_atomic > 0),
    -- SPEC 103945 / 119.25: no automated buy/swap/bridge funding path may exist.
    CONSTRAINT ck_treasury_tx_source
        CHECK (source IN ('MANUAL','PAYOUT','NETWORK_FEE'))
);

CREATE UNIQUE INDEX ux_treasury_tx_hash
    ON finance.treasury_transactions(external_tx_hash)
    WHERE external_tx_hash IS NOT NULL;
CREATE INDEX ix_treasury_tx_account ON finance.treasury_transactions(treasury_account_id, status);

-- SPEC 118.23 / 118.24 — Payouts with an immutable rate snapshot.
CREATE TABLE finance.payouts (
    id                   UUID PRIMARY KEY,
    merchant_id          UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    wallet_id            UUID NOT NULL REFERENCES core.wallets(id) ON DELETE RESTRICT,

    amount_toman         NUMERIC(30,0) NOT NULL,
    gram_amount_atomic   NUMERIC(40,0),

    rate                 NUMERIC(40,18),
    rate_source          TEXT,
    quote_id             UUID,
    rate_locked_at       TIMESTAMPTZ,
    quote_expires_at     TIMESTAMPTZ,

    status               TEXT NOT NULL,

    -- Snapshot of the destination at creation time: a later wallet change must
    -- never silently redirect an in-flight payout.
    destination_address  TEXT NOT NULL,
    destination_network  TEXT NOT NULL,

    reserved_at          TIMESTAMPTZ,
    broadcasted_at       TIMESTAMPTZ,
    confirmed_at         TIMESTAMPTZ,

    transaction_hash     TEXT,
    failure_code         TEXT,
    attempt_count        INTEGER NOT NULL DEFAULT 0,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_payouts_amount CHECK (amount_toman > 0),
    CONSTRAINT ck_payouts_gram_nonneg
        CHECK (gram_amount_atomic IS NULL OR gram_amount_atomic > 0),
    CONSTRAINT ck_payouts_status CHECK (status IN (
        'CREATED','QUEUED','RATE_LOCKED','WAITING_LIQUIDITY',
        'RESERVED','BROADCASTED','SETTLED','FAILED','UNKNOWN')),
    CONSTRAINT ck_payouts_rate_complete CHECK (
        (rate IS NULL AND rate_source IS NULL AND gram_amount_atomic IS NULL)
        OR (rate IS NOT NULL AND rate_source IS NOT NULL AND gram_amount_atomic IS NOT NULL)
    ),
    CONSTRAINT ck_payouts_rate_positive CHECK (rate IS NULL OR rate > 0),
    -- A payout can only be past RATE_LOCKED once the rate is actually locked.
    CONSTRAINT ck_payouts_locked_before_send CHECK (
        status NOT IN ('RESERVED','BROADCASTED','SETTLED')
        OR (rate IS NOT NULL AND gram_amount_atomic IS NOT NULL)
    ),
    -- SETTLED requires on-chain evidence (SPEC 124.168).
    CONSTRAINT ck_payouts_settled_evidence CHECK (
        status <> 'SETTLED'
        OR (transaction_hash IS NOT NULL AND confirmed_at IS NOT NULL)
    ),
    CONSTRAINT ck_payouts_attempts CHECK (attempt_count >= 0)
);

CREATE INDEX ix_payouts_merchant_status ON finance.payouts(merchant_id, status);
CREATE INDEX ix_payouts_queue ON finance.payouts(status, created_at);
CREATE INDEX ix_payouts_unknown ON finance.payouts(status, updated_at)
    WHERE status = 'UNKNOWN';
CREATE UNIQUE INDEX ux_payouts_tx_hash
    ON finance.payouts(transaction_hash)
    WHERE transaction_hash IS NOT NULL;

-- A merchant may only have one payout consuming their balance at a time, which
-- closes the double-spend race in SPEC 117.89.
CREATE UNIQUE INDEX ux_payouts_merchant_in_flight
    ON finance.payouts(merchant_id)
    WHERE status IN ('CREATED','QUEUED','RATE_LOCKED','WAITING_LIQUIDITY','RESERVED','BROADCASTED','UNKNOWN');

-- Which payments a payout settled — the audit trail from payment to GRAM.
CREATE TABLE finance.payout_items (
    payout_id   UUID NOT NULL REFERENCES finance.payouts(id) ON DELETE RESTRICT,
    payment_id  UUID NOT NULL REFERENCES core.payments(id) ON DELETE RESTRICT,
    amount_toman NUMERIC(30,0) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (payout_id, payment_id),
    CONSTRAINT ck_payout_items_amount CHECK (amount_toman > 0)
);

-- A payment may only ever be settled by one payout.
CREATE UNIQUE INDEX ux_payout_items_payment ON finance.payout_items(payment_id);

-- SPEC 118.28 / 118.29 — liquidity reservations
CREATE TABLE finance.liquidity_reservations (
    id                   UUID PRIMARY KEY,
    payout_id            UUID NOT NULL REFERENCES finance.payouts(id) ON DELETE RESTRICT,
    treasury_account_id  UUID NOT NULL
        REFERENCES finance.treasury_accounts(id) ON DELETE RESTRICT,
    amount_atomic        NUMERIC(40,0) NOT NULL,
    status               TEXT NOT NULL,
    expires_at           TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at          TIMESTAMPTZ,
    CONSTRAINT ck_reservations_status
        CHECK (status IN ('ACTIVE','CONSUMED','RELEASED','EXPIRED')),
    CONSTRAINT ck_reservations_amount CHECK (amount_atomic > 0)
);

-- SPEC 118.29 — at most one ACTIVE reservation per payout.
CREATE UNIQUE INDEX ux_active_payout_reservation
    ON finance.liquidity_reservations(payout_id)
    WHERE status = 'ACTIVE';

CREATE INDEX ix_reservations_expiry
    ON finance.liquidity_reservations(status, expires_at)
    WHERE status = 'ACTIVE';

-- Rate quotes (SPEC 117.52): a payout locks one and it cannot drift afterwards.
CREATE TABLE finance.rate_quotes (
    id            UUID PRIMARY KEY,
    base_currency TEXT NOT NULL,
    quote_asset   TEXT NOT NULL,
    rate          NUMERIC(40,18) NOT NULL,
    source        TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_quotes_rate_positive CHECK (rate > 0),
    CONSTRAINT ck_quotes_ttl CHECK (expires_at > created_at)
);

CREATE INDEX ix_quotes_lookup ON finance.rate_quotes(base_currency, quote_asset, expires_at);
