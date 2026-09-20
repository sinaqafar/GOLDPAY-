-- 017_cubepay_dual_mode_invoice_snapshot.sql
-- Snapshotting provider mode (VIP / STANDARD) and exact provider payable amounts onto invoices for immutable lifecycle routing.

ALTER TABLE core.invoices
    ADD COLUMN IF NOT EXISTS provider VARCHAR(32) NOT NULL DEFAULT 'CUBEPAY',
    ADD COLUMN IF NOT EXISTS provider_mode VARCHAR(32) NOT NULL DEFAULT 'VIP',
    ADD COLUMN IF NOT EXISTS provider_version VARCHAR(32) NOT NULL DEFAULT '2026-09-VIP',
    ADD COLUMN IF NOT EXISTS provider_config_ref VARCHAR(64),
    ADD COLUMN IF NOT EXISTS provider_order_id TEXT,
    ADD COLUMN IF NOT EXISTS provider_pay_amount_rial NUMERIC(30,0),
    ADD COLUMN IF NOT EXISTS provider_pay_amount_toman NUMERIC(30,0),
    ADD COLUMN IF NOT EXISTS provider_ttl_minutes INTEGER,
    ADD COLUMN IF NOT EXISTS redirect_after_payment BOOLEAN DEFAULT TRUE;

ALTER TABLE core.invoices DROP CONSTRAINT IF EXISTS ck_invoices_provider_mode;
ALTER TABLE core.invoices
    ADD CONSTRAINT ck_invoices_provider_mode CHECK (provider_mode IN ('VIP', 'STANDARD'));

CREATE INDEX IF NOT EXISTS ix_invoices_provider_mode ON core.invoices(provider, provider_mode);
CREATE INDEX IF NOT EXISTS ix_invoices_provider_order_id ON core.invoices(provider_order_id);

