-- 014_ton_seqno_reservation.sql
-- Persistent atomic sequence reservation for TON wallet payouts.
-- Guarantees strictly increasing seqno allocation across concurrent workers
-- and prevents duplicate seqno collision (TON contract exit code 33).

CREATE TABLE IF NOT EXISTS finance.treasury_wallet_sequences (
    address VARCHAR(128) PRIMARY KEY,
    current_onchain_seqno INT NOT NULL DEFAULT 0,
    next_allocated_seqno INT NOT NULL DEFAULT 0,
    confirmed_seqno INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance.payout_seqno_allocations (
    id UUID PRIMARY KEY,
    payout_id UUID NOT NULL REFERENCES finance.payouts(id) ON DELETE RESTRICT,
    treasury_address VARCHAR(128) NOT NULL,
    allocated_seqno INT NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('RESERVED', 'BROADCASTED', 'CONFIRMED', 'EXPIRED', 'FAILED')),
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    CONSTRAINT ux_seqno_per_wallet UNIQUE (treasury_address, allocated_seqno),
    CONSTRAINT ux_seqno_per_payout UNIQUE (payout_id)
);

CREATE INDEX IF NOT EXISTS ix_seqno_allocations_wallet_status ON finance.payout_seqno_allocations (treasury_address, status);
