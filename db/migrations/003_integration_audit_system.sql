-- 003 — provider integration, audit trail and system plumbing.
-- SPEC 118.30-118.37, 118.47, 118.71-118.75.

-- SPEC 118.30 / 118.31 — inbound provider events, deduplicated.
CREATE TABLE integration.webhook_events (
    id                 UUID PRIMARY KEY,
    provider           TEXT NOT NULL,
    external_event_id  TEXT,
    event_type         TEXT NOT NULL,
    signature_valid    BOOLEAN NOT NULL DEFAULT FALSE,
    raw_payload        JSONB NOT NULL,
    payload_hash       TEXT NOT NULL,
    received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at       TIMESTAMPTZ,
    status             TEXT NOT NULL,
    error_code         TEXT,
    CONSTRAINT ck_webhook_events_status
        CHECK (status IN ('RECEIVED','PROCESSED','REJECTED','DUPLICATE','FAILED'))
);

CREATE UNIQUE INDEX ux_webhook_provider_event
    ON integration.webhook_events(provider, external_event_id)
    WHERE external_event_id IS NOT NULL;
CREATE INDEX ix_webhook_events_status ON integration.webhook_events(status, received_at);

-- Outbound deliveries to merchant endpoints (SPEC 04 · Webhook).
CREATE TABLE integration.webhook_deliveries (
    id            UUID PRIMARY KEY,
    endpoint_id   UUID NOT NULL REFERENCES core.webhook_endpoints(id) ON DELETE RESTRICT,
    merchant_id   UUID NOT NULL REFERENCES core.merchants(id) ON DELETE RESTRICT,
    event_id      UUID NOT NULL,
    event_type    TEXT NOT NULL,
    payload         JSONB NOT NULL,
    payload_hash    TEXT NOT NULL,
    status          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ,
    last_error      TEXT,
    response_status INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at    TIMESTAMPTZ,
    CONSTRAINT ck_deliveries_status
        CHECK (status IN ('PENDING','SENDING','SENT','RETRY','DEAD')),
    CONSTRAINT ck_deliveries_attempts CHECK (attempts >= 0)
);

-- The merchant must be able to process the same event id idempotently, so we
-- must never create two deliveries for the same (endpoint, event).
CREATE UNIQUE INDEX ux_delivery_endpoint_event
    ON integration.webhook_deliveries(endpoint_id, event_id);
CREATE INDEX ix_deliveries_due
    ON integration.webhook_deliveries(status, next_attempt_at)
    WHERE status IN ('PENDING','RETRY');

-- Provider evidence retained verbatim (SPEC 118.69: raw payload is never
-- overwritten or deleted without reason).
CREATE TABLE integration.provider_evidence (
    id           UUID PRIMARY KEY,
    payment_id   UUID REFERENCES core.payments(id) ON DELETE RESTRICT,
    payout_id    UUID REFERENCES finance.payouts(id) ON DELETE RESTRICT,
    provider     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    raw_payload  JSONB NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_evidence_target
        CHECK (num_nonnulls(payment_id, payout_id) = 1)
);

CREATE TRIGGER trg_evidence_immutable
    BEFORE UPDATE OR DELETE ON integration.provider_evidence
    FOR EACH ROW EXECUTE FUNCTION finance.prevent_financial_mutation();

CREATE INDEX ix_evidence_payment ON integration.provider_evidence(payment_id);
CREATE INDEX ix_evidence_payout ON integration.provider_evidence(payout_id);

-- SPEC 118.35 — audit log
CREATE TABLE audit.audit_logs (
    id             UUID PRIMARY KEY,
    actor_type     TEXT NOT NULL,
    actor_id       UUID,
    action         TEXT NOT NULL,
    resource_type  TEXT NOT NULL,
    resource_id    UUID,
    reason         TEXT,
    metadata       JSONB,
    ip_address     INET,
    user_agent     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_audit_actor_type
        CHECK (actor_type IN ('SYSTEM','MERCHANT','ADMIN','CUSTOMER','WORKER','PROVIDER'))
);

CREATE TRIGGER trg_audit_immutable
    BEFORE UPDATE OR DELETE ON audit.audit_logs
    FOR EACH ROW EXECUTE FUNCTION finance.prevent_financial_mutation();

