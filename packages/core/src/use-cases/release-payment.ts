/**
 * ReleasePaymentUseCase — SPEC 117.50.
 *
 * Order (103797-103804):
 *   Find eligible payment -> Lock -> Validate 48h -> Validate holds ->
 *   PENDING -> AVAILABLE -> post ledger transition -> event -> commit
 *
 * SPEC 104028: the economic owner does not change; only the liability bucket
 * moves, so the journal debits PENDING and credits AVAILABLE on the SAME account.
 * SPEC 124.168: NO ELIGIBILITY -> NO RELEASE.
 */

import type { Database } from '../../../database/src/client.ts';
import { Money } from '../../../money/src/index.ts';
import { post } from '../../../ledger/src/ledger-service.ts';
import { getOrCreateMerchantAccount } from '../../../ledger/src/accounts.ts';
import { enqueue } from '../outbox.ts';
import { recordTransition } from '../transitions.ts';
import { ErrorCodes, FinancialError } from '../../../errors/src/index.ts';
import { hasActiveHold } from '../risk.ts';

export interface ReleaseResult {
  released: number;
  paymentIds: string[];
  merchantIds: string[];
}

/**
 * Release every payment whose 48h hold has elapsed.
 *
 * `FOR UPDATE SKIP LOCKED` lets multiple release workers run concurrently
 * (SPEC 118.55/118.56) while the guarded UPDATE guarantees a payment is
 * released at most once.
 */
export async function releaseEligiblePayments(
  db: Database,
  options: { limit?: number; now?: Date } = {},
): Promise<ReleaseResult> {
  const limit = options.limit ?? 100;
  const paymentIds: string[] = [];
  const merchantIds = new Set<string>();

  // Each payment is released in its own transaction so one bad row cannot block
  // the whole batch.
  const candidates = await db.query<{ id: string }>(
    `SELECT id FROM core.payments
      WHERE status = 'VERIFIED'
        AND release_at IS NOT NULL
        AND release_at <= $2
      ORDER BY release_at ASC
      LIMIT $1`,
    [limit, (options.now ?? new Date()).toISOString()],
  );

  for (const candidate of candidates.rows) {
    const result = await releaseOne(db, candidate.id, options.now);
    if (result) {
      paymentIds.push(result.paymentId);
      merchantIds.add(result.merchantId);
    }
  }

  return { released: paymentIds.length, paymentIds, merchantIds: [...merchantIds] };
}

export async function releaseOne(
  db: Database,
  paymentId: string,
  now?: Date,
): Promise<{ paymentId: string; merchantId: string; amount: string } | null> {
  return db.transaction(
    async (tx) => {
      const r = await tx.query<{
        id: string;
        merchant_id: string;
        invoice_id: string;
        status: string;
        release_at: string | null;
        verified_paid_at: string | null;
      }>(
        `SELECT id, merchant_id, invoice_id, status, release_at, verified_paid_at
           FROM core.payments
          WHERE id = $1
          FOR UPDATE SKIP LOCKED`,
        [paymentId],
      );
      const payment = r.rows[0];
      // Locked by another worker, or already handled.
      if (!payment || payment.status !== 'VERIFIED') return null;

      // Re-validate eligibility inside the transaction (SPEC 103952).
      const nowTs = now ?? new Date();
      if (!payment.release_at || new Date(payment.release_at) > nowTs) {
        return null;
      }

      // The merchant must still be in good standing to have funds released.
      const merchantRes = await tx.query<{ status: string }>(
        'SELECT status FROM core.merchants WHERE id = $1',
        [payment.merchant_id],
      );
      const merchantStatus = merchantRes.rows[0]?.status;
      if (merchantStatus !== 'ACTIVE') {
        // Not an error: the payment simply stays PENDING until the hold clears.
        return null;
      }

      // SPEC 117.50 — validate holds. A risk review or an open dispute pauses
      // release without touching the money: the balance stays exactly where it
      // is, in PENDING, until a human lifts the hold.
      if (await hasActiveHold(tx, paymentId)) {
        return null;
      }

      // The releasable amount is exactly what was credited to PENDING for this payment.
      const amountRes = await tx.query<{ amount: string }>(
        `SELECT COALESCE(SUM(e.credit - e.debit),0)::text AS amount
           FROM finance.journal_entries e
           JOIN finance.journals j ON j.id = e.journal_id
          WHERE j.reference_type = 'PAYMENT'
            AND j.reference_id = $1
            AND e.bucket = 'PENDING'`,
        [paymentId],
      );
      const amount = Money.toman(amountRes.rows[0]?.amount ?? '0');
      if (!amount.isPositive()) {
        throw new FinancialError(
          'RELEASE_NOTHING_PENDING',
          'payment has no pending balance to release',
          { paymentId },
        );
      }

      const merchantAccount = await getOrCreateMerchantAccount(tx, payment.merchant_id);

      // Bucket move on one liability account: DR PENDING, CR AVAILABLE.
      const posting = await post(tx, {
        referenceType: 'PAYMENT',
        referenceId: paymentId,
        operationId: `payment:released:${paymentId}`,
        description: 'pending liability released to available',
        lines: [
          { accountId: merchantAccount, debit: amount, bucket: 'PENDING' },
          { accountId: merchantAccount, credit: amount, bucket: 'AVAILABLE' },
        ],
      });
      if (!posting.created) {
        throw new FinancialError(ErrorCodes.DUPLICATE_OPERATION, 'payment was already released');
      }

      const updated = await tx.query(
        `UPDATE core.payments
            SET status = 'RELEASED', released_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'VERIFIED'`,
        [paymentId],
      );
      if (updated.rowCount !== 1) {
        throw new FinancialError('RELEASE_STATE_RACE', 'payment state changed during release');
      }

      await recordTransition(tx, {
        entityType: 'PAYMENT',
        entityId: paymentId,
        fromState: 'VERIFIED',
        event: 'RELEASE',
        toState: 'RELEASED',
        actorType: 'WORKER',
        metadata: { amount: amount.toAtomicString() },
      });

      await enqueue(tx, {
        eventType: 'payment.released',
        aggregateType: 'PAYMENT',
        aggregateId: paymentId,
        payload: {
          payment_id: paymentId,
          merchant_id: payment.merchant_id,
          amount: amount.toAtomicString(),
        },
      });

      return {
        paymentId,
        merchantId: payment.merchant_id,
        amount: amount.toAtomicString(),
      };
    },
    { isolation: 'SERIALIZABLE', retries: 3 },
  );
}
