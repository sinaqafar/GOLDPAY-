/**
 * PollPendingInvoicesUseCase — Independent Status Polling & Recovery for Invoices.
 *
 * SPEC v3.3:
 * - Provider-Creation Recovery (P1.4): Retries failed provider checkout creations using the SAME invoice ID.
 * - Expiry Reconciliation Ordering (P1.8): Never marks EXPIRED solely on local clock without first verifying provider status.
 * - Resolves matching provider mode per invoice's immutable snapshot.
 * - Finalizes double-entry ledger atomically with full structured evidence.
 */

import type { Database } from '../../../database/src/client.ts';
import type { Config } from '../../../config/src/index.ts';
import type { CubePayProviderResolver } from '../../../cubepay/src/resolver.ts';
import { finalizePayment, type FinalizePaymentResult } from './finalize-payment.ts';

export interface PollPendingInvoicesResult {
  polled: number;
  verified: number;
  recovered: number;
  expired: number;
  failed: number;
  skipped: number;
  errors: number;
}

export async function pollPendingInvoices(
  db: Database,
  config: Config,
  resolver: CubePayProviderResolver,
  options: { limit?: number; now?: Date } = {},
): Promise<PollPendingInvoicesResult> {
  const limit = options.limit ?? 50;
  const now = options.now ?? new Date();

  // 1. Recover uncreated provider invoices (P1.4)
  const uncreated = await db.query<{
    id: string;
    merchant_id: string;
    customer_total_amount: string;
    description: string | null;
    provider_mode: string | null;
    provider_create_attempts: number;
  }>(
    `SELECT id, merchant_id, customer_total_amount::text, description,
            provider_mode, provider_create_attempts
       FROM core.invoices
      WHERE status = 'CREATED'
        AND provider_invoice_id IS NULL
        AND provider_create_attempts < 5
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  let recoveredCount = 0;
  for (const inv of uncreated.rows) {
    try {
      const adapter = resolver.resolveForInvoice({ providerMode: inv.provider_mode });
      const provInv = await adapter.createInvoice({
        internalInvoiceId: inv.id,
        amount: inv.customer_total_amount,
        description: inv.description ?? undefined,
        callbackUrl: `${config.app.appUrl}/v1/webhooks/cubepay`,
      });

      await db.query(
        `UPDATE core.invoices
            SET provider_invoice_id = $2,
                provider_payment_url = $3,
                provider_order_id = $4,
                provider_pay_amount_rial = $5,
                provider_pay_amount_toman = $6,
                provider_ttl_minutes = $7,
                redirect_after_payment = $8,
                provider_create_status = 'PROVIDER_CREATED',
                updated_at = NOW()
          WHERE id = $1`,
        [
          inv.id,
          provInv.externalInvoiceId,
          provInv.paymentUrl,
          inv.id,
          provInv.providerPayAmountRial ?? null,
          provInv.providerPayAmountToman ?? null,
          provInv.providerTtlMinutes ?? null,
          provInv.redirectAfterPayment ?? true,
        ],
      );
      recoveredCount++;
    } catch (e) {
      await db.query(
        `UPDATE core.invoices
            SET provider_create_attempts = provider_create_attempts + 1,
                last_provider_error = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [inv.id, e instanceof Error ? e.message : String(e)],
      ).catch(() => undefined);
    }
  }

  // 2. Poll pending provider invoices (P1.8)
  const res = await db.query<{
    id: string;
    merchant_id: string;
    status: string;
    expires_at: string | null;
    provider_mode: string | null;
    provider_invoice_id: string | null;
    created_at: string;
  }>(
    `SELECT id, merchant_id, status, expires_at,
            provider_mode, provider_invoice_id, created_at
       FROM core.invoices
      WHERE status = 'CREATED'
        AND provider_invoice_id IS NOT NULL
        AND created_at > NOW() - INTERVAL '48 hours'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  let verifiedCount = 0;
  let expiredCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const inv of res.rows) {
    if (!inv.provider_invoice_id) {
      skippedCount++;
      continue;
    }

    try {
      // Resolve adapter matching the invoice's immutable mode snapshot
      const adapter = resolver.resolveForInvoice({ providerMode: inv.provider_mode });

      // CRITICAL (P1.8): Verify provider status FIRST before evaluating local expiry
      const status = await adapter.verifyPayment(inv.provider_invoice_id);

      if (status.status === 'PAID') {
        const finRes: FinalizePaymentResult = await finalizePayment(db, config, {
          invoiceId: inv.id,
          evidence: {
            provider: adapter.name,
            externalPaymentId: status.externalPaymentId,
            paidAmount: status.paidAmount ?? '0',
            paidAmountRial: status.paidAmountRial,
            orderId: status.orderId ?? inv.id,
            matchConfidence: status.matchConfidence,
            matchFlags: status.matchFlags,
            providerFeeAmount: status.providerFeeAmount,
            status: 'PAID',
            paidAt: status.paidAt ?? now.toISOString(),
            raw: status.raw,
          },
        });

        if (finRes.credited) {
          verifiedCount++;
        }
      } else if (status.status === 'FAILED') {
        await finalizePayment(db, config, {
          invoiceId: inv.id,
          evidence: {
            provider: adapter.name,
            externalPaymentId: status.externalPaymentId,
            paidAmount: '0',
            status: 'FAILED',
            paidAt: now.toISOString(),
            raw: status.raw,
          },
        });
        failedCount++;
      } else {
        // Status is PENDING or UNKNOWN: Check if local expiry + 5 minute grace window has elapsed
        const graceWindowMs = 5 * 60 * 1000;
        const expiryTime = inv.expires_at ? new Date(inv.expires_at).getTime() : null;

        if (expiryTime && now.getTime() > expiryTime + graceWindowMs) {
          const expRes = await db.query(
            `UPDATE core.invoices
                SET status = 'EXPIRED', updated_at = NOW()
              WHERE id = $1 AND status = 'CREATED'`,
            [inv.id],
          );
          if (expRes.rowCount === 1) {
            expiredCount++;
          }
        } else {
          skippedCount++;
        }
      }
    } catch {
      errorCount++;
    }
  }

  return {
    polled: res.rows.length,
    verified: verifiedCount,
    recovered: recoveredCount,
    expired: expiredCount,
    failed: failedCount,
    skipped: skippedCount,
    errors: errorCount,
  };
}
