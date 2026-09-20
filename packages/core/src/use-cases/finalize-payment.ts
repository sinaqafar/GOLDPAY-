/**
 * FinalizePaymentUseCase — SPEC 117.49.
 *
 * Order (103787-103796):
 *   Load Payment -> Check Idempotency -> Verify Provider Evidence -> Validate
 *   Amount -> Validate Invoice -> Calculate Snapshot Financials -> Post Ledger
 *   -> Update Payment -> Create Outbox Events -> Commit
 *
 * SPEC 124.168: NO VERIFIED EVIDENCE -> NO FINAL CREDIT.
 * SPEC 119.41: three identical provider callbacks produce exactly ONE economic result.
 * SPEC 1251/1252: verified_paid_at + 48h determines release eligibility.
 */

import { randomUUID } from 'node:crypto';
import type { Database, TransactionContext } from '../../../database/src/client.ts';
import { Money } from '../../../money/src/index.ts';
import { feeBreakdownFromSnapshot, calculateProviderCost } from '../fees.ts';
import { scorePayment, recordAssessment, placeHold } from '../risk.ts';
import { post, type JournalLine } from '../../../ledger/src/ledger-service.ts';
import { getOrCreateMerchantAccount, getSystemAccountId } from '../../../ledger/src/accounts.ts';
import { enqueue } from '../outbox.ts';
import { recordTransition } from '../transitions.ts';
import { sha256Hex } from '../../../crypto/src/index.ts';
import type { Config } from '../../../config/src/index.ts';
import {
  ValidationError,
  NotFoundError,
  FinancialError,
  ErrorCodes,
} from '../../../errors/src/index.ts';

/** Verified evidence from the provider. Never trusted without a valid signature. */
export interface ProviderEvidence {
  provider: string;
  externalPaymentId: string;
  /** Amount the provider says was actually collected, in TOMAN atomic units. */
  paidAmount: string;
  /**
   * Fee the provider reports it deducted, in TOMAN atomic units, or null when
   * the provider does not report one. Null means unknown, never zero.
   */
  providerFeeAmount?: string | null;
  /** Provider-side status, already normalised by the adapter. */
  status: 'PAID' | 'FAILED' | 'PENDING' | 'UNKNOWN';
  paidAt: string;
  /** Raw payload retained verbatim for audit (SPEC 118.69). */
  raw: Record<string, unknown>;
}

export interface FinalizePaymentInput {
  invoiceId: string;
  evidence: ProviderEvidence;
  /** Correlates the outbox events with the inbound webhook. */
  correlationId?: string;
}

export interface FinalizePaymentResult {
  paymentId: string;
  status: 'VERIFIED' | 'MISMATCH' | 'FAILED' | 'UNKNOWN';
  /** True only when this call caused the credit; false on idempotent replay. */
  credited: boolean;
  releaseAt: string | null;
  merchantNet: string | null;
  mismatchCode?: string;
}

