-- 008 — Risk scoring and dispute cases.
--
-- Two deliberately limited engines.
--
-- RISK: scores are advisory. A high score moves a payment to REVIEW and stops
-- release, but it never blocks, never seizes and never touches the ledger
-- (SPEC 1415 — the risk engine must not mutate financial state itself). The
-- money is preserved in place; only the release is paused until a human
-- decides.
--
-- DISPUTE: a case with evidence and a hold, NOT an automatic chargeback.
-- CubePay publishes no dispute mechanism, so assuming a reversal exists — or
-- assuming one can never happen because payments are rial — would both be
-- guesses. A dispute therefore parks the money and asks a person.

CREATE SCHEMA IF NOT EXISTS risk;

-- --- risk -------------------------------------------------------------------

CREATE TABLE risk.assessments (
    id              UUID PRIMARY KEY,
    entity_type     TEXT NOT NULL,
    entity_id       UUID NOT NULL,
    merchant_id     UUID REFERENCES core.merchants(id) ON DELETE RESTRICT,

    score           INTEGER NOT NULL,
    level           TEXT NOT NULL,
    decision        TEXT NOT NULL,

    -- Every signal that contributed, with its own weight, so a decision can be
    -- explained to the merchant it affected rather than being a black box.
    signals         JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_risk_score CHECK (score BETWEEN 0 AND 100),
    CONSTRAINT ck_risk_level CHECK (level IN ('LOW','MEDIUM','HIGH')),
    -- ALLOW and MONITOR proceed; REVIEW pauses. There is deliberately no BLOCK:
    -- the engine may not take an irreversible action on its own.
    CONSTRAINT ck_risk_decision CHECK (decision IN ('ALLOW','MONITOR','REVIEW')),
    CONSTRAINT ck_risk_entity CHECK (entity_type IN ('PAYMENT','PAYOUT','MERCHANT','WALLET'))
);

CREATE INDEX ix_risk_entity ON risk.assessments(entity_type, entity_id);
CREATE INDEX ix_risk_merchant ON risk.assessments(merchant_id, created_at);
CREATE INDEX ix_risk_review ON risk.assessments(decision, created_at)
    WHERE decision = 'REVIEW';

-- --- disputes ----------------------------------------------------------------

CREATE TABLE core.disputes (
    id                 UUID PRIMARY KEY,
    payment_id         UUID NOT NULL REFERENCES core.payments(id) ON DELETE RESTRICT,
    merchant_id        UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,

    status             TEXT NOT NULL,
    reason             TEXT NOT NULL,

    -- Evidence accumulates as a list; nothing is ever overwritten.
    evidence           JSONB NOT NULL DEFAULT '[]'::jsonb,

    opened_by_type     TEXT NOT NULL,
    opened_by_id       UUID,
    resolved_by_id     UUID,
    resolution         TEXT,
    resolution_note    TEXT,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at        TIMESTAMPTZ,

    CONSTRAINT ck_dispute_status CHECK (status IN (
        'OPEN','UNDER_REVIEW','HOLD','ESCALATED','RESOLVED','REJECTED','CLOSED')),
    CONSTRAINT ck_dispute_opener CHECK (opened_by_type IN ('MERCHANT','ADMIN','CUSTOMER','SYSTEM')),
    -- A dispute never reverses money by itself; the resolution records what a
    -- human decided, and any actual reversal goes through the refund path.
    CONSTRAINT ck_dispute_resolution CHECK (
        resolution IS NULL OR resolution IN (
            'UPHELD_MERCHANT','UPHELD_CUSTOMER','REFUND_REQUIRED','NO_ACTION')
    ),
    CONSTRAINT ck_dispute_resolved CHECK (
        status NOT IN ('RESOLVED','REJECTED') OR resolution IS NOT NULL
    )
);

CREATE INDEX ix_disputes_payment ON core.disputes(payment_id);
CREATE INDEX ix_disputes_open ON core.disputes(status, created_at)
    WHERE status IN ('OPEN','UNDER_REVIEW','HOLD','ESCALATED');

-- Only one live dispute per payment: two open cases over the same money would
-- make "is this on hold?" unanswerable.
CREATE UNIQUE INDEX ux_disputes_active_payment
    ON core.disputes(payment_id)
    WHERE status IN ('OPEN','UNDER_REVIEW','HOLD','ESCALATED');

-- --- holds --------------------------------------------------------------------
--
-- A hold is the one financial effect risk and disputes are allowed to have, and
-- it is purely a pause: the money stays exactly where it is and simply does not
-- progress. Recorded as its own row so the reason is always attributable.

CREATE TABLE finance.payment_holds (
    id            UUID PRIMARY KEY,
    payment_id    UUID NOT NULL REFERENCES core.payments(id) ON DELETE RESTRICT,
    merchant_id   UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    source        TEXT NOT NULL,
    source_id     UUID,
    reason        TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at   TIMESTAMPTZ,
    released_by   UUID,
    CONSTRAINT ck_hold_source CHECK (source IN ('RISK','DISPUTE','ADMIN','COMPLIANCE')),
    CONSTRAINT ck_hold_status CHECK (status IN ('ACTIVE','RELEASED'))
);

CREATE INDEX ix_holds_payment ON finance.payment_holds(payment_id, status);
CREATE INDEX ix_holds_active ON finance.payment_holds(status, created_at)
    WHERE status = 'ACTIVE';
