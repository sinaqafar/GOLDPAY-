/**
 * Disputes — PART 70.
 *
 * A dispute is a CASE, not a chargeback. CubePay publishes no dispute or
 * reversal mechanism, so two opposite assumptions would both be guesses:
 * that a reversal is always possible, or that one can never happen because
 * payments are rial-denominated. Neither is safe to encode.
 *
 * So a dispute does exactly three things:
 *
 *   1. opens a case and accumulates evidence,
 *   2. places a HOLD, pausing release of the money in question,
 *   3. waits for a human.
 *
 * It never reverses anything on its own. If a decision requires money to go
 * back, that goes through the refund path, which has its own (currently gated)
 * policy — keeping "we are investigating" strictly separate from "we are
 * moving money" (SPEC 70.55).
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../../database/src/client.ts';
import { placeHold, releaseHold } from '../risk.ts';
import { recordTransition } from '../transitions.ts';
import { ValidationError, NotFoundError, ConflictError } from '../../../errors/src/index.ts';

export type DisputeStatus =
  | 'OPEN'
  | 'UNDER_REVIEW'
  | 'HOLD'
  | 'ESCALATED'
  | 'RESOLVED'
  | 'REJECTED'
  | 'CLOSED';

export type DisputeResolution =
  | 'UPHELD_MERCHANT'
  | 'UPHELD_CUSTOMER'
  | 'REFUND_REQUIRED'
  | 'NO_ACTION';

export const DISPUTE_TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = {
  OPEN: ['UNDER_REVIEW', 'HOLD', 'REJECTED'],
  UNDER_REVIEW: ['HOLD', 'ESCALATED', 'RESOLVED', 'REJECTED'],
  HOLD: ['UNDER_REVIEW', 'ESCALATED', 'RESOLVED', 'REJECTED'],
  ESCALATED: ['RESOLVED', 'REJECTED'],
  RESOLVED: ['CLOSED'],
  REJECTED: ['CLOSED'],
  CLOSED: [],
};

export interface OpenDisputeInput {
  paymentId: string;
  reason: string;
  openedByType: 'MERCHANT' | 'ADMIN' | 'CUSTOMER' | 'SYSTEM';
  openedById?: string;
  evidence?: Record<string, unknown>[];
  /** Restricts the dispute to one merchant's payment when a merchant opens it. */
  merchantId?: string;
}

export async function openDispute(
  db: Database,
  input: OpenDisputeInput,
): Promise<{ disputeId: string; status: DisputeStatus; holdPlaced: boolean }> {
  if (!input.reason.trim()) {
    throw new ValidationError('MISSING_REASON', 'a reason is required to open a dispute');
  }

  return db.transaction(async (tx) => {
    const r = await tx.query<{
      id: string;
      merchant_id: string;
      status: string;
      released_at: string | null;
    }>(
      `SELECT id, merchant_id, status, released_at
         FROM core.payments WHERE id = $1 FOR UPDATE`,
      [input.paymentId],
    );
    const payment = r.rows[0];
    if (!payment) throw new NotFoundError('payment', input.paymentId);

    // A merchant may only dispute their own payment, and gets a 404 rather than
    // a 403 so the endpoint cannot be used to probe for other merchants' data.
    if (input.merchantId && payment.merchant_id !== input.merchantId) {
      throw new NotFoundError('payment', input.paymentId);
    }

    const open = await tx.query<{ id: string }>(
      `SELECT id FROM core.disputes
        WHERE payment_id = $1
          AND status IN ('OPEN','UNDER_REVIEW','HOLD','ESCALATED')`,
      [input.paymentId],
    );
    if (open.rows.length > 0) {
      throw new ConflictError(
        'DISPUTE_ALREADY_OPEN',
        'this payment already has an open dispute',
        { disputeId: open.rows[0]?.id },
      );
    }

    const disputeId = randomUUID();
    await tx.query(
      `INSERT INTO core.disputes
          (id, payment_id, merchant_id, status, reason, evidence, opened_by_type, opened_by_id)
       VALUES ($1,$2,$3,'HOLD',$4,$5::jsonb,$6,$7)`,
      [
        disputeId,
        input.paymentId,
        payment.merchant_id,
        input.reason.slice(0, 500),
        JSON.stringify(input.evidence ?? []),
        input.openedByType,
        input.openedById ?? null,
      ],
    );

    // Pause the money. If the payout already settled on chain this hold cannot
    // and must not pretend to claw it back — the case simply records that fact
    // for the reviewer.
    const hold = await placeHold(tx, {
      paymentId: input.paymentId,
      merchantId: payment.merchant_id,
      source: 'DISPUTE',
      sourceId: disputeId,
      reason: `dispute: ${input.reason.slice(0, 200)}`,
    });

    await recordTransition(tx, {
      entityType: 'DISPUTE',
      entityId: disputeId,
      fromState: null,
      toState: 'HOLD',
      event: 'OPEN',
      actorType: input.openedByType,
      metadata: { paymentId: input.paymentId, alreadyReleased: payment.released_at !== null },
    });

    return { disputeId, status: 'HOLD' as const, holdPlaced: hold.created };
  });
}

