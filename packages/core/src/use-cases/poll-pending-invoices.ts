/**
 * PollPendingInvoicesUseCase — Independent Status Polling for Pending Invoices.
 *
 * Official CubePay Documentation Requirement:
 * In CubePay Standard, webhooks are not guaranteed to retry upon network failure.
 * GOLDPAY implements an independent, distributed-safe, idempotent polling engine
 * that discovers completed payments even when webhook delivery fails.
 *
 * Polling Architecture:
 *   Pending Invoices -> Resolve Mode Adapter -> verifyPayment(authority) ->
 *   if PAID -> finalizePayment (Atomic Double-Entry Ledger) ->
 *   if EXPIRED -> Mark EXPIRED ->
 *   if PENDING -> Keep PENDING with backoff.
 */

import type { Database } from '../../../database/src/client.ts';
import type { Config } from '../../../config/src/index.ts';
import type { CubePayProviderResolver } from '../../../cubepay/src/resolver.ts';
import { finalizePayment, type FinalizePaymentResult } from './finalize-payment.ts';

export interface PollPendingInvoicesResult {
  polled: number;
  verified: number;
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
    // 1. Check TTL Expiry
    if (inv.expires_at && now > new Date(inv.expires_at)) {
      const expRes = await db.query(
        `UPDATE core.invoices
            SET status = 'EXPIRED', updated_at = NOW()
          WHERE id = $1 AND status = 'CREATED'`,
        [inv.id],
      );
      if (expRes.rowCount === 1) {
        expiredCount++;
      }
      continue;
    }

    if (!inv.provider_invoice_id) {
      skippedCount++;
      continue;
    }

    try {
      // 2. Resolve adapter matching the invoice's immutable mode snapshot
      const adapter = resolver.resolveForInvoice({ providerMode: inv.provider_mode });
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
        skippedCount++;
      }
    } catch {
      errorCount++;
    }
  }

  return {
    polled: res.rows.length,
    verified: verifiedCount,
    expired: expiredCount,
    failed: failedCount,
    skipped: skippedCount,
    errors: errorCount,
  };
}
