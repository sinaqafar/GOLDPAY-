-- 001 — schemas, extensions and core tenant tables.
-- SPEC 118.3: core / finance / integration / audit / system.
-- SPEC 118.4: UUID primary keys; internal ids are never the external ids.

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS finance;
CREATE SCHEMA IF NOT EXISTS integration;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS system;

-- SPEC 118.5 — Users
CREATE TABLE core.users (
    id                UUID PRIMARY KEY,
    telegram_user_id  BIGINT UNIQUE,
    username          TEXT,
    first_name        TEXT,
    last_name         TEXT,
    status            TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE','SUSPENDED','BLOCKED'))
);

-- SPEC 118.6 / 118.7 — Merchants
CREATE TABLE core.merchants (
    id                UUID PRIMARY KEY,
    user_id           UUID NOT NULL REFERENCES core.users(id) ON DELETE RESTRICT,
    name              TEXT NOT NULL,
    status            TEXT NOT NULL,
    default_fee_mode  TEXT NOT NULL,
    auto_payout       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_merchants_status
        CHECK (status IN ('PENDING','REVIEW','ACTIVE','SUSPENDED','BLOCKED','CLOSED')),
    CONSTRAINT ck_merchants_fee_mode
        CHECK (default_fee_mode IN ('CUSTOMER','MERCHANT','SPLIT')),
    CONSTRAINT ck_merchants_name CHECK (length(btrim(name)) BETWEEN 1 AND 200)
);

-- SPEC 118.8 — Multi-admin merchants
CREATE TABLE core.merchant_users (
    merchant_id  UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    user_id      UUID NOT NULL REFERENCES core.users(id) ON DELETE RESTRICT,
    role         TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (merchant_id, user_id),
    CONSTRAINT ck_merchant_users_role CHECK (role IN ('OWNER','ADMIN','VIEWER'))
);

-- SPEC 118.9 / 118.10 — Payout wallets
CREATE TABLE core.wallets (
    id           UUID PRIMARY KEY,
    merchant_id  UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    network      TEXT NOT NULL,
    asset        TEXT NOT NULL,
    address      TEXT NOT NULL,
    status       TEXT NOT NULL,
    -- SPEC: a newly registered wallet sits in SECURITY_HOLD before it can receive funds.
    hold_until   TIMESTAMPTZ,
    verified_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_wallets_status
        CHECK (status IN ('PENDING','SECURITY_HOLD','ACTIVE','DISABLED','REVOKED')),
    CONSTRAINT ck_wallets_address CHECK (length(btrim(address)) > 0)
);

CREATE UNIQUE INDEX ux_wallet_network_asset_address
    ON core.wallets(network, asset, address);

-- Only one usable payout wallet per merchant at a time.
CREATE UNIQUE INDEX ux_wallet_merchant_active
    ON core.wallets(merchant_id)
    WHERE status = 'ACTIVE';

CREATE INDEX ix_wallets_merchant ON core.wallets(merchant_id);

-- SPEC 118.11 / 118.12 — Invoices carry an immutable fee snapshot.
CREATE TABLE core.invoices (
    id                     UUID PRIMARY KEY,
    merchant_id            UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    invoice_number         TEXT NOT NULL,

    base_amount            NUMERIC(30,0) NOT NULL,
    base_currency          TEXT NOT NULL,

    fee_mode               TEXT NOT NULL,
    fee_rate_bps           NUMERIC(10,0) NOT NULL,
    fee_policy_version     TEXT NOT NULL,
    platform_fee_amount    NUMERIC(30,0) NOT NULL,
    customer_fee_share     NUMERIC(30,0) NOT NULL,
    merchant_fee_share     NUMERIC(30,0) NOT NULL,
    customer_total_amount  NUMERIC(30,0) NOT NULL,
    merchant_net_amount    NUMERIC(30,0) NOT NULL,

    description            TEXT,
    customer_reference     TEXT,

    -- Provider checkout, attached after the invoice row exists (no HTTP inside
    -- the financial transaction).
    provider_invoice_id    TEXT,
    provider_payment_url   TEXT,

    status                 TEXT NOT NULL,
    expires_at             TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (merchant_id, invoice_number),

    CONSTRAINT ck_invoices_currency CHECK (base_currency = 'TOMAN'),
    CONSTRAINT ck_invoices_status
        CHECK (status IN ('CREATED','PAID','EXPIRED','CANCELLED','REFUNDED')),
    CONSTRAINT ck_invoices_fee_mode CHECK (fee_mode IN ('CUSTOMER','MERCHANT','SPLIT')),
    CONSTRAINT ck_invoices_base_positive CHECK (base_amount > 0),
    CONSTRAINT ck_invoices_fee_nonneg CHECK (platform_fee_amount >= 0),
    CONSTRAINT ck_invoices_shares_nonneg
        CHECK (customer_fee_share >= 0 AND merchant_fee_share >= 0),
    CONSTRAINT ck_invoices_total_nonneg CHECK (customer_total_amount >= 0),
    CONSTRAINT ck_invoices_net_nonneg CHECK (merchant_net_amount >= 0),
    -- The database itself enforces the fee conservation identity (SPEC 103926:
    -- the database must protect the system even if application code has a bug).
    CONSTRAINT ck_invoices_fee_split
        CHECK (platform_fee_amount = customer_fee_share + merchant_fee_share),
    CONSTRAINT ck_invoices_customer_total
        CHECK (customer_total_amount = base_amount + customer_fee_share),
    CONSTRAINT ck_invoices_merchant_net
        CHECK (merchant_net_amount = base_amount - merchant_fee_share),
    CONSTRAINT ck_invoices_conservation
        CHECK (customer_total_amount - platform_fee_amount = merchant_net_amount)
);