export async function finalizePayment(
  db: Database,
  config: Config,
  input: FinalizePaymentInput,
): Promise<FinalizePaymentResult> {
  const { evidence } = input;

  if (!evidence.externalPaymentId) {
    throw new ValidationError('MISSING_EXTERNAL_ID', 'provider evidence requires an external payment id');
  }

  // SERIALIZABLE: the read of the invoice/payment and the ledger write must not
  // interleave with a concurrent callback for the same invoice.
  return db.transaction(
    async (tx) => {
      // 1. Load the invoice and lock it.
      const invoiceRes = await tx.query<{
        id: string;
        merchant_id: string;
        status: string;
        expires_at: string | null;
        base_amount: string;
        customer_total_amount: string;
        platform_fee_amount: string;
        merchant_net_amount: string;
        customer_fee_share: string;
        merchant_fee_share: string;
        fee_mode: string;
        fee_rate_bps: string;
        fee_policy_version: string;
        provider_mode?: string | null;
        provider_pay_amount_toman?: string | null;
        provider_pay_amount_rial?: string | null;
      }>(
        `SELECT id, merchant_id, status, expires_at,
                base_amount::text, customer_total_amount::text, platform_fee_amount::text,
                merchant_net_amount::text, customer_fee_share::text, merchant_fee_share::text,
                fee_mode, fee_rate_bps::text, fee_policy_version,
                provider_mode, provider_pay_amount_toman::text, provider_pay_amount_rial::text
           FROM core.invoices WHERE id = $1 FOR UPDATE`,
        [input.invoiceId],
      );
      const invoice = invoiceRes.rows[0];
      if (!invoice) throw new NotFoundError('invoice', input.invoiceId);

      // 2. Idempotency: has this provider payment already been recorded?
      const existingRes = await tx.query<{
        id: string;
        status: string;
        release_at: string | null;
      }>(
        `SELECT id, status, release_at
           FROM core.payments
          WHERE provider = $1 AND external_payment_id = $2
          FOR UPDATE`,
        [evidence.provider, evidence.externalPaymentId],
      );
      const existing = existingRes.rows[0];
      if (existing) {
        // SPEC 119.41 — replay produces no second economic effect.
        await storeEvidence(tx, existing.id, evidence);
        return {
          paymentId: existing.id,
          status: existing.status as FinalizePaymentResult['status'],
          credited: false,
          releaseAt: existing.release_at,
          merchantNet: invoice.merchant_net_amount,
        };
      }

      const paymentId = randomUUID();
      // Match against exact provider payable snapshot if offset was applied, else customer total
      const expectedTotal = invoice.provider_pay_amount_toman
        ? Money.toman(invoice.provider_pay_amount_toman)
        : Money.toman(invoice.customer_total_amount);

      // 3. Provider status must be conclusive before any credit.
      if (evidence.status !== 'PAID') {
        const status = evidence.status === 'FAILED' ? 'FAILED' : 'UNKNOWN';
        await insertPayment(tx, {
          paymentId,
          invoice,
          evidence,
          status,
          verifiedAmount: null,
          verifiedPaidAt: null,
          releaseAt: null,
          mismatchCode: status === 'UNKNOWN' ? ErrorCodes.PROVIDER_STATUS_UNKNOWN : null,
          failureCode: status === 'FAILED' ? 'PROVIDER_REPORTED_FAILURE' : null,
        });
        await storeEvidence(tx, paymentId, evidence);
        await recordTransition(tx, {
          entityType: 'PAYMENT',
          entityId: paymentId,
          fromState: null,
          event: 'PROVIDER_CALLBACK',
          toState: status,
          actorType: 'PROVIDER',
        });
        return { paymentId, status, credited: false, releaseAt: null, merchantNet: null };
      }

      // 4. Validate the amount against the invoice snapshot.
      const paidAmount = Money.toman(evidence.paidAmount);
      if (!paidAmount.equals(expectedTotal)) {
        // SPEC 119.37-119.39: over/underpayment never auto-credits.
        const mismatchCode = paidAmount.lt(expectedTotal) ? 'UNDERPAYMENT' : 'OVERPAYMENT';
        await insertPayment(tx, {
          paymentId,
          invoice,
          evidence,
          status: 'MISMATCH',
          verifiedAmount: paidAmount.toAtomicString(),
          verifiedPaidAt: null,
          releaseAt: null,
          mismatchCode,
          failureCode: null,
        });
        await storeEvidence(tx, paymentId, evidence);
        await recordTransition(tx, {
          entityType: 'PAYMENT',
          entityId: paymentId,
          fromState: null,
          event: 'AMOUNT_MISMATCH',
          toState: 'MISMATCH',
          actorType: 'PROVIDER',
          metadata: { expected: expectedTotal.toAtomicString(), paid: paidAmount.toAtomicString() },
        });
        await tx.query(
          `INSERT INTO system.reconciliation_exceptions
             (id, kind, severity, entity_type, entity_id, details)
           VALUES ($1,'AMOUNT_MISMATCH','HIGH','PAYMENT',$2,$3::jsonb)`,
          [
            randomUUID(),
            paymentId,
            JSON.stringify({
              expected: expectedTotal.toAtomicString(),
              paid: paidAmount.toAtomicString(),
              mismatchCode,
            }),
          ],
        );
        return {
          paymentId,
          status: 'MISMATCH',
          credited: false,
          releaseAt: null,
          merchantNet: null,
          mismatchCode,
        };
      }

      // 5. Validate invoice state. An expired or already-paid invoice must not credit.
      if (invoice.status !== 'CREATED') {
        throw new ValidationError(ErrorCodes.INVOICE_NOT_PAYABLE, `invoice is ${invoice.status}`, {
          status: invoice.status,
        });
      }
      const paidAt = new Date(evidence.paidAt);
      if (Number.isNaN(paidAt.getTime())) {
        throw new ValidationError('INVALID_PAID_AT', 'provider paidAt is not a valid timestamp');
      }
      if (invoice.expires_at && paidAt > new Date(invoice.expires_at)) {
        // Paid after expiry: hold for manual review rather than silently crediting.
        await insertPayment(tx, {
          paymentId,
          invoice,
          evidence,
          status: 'MISMATCH',
          verifiedAmount: paidAmount.toAtomicString(),
          verifiedPaidAt: null,
          releaseAt: null,
          mismatchCode: ErrorCodes.INVOICE_EXPIRED,
          failureCode: null,
        });
        await storeEvidence(tx, paymentId, evidence);
        return {
          paymentId,
          status: 'MISMATCH',
          credited: false,
          releaseAt: null,
          merchantNet: null,
          mismatchCode: ErrorCodes.INVOICE_EXPIRED,
        };
      }

      // 6. Financial snapshot comes from the invoice, never recomputed here.
      const breakdown = feeBreakdownFromSnapshot({
        base_amount: invoice.base_amount,
        customer_total_amount: invoice.customer_total_amount,
        platform_fee_amount: invoice.platform_fee_amount,
        merchant_net_amount: invoice.merchant_net_amount,
        customer_fee_share: invoice.customer_fee_share,
        merchant_fee_share: invoice.merchant_fee_share,
        fee_mode: invoice.fee_mode,
        fee_rate_bps: invoice.fee_rate_bps,
        fee_policy_version: invoice.fee_policy_version,
      });

      const releaseAt = new Date(paidAt.getTime() + config.settlement.holdHours * 3600 * 1000);

      // Expected comes from config; actual comes from the provider, when it
      // reports one at all. Booking our own estimate as though it were fact
      // would let a silent provider rate change go unnoticed while the ledger
      // kept reporting a margin that was never earned.
      const providerCost = calculateProviderCost(
        breakdown.customerTotal,
        config.fees.providerFeePercent,
      );
      const expectedFee = providerCost.providerFee;
      const reportedFee =
        typeof evidence.providerFeeAmount === 'string' && /^\d+$/.test(evidence.providerFeeAmount)
          ? Money.toman(evidence.providerFeeAmount)
          : null;

      // Book whichever figure we can defend: the reported one if we have it.
      const bookedFee = reportedFee ?? expectedFee;
      const providerFeeStatus =
        reportedFee === null
          ? ('CONFIG_ESTIMATED' as const)
          : reportedFee.equals(expectedFee)
            ? ('PROVIDER_CONFIRMED' as const)
            : ('MISMATCH' as const);

      await insertPayment(tx, {
        paymentId,
        invoice,
        evidence,
        status: 'VERIFIED',
        verifiedAmount: paidAmount.toAtomicString(),
        verifiedPaidAt: paidAt.toISOString(),
        releaseAt: releaseAt.toISOString(),
        mismatchCode: null,
        failureCode: null,
        providerFee: {
          expected: expectedFee.toAtomicString(),
          actual: reportedFee?.toAtomicString() ?? null,
          difference: reportedFee ? reportedFee.subtract(expectedFee).toAtomicString() : null,
          status: providerFeeStatus,
          source: reportedFee ? `${evidence.provider}_API` : 'CONFIG',
        },
      });

      // A divergence is a finance question, not a payment failure: the money
      // moved correctly, but our cost model disagrees with the provider.
      if (providerFeeStatus === 'MISMATCH' && reportedFee) {
        await tx.query(
          `INSERT INTO system.reconciliation_exceptions
              (id, kind, severity, entity_type, entity_id, status, details)
           VALUES ($1,'AMOUNT_MISMATCH','MEDIUM','PAYMENT',$2,'OPEN',$3::jsonb)`,
          [
            randomUUID(),
            paymentId,
            JSON.stringify({
              reason: 'PROVIDER_FEE_MISMATCH',
              expected: expectedFee.toAtomicString(),
              actual: reportedFee.toAtomicString(),
              difference: reportedFee.subtract(expectedFee).toAtomicString(),
              provider: evidence.provider,
            }),
          ],
        );
      }

      // 6b. Score the payment for risk (SPEC 255-259).
      //
      // The assessment is advisory: a HIGH score records a hold that pauses
      // RELEASE, but the payment is still verified and the money is still
      // credited. Nothing is blocked, reversed or seized — SPEC 1415 forbids
      // the risk engine from touching the ledger itself.
      const riskFacts = await tx.query<{
        merchant_age_days: string;
        prior_payments: string;
        payments_last_hour: string;
        wallet_changed_recently: boolean;
      }>(
        `SELECT
           EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 86400 AS merchant_age_days,
           (SELECT COUNT(*) FROM core.payments
             WHERE merchant_id = m.id AND status = 'VERIFIED' AND id <> $2) AS prior_payments,
           (SELECT COUNT(*) FROM core.payments
             WHERE merchant_id = m.id AND created_at > NOW() - INTERVAL '1 hour') AS payments_last_hour,
           EXISTS (SELECT 1 FROM core.wallets
                    WHERE merchant_id = m.id AND created_at > NOW() - INTERVAL '24 hours')
             AS wallet_changed_recently
         FROM core.merchants m WHERE m.id = $1`,
        [invoice.merchant_id, paymentId],
      );
      const facts = riskFacts.rows[0];

      if (facts) {
        const assessment = scorePayment({
          merchantId: invoice.merchant_id,
          paymentId,
          amountAtomic: paidAmount.atomic,
          merchantAgeDays: Number(facts.merchant_age_days),
          priorPaymentCount: Number(facts.prior_payments),
          recentFailures: 0,
          paymentsLastHour: Number(facts.payments_last_hour),
          amountMismatch: false,
          walletChangedRecently: facts.wallet_changed_recently,
        });

        const assessmentId = await recordAssessment(tx, {
          entityType: 'PAYMENT',
          entityId: paymentId,
          merchantId: invoice.merchant_id,
          assessment,
        });

        if (assessment.decision === 'REVIEW') {
          await placeHold(tx, {
            paymentId,
            merchantId: invoice.merchant_id,
            source: 'RISK',
            sourceId: assessmentId,
            reason: `risk score ${assessment.score}: ${assessment.signals.map((s) => s.code).join(', ')}`,
          });
        }
      }

      // 7. Post the ledger (SPEC 119.44 — Payment Posting Matrix).
      //    DR provider clearing asset (money owed to us by the provider)
      //    CR merchant liability  (PENDING bucket — not yet releasable)
      //    CR platform revenue    (the fee we earned)
      const merchantAccount = await getOrCreateMerchantAccount(tx, invoice.merchant_id);
      const clearingAccount = await getSystemAccountId(tx, 'PROVIDER_CLEARING_TOMAN');
      const revenueAccount = await getSystemAccountId(tx, 'PLATFORM_REVENUE_TOMAN');

      const lines: JournalLine[] = [
        { accountId: clearingAccount, debit: breakdown.customerTotal, bucket: 'AVAILABLE' },
        { accountId: merchantAccount, credit: breakdown.merchantNet, bucket: 'PENDING' },
      ];
      if (breakdown.platformFee.isPositive()) {
        lines.push({
          accountId: revenueAccount,
          credit: breakdown.platformFee,
          bucket: 'AVAILABLE' as const,
        });
      }

      // The provider's own cut, recognised as a platform expense against the
      // clearing asset. CubePay never settles us the full customerTotal — it
      // keeps ~9% — so booking only our 15% revenue would overstate margin.
      //
      // The merchant is untouched by this: their liability is already fixed by
      // the fee snapshot. Gross platform margin is therefore
      //   platformFee − providerFee
      // and both halves are visible in the ledger rather than netted silently.
      if (bookedFee.isPositive()) {
        const expenseAccount = await getSystemAccountId(tx, 'PLATFORM_EXPENSE_TOMAN');
        lines.push(
          { accountId: expenseAccount, debit: bookedFee, bucket: 'AVAILABLE' },
          { accountId: clearingAccount, credit: bookedFee, bucket: 'AVAILABLE' },
        );
      }

      const posting = await post(tx, {
        referenceType: 'PAYMENT',
        referenceId: paymentId,
        // Deterministic operation id: the same payment can never post twice.
        operationId: `payment:verified:${evidence.provider}:${evidence.externalPaymentId}`,
        description: `payment verified for invoice ${invoice.id}`,
        lines,
      });
      if (!posting.created) {
        throw new FinancialError(
          ErrorCodes.DUPLICATE_OPERATION,
          'ledger already contains this payment posting',
        );
      }

      // 8. Mark the invoice paid.
      const invoiceUpdate = await tx.query(
        `UPDATE core.invoices SET status = 'PAID', updated_at = NOW()
          WHERE id = $1 AND status = 'CREATED'`,
        [invoice.id],
      );
      if (invoiceUpdate.rowCount !== 1) {
        throw new ValidationError(ErrorCodes.INVOICE_NOT_PAYABLE, 'invoice changed state concurrently');
      }

      await storeEvidence(tx, paymentId, evidence);
      await recordTransition(tx, {
        entityType: 'PAYMENT',
        entityId: paymentId,
        fromState: null,
        event: 'VERIFY',
        toState: 'VERIFIED',
        actorType: 'PROVIDER',
        metadata: { amount: paidAmount.toAtomicString() },
      });
      await recordTransition(tx, {
        entityType: 'INVOICE',
        entityId: invoice.id,
        fromState: 'CREATED',
        event: 'PAY',
        toState: 'PAID',
        actorType: 'PROVIDER',
      });

      // 9. Outbox events, committed in the same transaction (SPEC 118.73).
      await enqueue(tx, {
        eventType: 'payment.verified',
        aggregateType: 'PAYMENT',
        aggregateId: paymentId,
        correlationId: input.correlationId,
        payload: {
          payment_id: paymentId,
          invoice_id: invoice.id,
          merchant_id: invoice.merchant_id,
          amount: paidAmount.toAtomicString(),
          merchant_net: breakdown.merchantNet.toAtomicString(),
          platform_fee: breakdown.platformFee.toAtomicString(),
          release_at: releaseAt.toISOString(),
        },
      });

      return {
        paymentId,
        status: 'VERIFIED' as const,
        credited: true,
        releaseAt: releaseAt.toISOString(),
        merchantNet: breakdown.merchantNet.toAtomicString(),
      };
    },
    { isolation: 'SERIALIZABLE', retries: 3 },
  );
}