/** Append evidence. Existing entries are never overwritten. */
export async function addDisputeEvidence(
  db: Database,
  params: { disputeId: string; evidence: Record<string, unknown>; addedBy: string },
): Promise<void> {
  const updated = await db.query(
    `UPDATE core.disputes
        SET evidence = evidence || $2::jsonb, updated_at = NOW()
      WHERE id = $1 AND status IN ('OPEN','UNDER_REVIEW','HOLD','ESCALATED')`,
    [
      params.disputeId,
      JSON.stringify([
        { ...params.evidence, added_by: params.addedBy, added_at: new Date().toISOString() },
      ]),
    ],
  );
  if (updated.rowCount !== 1) {
    throw new ConflictError('DISPUTE_NOT_OPEN', 'evidence can only be added to an open dispute');
  }
}

/**
 * Resolve a dispute.
 *
 * Records the decision and, when the outcome allows it, lifts the hold. It does
 * NOT move money: `REFUND_REQUIRED` means somebody must now raise a refund,
 * which is a separate, audited action (SPEC 70.55).
 */
export async function resolveDispute(
  db: Database,
  params: {
    disputeId: string;
    resolution: DisputeResolution;
    note?: string;
    resolvedBy: string;
  },
): Promise<{ status: DisputeStatus; holdReleased: boolean }> {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ id: string; status: string; payment_id: string }>(
      'SELECT id, status, payment_id FROM core.disputes WHERE id = $1 FOR UPDATE',
      [params.disputeId],
    );
    const dispute = r.rows[0];
    if (!dispute) throw new NotFoundError('dispute', params.disputeId);

    const allowed = DISPUTE_TRANSITIONS[dispute.status as DisputeStatus] ?? [];
    if (!allowed.includes('RESOLVED')) {
      throw new ConflictError(
        'DISPUTE_NOT_RESOLVABLE',
        `a dispute in status ${dispute.status} cannot be resolved`,
      );
    }

    await tx.query(
      `UPDATE core.disputes
          SET status = 'RESOLVED', resolution = $2, resolution_note = $3,
              resolved_by_id = $4, resolved_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [params.disputeId, params.resolution, params.note?.slice(0, 500) ?? null, params.resolvedBy],
    );

    // The hold lifts only when the merchant keeps the money. If a refund is
    // required the funds stay paused until that refund is actually handled —
    // releasing here would let the money leave while it is still owed back.
    let holdReleased = false;
    if (params.resolution === 'UPHELD_MERCHANT' || params.resolution === 'NO_ACTION') {
      const holds = await tx.query<{ id: string }>(
        `SELECT id FROM finance.payment_holds
          WHERE payment_id = $1 AND source = 'DISPUTE' AND status = 'ACTIVE'`,
        [dispute.payment_id],
      );
      for (const hold of holds.rows) {
        await tx.query(
          `UPDATE finance.payment_holds
              SET status = 'RELEASED', released_at = NOW(), released_by = $2
            WHERE id = $1`,
          [hold.id, params.resolvedBy],
        );
        holdReleased = true;
      }
    }

    await recordTransition(tx, {
      entityType: 'DISPUTE',
      entityId: params.disputeId,
      fromState: dispute.status,
      toState: 'RESOLVED',
      event: 'RESOLVE',
      actorType: 'ADMIN',
      metadata: { resolution: params.resolution, holdReleased },
    });

    return { status: 'RESOLVED' as const, holdReleased };
  });
}

export { releaseHold };