CREATE INDEX ix_audit_resource ON audit.audit_logs(resource_type, resource_id);
CREATE INDEX ix_audit_created ON audit.audit_logs(created_at);

-- SPEC 118.36 — security events
CREATE TABLE audit.security_events (
    id          UUID PRIMARY KEY,
    event_type  TEXT NOT NULL,
    severity    TEXT NOT NULL,
    actor_id    UUID,
    ip_address  INET,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_security_severity CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL'))
);

CREATE INDEX ix_security_events_type ON audit.security_events(event_type, created_at);

-- SPEC 118.32 / 118.33 — transactional outbox
CREATE TABLE system.outbox_events (
    id              UUID PRIMARY KEY,
    event_type      TEXT NOT NULL,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    UUID NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    available_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at       TIMESTAMPTZ,
    last_error      TEXT,
    processed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_outbox_status
        CHECK (status IN ('PENDING','PROCESSING','SENT','RETRY','DEAD')),
    CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0)
);

CREATE INDEX ix_outbox_pending
    ON system.outbox_events(status, available_at)
    WHERE status IN ('PENDING','RETRY');
-- SPEC 118.75 — stuck PROCESSING rows must be recoverable.
CREATE INDEX ix_outbox_stuck
    ON system.outbox_events(status, locked_at)
    WHERE status = 'PROCESSING';

-- SPEC 118.34 / 118.71 / 118.72 — idempotency keys
CREATE TABLE system.idempotency_keys (
    id               UUID PRIMARY KEY,
    namespace        TEXT NOT NULL,
    key              TEXT NOT NULL,
    request_hash     TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    response_status  INTEGER,
    response_body    JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ,
    UNIQUE (namespace, key),
    CONSTRAINT ck_idempotency_state CHECK (state IN ('IN_PROGRESS','COMPLETED','FAILED'))
);

CREATE INDEX ix_idempotency_expiry ON system.idempotency_keys(expires_at);

-- SPEC 25 — HMAC nonce replay protection
CREATE TABLE system.request_nonces (
    nonce       TEXT PRIMARY KEY,
    scope       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX ix_nonces_expiry ON system.request_nonces(expires_at);

-- SPEC 118.47 / 118.48 — append-only state transition log
CREATE TABLE system.state_transitions (
    id           UUID PRIMARY KEY,
    entity_type  TEXT NOT NULL,
    entity_id    UUID NOT NULL,
    from_state   TEXT,
    event        TEXT NOT NULL,
    to_state     TEXT NOT NULL,
    actor_type   TEXT,
    actor_id     UUID,
    metadata     JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_transitions_immutable
    BEFORE UPDATE OR DELETE ON system.state_transitions
    FOR EACH ROW EXECUTE FUNCTION finance.prevent_financial_mutation();

CREATE INDEX ix_transitions_entity ON system.state_transitions(entity_type, entity_id, created_at);

-- Reconciliation exceptions (SPEC 119.56 / 119.57)
CREATE TABLE system.reconciliation_exceptions (
    id           UUID PRIMARY KEY,
    kind         TEXT NOT NULL,
    severity     TEXT NOT NULL,
    entity_type  TEXT NOT NULL,
    entity_id    UUID,
    details      JSONB NOT NULL,
    status       TEXT NOT NULL DEFAULT 'OPEN',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at  TIMESTAMPTZ,
    CONSTRAINT ck_recon_kind CHECK (kind IN (
        'AMOUNT_MISMATCH','MISSING_PROVIDER','MISSING_INTERNAL',
        'MISSING_CHAIN','DUPLICATE','UNKNOWN','STATE_MISMATCH','LEDGER_IMBALANCE')),
    CONSTRAINT ck_recon_severity CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    CONSTRAINT ck_recon_status CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED'))
);

CREATE INDEX ix_recon_open ON system.reconciliation_exceptions(status, severity)
    WHERE status <> 'RESOLVED';

-- Migration bookkeeping is created by the migrator itself before any migration
-- runs (packages/database/src/migrator.ts), so it is intentionally not defined
-- here.