async function insertPayment(
  tx: TransactionContext,
  params: {
    paymentId: string;
    invoice: { id: string; merchant_id: string; customer_total_amount: string };
    expectedAmount?: string;
    evidence: ProviderEvidence;
    status: string;
    verifiedAmount: string | null;
    verifiedPaidAt: string | null;
    releaseAt: string | null;
    mismatchCode: string | null;
    failureCode: string | null;
    providerFee?: {
      expected: string;
      actual: string | null;
      difference: string | null;
      status: 'CONFIG_ESTIMATED' | 'PROVIDER_CONFIRMED' | 'MISMATCH' | 'UNAVAILABLE';
      source: string;
    };
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO core.payments (
       id, invoice_id, merchant_id, provider, external_payment_id,
       expected_amount, verified_amount, currency, status,
       verified_paid_at, release_at, finalized_at, mismatch_code, failure_code,
       provider_fee_expected, provider_fee_actual, provider_fee_difference,
       provider_fee_status, provider_fee_source, provider_fee_verified_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'TOMAN',$8,$9,$10,NOW(),$11,$12,
       $13,$14,$15,$16,$17,CASE WHEN $14::numeric IS NULL THEN NULL ELSE NOW() END)`,
    [
      params.paymentId,
      params.invoice.id,
      params.invoice.merchant_id,
      params.evidence.provider,
      params.evidence.externalPaymentId,
      params.expectedAmount ?? params.invoice.customer_total_amount,
      params.verifiedAmount,
      params.status,
      params.verifiedPaidAt,
      params.releaseAt,
      params.mismatchCode,
      params.failureCode,
      params.providerFee?.expected ?? null,
      params.providerFee?.actual ?? null,
      params.providerFee?.difference ?? null,
      params.providerFee?.status ?? null,
      params.providerFee?.source ?? null,
    ],
  );
}

async function storeEvidence(
  tx: TransactionContext,
  paymentId: string,
  evidence: ProviderEvidence,
): Promise<void> {
  const raw = JSON.stringify(evidence.raw);
  await tx.query(
    `INSERT INTO integration.provider_evidence
        (id, payment_id, provider, kind, raw_payload, payload_hash)
     VALUES ($1,$2,$3,'CALLBACK',$4::jsonb,$5)`,
    [randomUUID(), paymentId, evidence.provider, raw, sha256Hex(raw)],
  );
}