CREATE INDEX ix_invoices_merchant ON core.invoices(merchant_id);
CREATE INDEX ix_invoices_status_expiry ON core.invoices(status, expires_at)
    WHERE status = 'CREATED';

-- SPEC 118.13 — Payments
CREATE TABLE core.payments (
    id                   UUID PRIMARY KEY,
    invoice_id           UUID NOT NULL REFERENCES core.invoices(id) ON DELETE RESTRICT,
    merchant_id          UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,

    provider             TEXT NOT NULL,
    external_payment_id  TEXT,

    expected_amount      NUMERIC(30,0) NOT NULL,
    verified_amount      NUMERIC(30,0),
    currency             TEXT NOT NULL,

    status               TEXT NOT NULL,

    verified_paid_at     TIMESTAMPTZ,
    release_at           TIMESTAMPTZ,
    released_at          TIMESTAMPTZ,
    finalized_at         TIMESTAMPTZ,

    mismatch_code        TEXT,
    failure_code         TEXT,

    refunded_amount      NUMERIC(30,0) NOT NULL DEFAULT 0,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_payments_currency CHECK (currency = 'TOMAN'),
    CONSTRAINT ck_payments_status CHECK (status IN (
        'INITIATED','PENDING_PROVIDER','VERIFIED','RELEASED',
        'MISMATCH','FAILED','REFUNDED','UNKNOWN')),
    CONSTRAINT ck_payments_expected_positive CHECK (expected_amount > 0),
    CONSTRAINT ck_payments_verified_nonneg CHECK (verified_amount IS NULL OR verified_amount >= 0),
    CONSTRAINT ck_payments_refunded_nonneg CHECK (refunded_amount >= 0),
    -- SPEC 119.32: total refunds can never exceed what was actually collected.
    CONSTRAINT ck_payments_refund_bound
        CHECK (verified_amount IS NULL OR refunded_amount <= verified_amount),
    -- A payment can only be VERIFIED/RELEASED with real evidence attached.
    CONSTRAINT ck_payments_verified_evidence CHECK (
        status NOT IN ('VERIFIED','RELEASED')
        OR (verified_amount IS NOT NULL AND verified_paid_at IS NOT NULL)
    ),
    -- SPEC 1251/1252: release_at is derived from verified_paid_at + hold.
    CONSTRAINT ck_payments_release_after_verify
        CHECK (release_at IS NULL OR verified_paid_at IS NULL OR release_at >= verified_paid_at)
);

-- SPEC 118.14 — the single most important duplicate-payment guard.
CREATE UNIQUE INDEX ux_payment_external_provider
    ON core.payments(provider, external_payment_id)
    WHERE external_payment_id IS NOT NULL;

-- One payment per invoice may hold economic value at a time.
CREATE UNIQUE INDEX ux_payment_invoice_settled
    ON core.payments(invoice_id)
    WHERE status IN ('VERIFIED','RELEASED','REFUNDED');

-- SPEC 118.15 / 118.41
CREATE INDEX ix_payment_release_candidates
    ON core.payments(status, release_at)
    WHERE status = 'VERIFIED';
CREATE INDEX ix_payments_merchant_status ON core.payments(merchant_id, status);
CREATE INDEX ix_payments_invoice ON core.payments(invoice_id);

-- SPEC 118.38 / 118.39 — API keys store only a hash.
CREATE TABLE core.api_keys (
    id            UUID PRIMARY KEY,
    merchant_id   UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    name          TEXT NOT NULL,
    key_prefix    TEXT NOT NULL UNIQUE,
    secret_hash   TEXT NOT NULL,
    status        TEXT NOT NULL,
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at    TIMESTAMPTZ,
    CONSTRAINT ck_api_keys_status CHECK (status IN ('ACTIVE','REVOKED'))
);

CREATE INDEX ix_api_keys_merchant ON core.api_keys(merchant_id);

-- SPEC 118.40 — merchant webhook endpoints (secret stored by reference).
CREATE TABLE core.webhook_endpoints (
    id                UUID PRIMARY KEY,
    merchant_id       UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    url               TEXT NOT NULL,
    secret_reference  TEXT NOT NULL,
    -- NULL means "every merchant-visible event"; otherwise an explicit allow-list.
    event_types       TEXT[],
    description       TEXT,
    status            TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_webhook_endpoints_status CHECK (status IN ('ACTIVE','DISABLED')),
    -- SPEC: only https destinations are ever accepted.
    CONSTRAINT ck_webhook_endpoints_https CHECK (url LIKE 'https://%')
);

CREATE INDEX ix_webhook_endpoints_merchant ON core.webhook_endpoints(merchant_id);

-- SPEC 03: bot conversation state is persisted, never held in process memory,
-- so a restart or a second bot instance cannot lose or corrupt it.
CREATE TABLE core.bot_conversations (
    user_id     UUID PRIMARY KEY REFERENCES core.users(id) ON DELETE RESTRICT,
    state       TEXT NOT NULL,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_bot_conversations_expiry ON core.bot_conversations(expires_at);
