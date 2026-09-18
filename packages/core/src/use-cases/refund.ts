/**
 * Refunds — PART 70.
 *
 * The domain model and state machine are complete. Financial execution is
 * deliberately gated behind `REFUND_POLICY_DEFINED`.
 *
 * Why gated rather than simply implemented: the specification never states what
 * happens to the platform's 15% when a payment is reversed, and CubePay's
 * published API does not define how its own fee behaves on a refund. Picking
 * either answer would be inventing a financial rule, which SPEC 121.107
 * forbids. A refund request is therefore recorded, capped and audited — it just
 * does not move money until the policy exists.
 *
 * What is already enforced:
 *
 *   SPEC 121.86  total refunds <= collected amount, in the application AND in
 *                the database
 *   SPEC 70.53   a refund is never a balance edit
 *   SPEC 70.54   an adjustment is a new audited journal, never a mutation
 *   SPEC 121.85  eligibility, idempotency and provider evidence are required
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../../database/src/client.ts';
import { Money } from '../../../money/src/index.ts';
import { assertTomanWithinBounds } from '../limits.ts';
import { enqueue } from '../outbox.ts';
import { recordTransition } from '../transitions.ts';
import { ValidationError, NotFoundError, ConflictError } from '../../../errors/src/index.ts';

export type RefundStatus =
  | 'REQUESTED'
  | 'BLOCKED_POLICY_UNDEFINED'
  | 'APPROVED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'REJECTED';

export const REFUND_TRANSITIONS: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  REQUESTED: ['BLOCKED_POLICY_UNDEFINED', 'APPROVED', 'REJECTED'],
  // The only way out is a policy decision or a rejection: never straight to
  // money moving.
  BLOCKED_POLICY_UNDEFINED: ['APPROVED', 'REJECTED'],
  APPROVED: ['PROCESSING', 'REJECTED'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'UNKNOWN'],
  // SPEC 81 — an unknown refund is resolved by reconciliation, never retried
  // blindly, because the customer may already have their money.
  UNKNOWN: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  REJECTED: [],
};

/**
 * Whether the refund policy has been defined.
 *
 * Until this is true the engine records requests but will not execute them.
 * Flipping it on without writing the fee-reversal rules would be worse than
 * leaving it off.
 */
export function isRefundPolicyDefined(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['REFUND_POLICY_DEFINED'] === 'true';
}

export interface RequestRefundInput {
  paymentId: string;
  merchantId: string;
  amount: string;
  reason: string;
  requestedByType: 'MERCHANT' | 'ADMIN' | 'SYSTEM';
  requestedById?: string;
}

export interface RefundResult {
  refundId: string;
  status: RefundStatus;
  /** Present when the request is recorded but cannot be executed yet. */
  blockedReason?: string;
}

/**
 * Record a refund request.
 *
 * Runs in one transaction with the payment row locked, so two concurrent
 * requests cannot together exceed the collected amount.
 */
