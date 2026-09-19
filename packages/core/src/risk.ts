/**
 * Risk engine — SPEC 255-259, 1415.
 *
 * Scores are ADVISORY. The engine may record, alert and pause; it may never
 * block, seize, or touch the ledger (SPEC 1415: "Risk Engine نباید خودش Ledger
 * را تغییر دهد").
 *
 * The strongest action available is REVIEW, which stops a payment being
 * released. The money stays exactly where it is — nothing is reversed, nothing
 * is taken — until a human decides. That asymmetry is deliberate: a false
 * positive costs a merchant a delay, while an automatic block on a bad signal
 * could cost them their business.
 *
 * Thresholds are configurable because the spec never fixed them; the defaults
 * below are a starting point, not a finding.
 */

import { randomUUID } from 'node:crypto';
import type { Database, TransactionContext } from '../../database/src/client.ts';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type RiskDecision = 'ALLOW' | 'MONITOR' | 'REVIEW';

export interface RiskSignal {
  /** Stable identifier so a decision can be explained and audited. */
  code: string;
  /** Points this signal contributes. */
  weight: number;
  detail?: Record<string, unknown>;
}

export interface RiskAssessment {
  id: string;
  score: number;
  level: RiskLevel;
  decision: RiskDecision;
  signals: RiskSignal[];
}

export interface RiskThresholds {
  /** At or above this, the payment goes to REVIEW. */
  review: number;
  /** At or above this, it is watched but proceeds. */
  monitor: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = { review: 70, monitor: 40 };

export function levelFor(score: number): RiskLevel {
  if (score >= 70) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

export function decisionFor(score: number, thresholds = DEFAULT_THRESHOLDS): RiskDecision {
  if (score >= thresholds.review) return 'REVIEW';
  if (score >= thresholds.monitor) return 'MONITOR';
  return 'ALLOW';
}

export interface PaymentRiskInput {
  merchantId: string;
  paymentId: string;
  /** Amount collected, in TOMAN atomic units. */
  amountAtomic: bigint;
  merchantAgeDays: number;
  /** Payments this merchant has had verified before this one. */
  priorPaymentCount: number;
  /** Failed payment attempts in the recent window. */
  recentFailures: number;
  /** Payments verified for this merchant in the last hour. */
  paymentsLastHour: number;
  /** Whether the provider's amount disagreed with the invoice. */
  amountMismatch: boolean;
  /** Whether the merchant's payout wallet changed very recently. */
  walletChangedRecently: boolean;
}

/**
 * Score a payment. Pure — no database, no side effects — so it is trivially
 * testable and cannot accidentally act on its own conclusion.
 */
export function scorePayment(
  input: PaymentRiskInput,
  thresholds = DEFAULT_THRESHOLDS,
): Omit<RiskAssessment, 'id'> {
  const signals: RiskSignal[] = [];

  // SPEC 256 — a brand new merchant taking large volume is the classic bust-out
  // pattern, so age and amount compound rather than being judged separately.
  if (input.merchantAgeDays < 7) {
    const weight = input.amountAtomic > 50_000_000n ? 30 : 15;
    signals.push({
      code: 'NEW_MERCHANT',
      weight,
      detail: { ageDays: input.merchantAgeDays, amount: input.amountAtomic.toString() },
    });
  }

  if (input.priorPaymentCount === 0 && input.amountAtomic > 20_000_000n) {
    signals.push({
      code: 'LARGE_FIRST_PAYMENT',
      weight: 20,
      detail: { amount: input.amountAtomic.toString() },
    });
  }

  if (input.recentFailures >= 5) {
    signals.push({
      code: 'REPEATED_FAILURES',
      weight: Math.min(25, input.recentFailures * 3),
      detail: { failures: input.recentFailures },
    });
  }

  if (input.paymentsLastHour > 50) {
    signals.push({
      code: 'RAPID_TRANSACTIONS',
      weight: 20,
      detail: { count: input.paymentsLastHour },
    });
  }

  // A mismatch is never auto-credited anyway, but it raises the score so the
  // pattern is visible across a merchant's history.
  if (input.amountMismatch) {
    signals.push({ code: 'AMOUNT_MISMATCH', weight: 35 });
  }

  // Money about to be sent to an address that changed minutes ago is the
  // signature of a compromised account (SPEC 1414).
  if (input.walletChangedRecently) {
    signals.push({ code: 'RECENT_WALLET_CHANGE', weight: 30 });
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));

  return { score, level: levelFor(score), decision: decisionFor(score, thresholds), signals };
}

/**
 * Persist an assessment. Writing the record is all this does — applying a hold
 * is a separate, explicit call, so no code path can pause a payment as an
 * accidental side effect of scoring it.
 */
export async function recordAssessment(
  tx: TransactionContext,
  params: {
    entityType: 'PAYMENT' | 'PAYOUT' | 'MERCHANT' | 'WALLET';
    entityId: string;
    merchantId: string | null;
    assessment: Omit<RiskAssessment, 'id'>;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO risk.assessments
        (id, entity_type, entity_id, merchant_id, score, level, decision, signals)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      id,
      params.entityType,
      params.entityId,
      params.merchantId,
      params.assessment.score,
      params.assessment.level,
      params.assessment.decision,
      JSON.stringify(params.assessment.signals),
    ],
  );
  return id;
}

/**
 * Place a hold on a payment.
 *
 * A hold pauses release. It does not move, reverse or reduce anything: the
 * balance is untouched and simply stops progressing (SPEC 121.88 — a hold must
 * not erase the payment's history).
 *
 * Idempotent: an entity that is already held is not held twice.
 */
export async function placeHold(
  tx: TransactionContext,
  params: {
    paymentId: string;
    merchantId: string;
    source: 'RISK' | 'DISPUTE' | 'ADMIN' | 'COMPLIANCE';
    sourceId?: string;
    reason: string;
  },
): Promise<{ holdId: string; created: boolean }> {
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM finance.payment_holds
      WHERE payment_id = $1 AND source = $2 AND status = 'ACTIVE'`,
    [params.paymentId, params.source],
  );
  const found = existing.rows[0];
  if (found) return { holdId: found.id, created: false };

  const id = randomUUID();
  await tx.query(
    `INSERT INTO finance.payment_holds
        (id, payment_id, merchant_id, source, source_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, params.paymentId, params.merchantId, params.source, params.sourceId ?? null, params.reason.slice(0, 300)],
  );
  return { holdId: id, created: true };
}

/** Lift a hold. Only an explicit human decision reaches here. */
export async function releaseHold(
  db: Database,
  params: { holdId: string; releasedBy: string },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE finance.payment_holds
        SET status = 'RELEASED', released_at = NOW(), released_by = $2
      WHERE id = $1 AND status = 'ACTIVE'`,
    [params.holdId, params.releasedBy],
  );
  return r.rowCount === 1;
}

/** Whether anything is currently blocking this payment from being released. */
export async function hasActiveHold(
  tx: TransactionContext,
  paymentId: string,
): Promise<boolean> {
  const r = await tx.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM finance.payment_holds
      WHERE payment_id = $1 AND status = 'ACTIVE'`,
    [paymentId],
  );
  return Number(r.rows[0]?.count ?? '0') > 0;
}
