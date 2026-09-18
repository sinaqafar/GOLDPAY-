-- 009 — Support tickets (SPEC 2453/2454).
--
-- A Telegram conversation is good for reaching someone quickly and terrible as
-- a record: it has no status, no owner, no link to the payment being disputed,
-- and it scrolls away. The bot stays as the fastest way to OPEN a ticket; this
-- is where the ticket then lives.
--
-- The link to a financial entity is the point. When a merchant says "my payout
-- never arrived", support needs to reach the payout, its transaction hash and
-- its ledger entries — while being unable to change any of them.

CREATE TABLE core.support_tickets (
    id              UUID PRIMARY KEY,
    merchant_id     UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,

    -- Short human-quotable reference, e.g. TKT-000123.
    reference       TEXT NOT NULL UNIQUE,
    subject         TEXT NOT NULL,
    category        TEXT NOT NULL,
    priority        TEXT NOT NULL DEFAULT 'NORMAL',
    status          TEXT NOT NULL DEFAULT 'OPEN',

    -- Optional link to the thing being asked about. Kept as a loose reference
    -- rather than a foreign key so a ticket can survive a record it names.
    entity_type     TEXT,
    entity_id       UUID,

    opened_by_type  TEXT NOT NULL,
    opened_by_id    UUID,
    assigned_to     UUID REFERENCES core.admin_users(id) ON DELETE RESTRICT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    first_replied_at TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,

    CONSTRAINT ck_ticket_status CHECK (status IN (
        'OPEN','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL','RESOLVED','CLOSED')),
    CONSTRAINT ck_ticket_priority CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    CONSTRAINT ck_ticket_category CHECK (category IN (
        'PAYMENT','PAYOUT','WALLET','REFUND','API','WEBHOOK',
        'INTEGRATION','ACCOUNT','SECURITY','OTHER')),
    CONSTRAINT ck_ticket_opener CHECK (opened_by_type IN ('MERCHANT','ADMIN','SYSTEM')),
    CONSTRAINT ck_ticket_entity CHECK (
        entity_type IS NULL
        OR entity_type IN ('PAYMENT','PAYOUT','INVOICE','WALLET','REFUND','DISPUTE')
    ),
    CONSTRAINT ck_ticket_subject CHECK (length(btrim(subject)) BETWEEN 1 AND 200)
);

CREATE INDEX ix_tickets_merchant ON core.support_tickets(merchant_id, created_at DESC);
CREATE INDEX ix_tickets_queue ON core.support_tickets(status, priority, created_at)
    WHERE status IN ('OPEN','IN_PROGRESS','WAITING_INTERNAL');
CREATE INDEX ix_tickets_entity ON core.support_tickets(entity_type, entity_id)
    WHERE entity_id IS NOT NULL;

-- Sequential, readable ticket references.
CREATE SEQUENCE core.support_ticket_seq START 1;

CREATE TABLE core.support_messages (
    id            UUID PRIMARY KEY,
    ticket_id     UUID NOT NULL REFERENCES core.support_tickets(id) ON DELETE RESTRICT,

    sender_type   TEXT NOT NULL,
    sender_id     UUID,
    body          TEXT NOT NULL,

    -- An internal note is visible to staff only. Enforced by the query layer,
    -- and flagged here so a leak is a visible bug rather than a silent one.
    internal      BOOLEAN NOT NULL DEFAULT FALSE,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_message_sender CHECK (sender_type IN ('MERCHANT','ADMIN','SYSTEM')),
    CONSTRAINT ck_message_body CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
    -- Only staff can write an internal note; a merchant message is never hidden
    -- from the merchant who wrote it.
    CONSTRAINT ck_message_internal_by_staff CHECK (
        internal = FALSE OR sender_type IN ('ADMIN','SYSTEM')
    )
);

CREATE INDEX ix_messages_ticket ON core.support_messages(ticket_id, created_at);

-- Support messages are part of the record of a financial dispute, so they are
-- append-only like everything else that could be evidence.
CREATE OR REPLACE FUNCTION core.prevent_support_message_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'support messages are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_support_messages_immutable
    BEFORE UPDATE OR DELETE ON core.support_messages
    FOR EACH ROW EXECUTE FUNCTION core.prevent_support_message_mutation();