export async function requestRefund(
  db: Database,
  input: RequestRefundInput,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<RefundResult> {
  if (!input.reason.trim()) {
    throw new ValidationError('MISSING_REASON', 'a reason is required for a refund');
  }

  let amount: Money;
  try {
    amount = Money.toman(input.amount);
  } catch {
    throw new ValidationError('INVALID_AMOUNT', 'refund amount must be an integer string');
  }
  if (!amount.isPositive()) {
    throw new ValidationError('INVALID_AMOUNT', 'refund amount must be greater than zero');
  }
  assertTomanWithinBounds(amount.atomic, 'refund amount');

  return db.transaction(async (tx) => {
    const r = await tx.query<{
      id: string;
      merchant_id: string;
      status: string;
      verified_amount: string | null;
      invoice_id: string;
      provider_fee_actual: string | null;
      provider_fee_expected: string | null;
    }>(
      `SELECT id, merchant_id, status, verified_amount::text, invoice_id,
              provider_fee_actual::text, provider_fee_expected::text
         FROM core.payments WHERE id = $1 FOR UPDATE`,
      [input.paymentId],
    );
    const payment = r.rows[0];
    if (!payment) throw new NotFoundError('payment', input.paymentId);

    // Tenant check inside the lock, and a 404 rather than a 403 so the endpoint
    // cannot be used to probe for other merchants' payments.
    if (payment.merchant_id !== input.merchantId) {
      throw new NotFoundError('payment', input.paymentId);
    }

    // SPEC 124: only a verified payment can be reversed. Refunding something
    // that was never confirmed would create money.
    if (payment.status !== 'VERIFIED' && payment.status !== 'RELEASED') {
      throw new ConflictError(
        'PAYMENT_NOT_REFUNDABLE',
        `a payment in status ${payment.status} cannot be refunded`,
        { status: payment.status },
      );
    }

    const collected = Money.toman(payment.verified_amount ?? '0');

    // SPEC 121.86, checked here as well as by the database trigger.
    const priorRes = await tx.query<{ total: string }>(
      `SELECT COALESCE(SUM(requested_amount), 0)::text AS total
         FROM core.refunds
        WHERE payment_id = $1 AND status NOT IN ('FAILED','REJECTED')`,
      [input.paymentId],
    );
    const prior = Money.toman(priorRes.rows[0]?.total ?? '0');
    if (prior.add(amount).compare(collected) > 0) {
      throw new ConflictError(
        'REFUND_EXCEEDS_PAYMENT',
        'the total refunded would exceed the amount collected',
        {
          collected: collected.toAtomicString(),
          alreadyRefunded: prior.toAtomicString(),
          requested: amount.toAtomicString(),
        },
      );
    }

    const invoice = await tx.query<{ platform_fee_amount: string }>(
      'SELECT platform_fee_amount::text FROM core.invoices WHERE id = $1',
      [payment.invoice_id],
    );

    const policyDefined = isRefundPolicyDefined(options.env);
    const status: RefundStatus = policyDefined ? 'REQUESTED' : 'BLOCKED_POLICY_UNDEFINED';
    const refundId = randomUUID();

    await tx.query(
      `INSERT INTO core.refunds (
         id, payment_id, merchant_id,
         original_amount, original_platform_fee, original_provider_fee,
         requested_amount, status, reason, requested_by_type, requested_by_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        refundId,
        input.paymentId,
        input.merchantId,
        collected.toAtomicString(),
        invoice.rows[0]?.platform_fee_amount ?? '0',
        // Prefer what the provider actually reported over our estimate.
        payment.provider_fee_actual ?? payment.provider_fee_expected,
        amount.toAtomicString(),
        status,
        input.reason.slice(0, 500),
        input.requestedByType,
        input.requestedById ?? null,
      ],
    );

    await recordTransition(tx, {
      entityType: 'REFUND',
      entityId: refundId,
      fromState: null,
      toState: status,
      event: 'REQUEST',
      actorType: input.requestedByType,
      metadata: { amount: amount.toAtomicString(), reason: input.reason.slice(0, 200) },
    });

    if (!policyDefined) {
      // Recorded, capped, audited — and explicitly not executed.
      return {
        refundId,
        status,
        blockedReason:
          'the refund fee policy is not defined yet: the provider contract must state how the platform and provider fees behave on a reversal',
      };
    }

    await enqueue(tx, {
      eventType: 'payment.refunded',
      aggregateType: 'REFUND',
      aggregateId: refundId,
      payload: {
        refund_id: refundId,
        payment_id: input.paymentId,
        merchant_id: input.merchantId,
        amount: amount.toAtomicString(),
      },
    });

    return { refundId, status };
  });
}

/** How much of a payment may still be refunded. */
export async function refundableAmount(db: Database, paymentId: string): Promise<string> {
  const r = await db.query<{ collected: string | null; refunded: string }>(
    `SELECT p.verified_amount::text AS collected,
            COALESCE((SELECT SUM(requested_amount) FROM core.refunds
                       WHERE payment_id = p.id AND status NOT IN ('FAILED','REJECTED')), 0)::text
              AS refunded
       FROM core.payments p WHERE p.id = $1`,
    [paymentId],
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError('payment', paymentId);

  const collected = BigInt(row.collected ?? '0');
  const refunded = BigInt(row.refunded);
  return (collected > refunded ? collected - refunded : 0n).toString();
}
