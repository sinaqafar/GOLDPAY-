-- 004: platform administration.
--
-- SPEC 117: eight roles — SUPER_ADMIN, FINANCE_ADMIN, OPERATIONS_ADMIN,
-- SUPPORT_AGENT, RISK_AGENT, DEVELOPER_SUPPORT, READ_ONLY, MERCHANT.
--
-- Admins are a separate identity from merchants on purpose: a merchant account
-- must never be able to acquire platform privileges by escalation.

CREATE TABLE core.admin_users (
    id              UUID PRIMARY KEY,
    telegram_user_id BIGINT UNIQUE,
    email           TEXT UNIQUE,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ACTIVE',
    -- Secrets are never stored in the clear (SPEC 118).
    secret_hash     TEXT,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_admin_role CHECK (role IN (
        'SUPER_ADMIN','FINANCE_ADMIN','OPERATIONS_ADMIN','SUPPORT_AGENT',
        'RISK_AGENT','DEVELOPER_SUPPORT','READ_ONLY')),
    CONSTRAINT ck_admin_status CHECK (status IN ('ACTIVE','SUSPENDED','DISABLED')),
    -- An admin must be reachable by at least one identity.
    CONSTRAINT ck_admin_identity CHECK (telegram_user_id IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX ix_admin_users_role ON core.admin_users(role) WHERE status = 'ACTIVE';

-- Four-eyes approvals for dangerous operations.
--
-- SPEC 119: manual treasury funding and financial freezes must be traceable to
-- a named human. A request records WHO asked; the approval records WHO agreed.
CREATE TABLE core.admin_approvals (
    id             UUID PRIMARY KEY,
    operation      TEXT NOT NULL,
    payload        JSONB NOT NULL,
    requested_by   UUID NOT NULL REFERENCES core.admin_users(id) ON DELETE RESTRICT,
    approved_by    UUID REFERENCES core.admin_users(id) ON DELETE RESTRICT,
    status         TEXT NOT NULL DEFAULT 'PENDING',
    reason         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at     TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_approval_status CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','EXECUTED')),
    -- The requester may not be the approver: that is the entire point.
    CONSTRAINT ck_approval_four_eyes CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

CREATE INDEX ix_admin_approvals_pending ON core.admin_approvals(status, created_at)
    WHERE status = 'PENDING';

-- A single-row switch that halts all financial movement.
--
-- SPEC 119.58: a ledger imbalance is CRITICAL and must be able to stop the
-- system. The worker consults this before advancing any payout.
CREATE TABLE system.platform_state (
    id                 BOOLEAN PRIMARY KEY DEFAULT TRUE,
    financial_freeze   BOOLEAN NOT NULL DEFAULT FALSE,
    freeze_reason      TEXT,
    frozen_by          UUID REFERENCES core.admin_users(id) ON DELETE RESTRICT,
    frozen_at          TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_platform_state_singleton CHECK (id = TRUE),
    -- A freeze without a recorded reason is not auditable.
    CONSTRAINT ck_freeze_has_reason CHECK (
        financial_freeze = FALSE OR (freeze_reason IS NOT NULL AND frozen_at IS NOT NULL))
);

INSERT INTO system.platform_state (id, financial_freeze) VALUES (TRUE, FALSE);

-- Admin sessions, so a lost device can be revoked without rotating the role.
CREATE TABLE core.admin_sessions (
    id            UUID PRIMARY KEY,
    admin_id      UUID NOT NULL REFERENCES core.admin_users(id) ON DELETE RESTRICT,
    token_hash    TEXT NOT NULL UNIQUE,
    ip_address    INET,
    user_agent    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX ix_admin_sessions_live ON core.admin_sessions(admin_id)
    WHERE revoked_at IS NULL;
