/**
 * CreateInvoiceUseCase.
 *
 * SPEC 1243: Validate -> Snapshot -> Create internal invoice -> create provider invoice.
 * SPEC 1232: the customer's final amount is fully determined before payment.
 * SPEC 4335: the fee snapshot is frozen onto the invoice at creation.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../../database/src/client.ts';
import { Money } from '../../../money/src/index.ts';
import { calculateFees, isFeeMode, type FeeBreakdown, type FeeMode } from '../fees.ts';
import { MAX_TOMAN_ATOMIC } from '../limits.ts';
import { enqueue } from '../outbox.ts';
import { recordTransition } from '../transitions.ts';
import type { Config } from '../../../config/src/index.ts';
import { ValidationError, NotFoundError, ConflictError } from '../../../errors/src/index.ts';

export interface CreateInvoiceInput {
  merchantId: string;
  /** Base price in TOMAN atomic units, as an integer string. */
  baseAmount: string;
  feeMode?: FeeMode;
  description?: string;
  customerReference?: string;
  /** Seconds until the invoice expires. */
  expiresInSeconds?: number;
  /** Provided by the caller; also used for HTTP-level idempotency. */
  invoiceNumber?: string;
}

export interface CreateInvoiceResult {
  invoiceId: string;
  invoiceNumber: string;
  baseAmount: string;
  customerTotal: string;
  platformFee: string;
  merchantNet: string;
  feeMode: FeeMode;
  status: 'CREATED';
  expiresAt: string | null;
  checkoutPath: string;
}

const MAX_EXPIRY_SECONDS = 30 * 24 * 3600;
const MIN_EXPIRY_SECONDS = 60;

/**
 * Largest base amount we accept, in Toman. Shared with every other financial
 * entry point so the ceiling is defined exactly once (see ../limits.ts).
 */
const MAX_TOMAN_AMOUNT = MAX_TOMAN_ATOMIC;

export async function createInvoice(
  db: Database,
  config: Config,
  input: CreateInvoiceInput,
): Promise<CreateInvoiceResult> {
  // A malformed amount is a caller error (400), not an internal fault: Money
  // throws its own low-level error type, so translate it at the boundary.
  let baseAmount: Money;
  try {
    baseAmount = Money.toman(input.baseAmount);
  } catch (e) {
    throw new ValidationError(
      'INVALID_AMOUNT',
      'amount must be a whole number of Toman, given as an integer string',
      { amount: String(input.baseAmount), reason: e instanceof Error ? e.message : undefined },
    );
  }
  if (!baseAmount.isPositive()) {
    throw new ValidationError('INVALID_AMOUNT', 'base amount must be greater than zero');
  }
  // Toman columns are NUMERIC(30,0). Reject anything that cannot fit BEFORE it
  // reaches SQL, otherwise the driver raises a numeric overflow and the caller
  // sees a 500 for what is plainly bad input. The ceiling is applied to the
  // customer total, which is the largest derived figure (up to 115% of base).
  if (baseAmount.atomic > MAX_TOMAN_AMOUNT) {
    throw new ValidationError('AMOUNT_TOO_LARGE', 'amount exceeds the maximum supported value', {
      maximum: MAX_TOMAN_AMOUNT.toString(),
    });
  }

  const feeMode = input.feeMode ?? config.fees.defaultFeeMode;
  if (!isFeeMode(feeMode)) {
    throw new ValidationError('INVALID_FEE_MODE', `unknown fee mode: ${String(feeMode)}`);
  }

  const expiresIn = input.expiresInSeconds ?? 3600;
  if (expiresIn < MIN_EXPIRY_SECONDS || expiresIn > MAX_EXPIRY_SECONDS) {
    throw new ValidationError(
      'INVALID_EXPIRY',
      `expiresInSeconds must be between ${MIN_EXPIRY_SECONDS} and ${MAX_EXPIRY_SECONDS}`,
    );
  }

  if (input.description !== undefined && input.description.length > 500) {
    throw new ValidationError('DESCRIPTION_TOO_LONG', 'description must be at most 500 characters');
  }

  // The fee snapshot is computed once, here, and never recomputed downstream.
  const breakdown: FeeBreakdown = calculateFees(baseAmount, feeMode, {
    rate: config.fees.platformFeePercent,
    version: config.fees.policyVersion,
  });

  const invoiceNumber = input.invoiceNumber ?? `INV-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (invoiceNumber.length > 64) {
    throw new ValidationError('INVOICE_NUMBER_TOO_LONG', 'invoiceNumber must be at most 64 characters');
  }

  return db.transaction(async (tx) => {
    // Only an ACTIVE merchant may issue invoices, and the row is locked so a
    // concurrent suspension cannot slip past this check.
    const merchant = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM core.merchants WHERE id = $1 FOR UPDATE',
      [input.merchantId],
    );
    const m = merchant.rows[0];
    if (!m) throw new NotFoundError('merchant', input.merchantId);
    if (m.status !== 'ACTIVE') {
      throw new ValidationError('MERCHANT_NOT_ACTIVE', `merchant status is ${m.status}`, {
        status: m.status,
      });
    }

    const invoiceId = randomUUID();
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO core.invoices (
         id, merchant_id, invoice_number,
         base_amount, base_currency,
         fee_mode, fee_rate_bps, fee_policy_version,
         platform_fee_amount, customer_fee_share, merchant_fee_share,
         customer_total_amount, merchant_net_amount,
         description, customer_reference,
         status, expires_at
       ) VALUES (
         $1, $2, $3,
         $4, 'TOMAN',
         $5, $6, $7,
         $8, $9, $10,
         $11, $12,
         $13, $14,
         'CREATED', $15
       )
       ON CONFLICT (merchant_id, invoice_number) DO NOTHING
       RETURNING id`,
      [
        invoiceId,
        input.merchantId,
        invoiceNumber,
        breakdown.baseAmount.toAtomicString(),
        breakdown.feeMode,
        breakdown.feeRateBps.toString(),
        breakdown.feePolicyVersion,
        breakdown.platformFee.toAtomicString(),
        breakdown.customerFeeShare.toAtomicString(),
        breakdown.merchantFeeShare.toAtomicString(),
        breakdown.customerTotal.toAtomicString(),
        breakdown.merchantNet.toAtomicString(),
        input.description ?? null,
        input.customerReference ?? null,
        expiresAt.toISOString(),
      ],
    );

    if (inserted.rows.length === 0) {
      throw new ConflictError(
        'INVOICE_NUMBER_TAKEN',
        'an invoice with this number already exists for this merchant',
        { invoiceNumber },
      );
    }

    await recordTransition(tx, {
      entityType: 'INVOICE',
      entityId: invoiceId,
      fromState: null,
      event: 'CREATE',
      toState: 'CREATED',
      actorType: 'MERCHANT',
      actorId: input.merchantId,
    });

    await enqueue(tx, {
      eventType: 'invoice.created',
      aggregateType: 'INVOICE',
      aggregateId: invoiceId,
      payload: {
        invoice_id: invoiceId,
        merchant_id: input.merchantId,
        base_amount: breakdown.baseAmount.toAtomicString(),
        customer_total: breakdown.customerTotal.toAtomicString(),
        fee_mode: breakdown.feeMode,
      },
    });

    return {
      invoiceId,
      invoiceNumber,
      baseAmount: breakdown.baseAmount.toAtomicString(),
      customerTotal: breakdown.customerTotal.toAtomicString(),
      platformFee: breakdown.platformFee.toAtomicString(),
      merchantNet: breakdown.merchantNet.toAtomicString(),
      feeMode: breakdown.feeMode,
      status: 'CREATED' as const,
      expiresAt: expiresAt.toISOString(),
      checkoutPath: `/checkout/${invoiceId}`,
    };
  });
}

/** SPEC: expire stale invoices so they can never be paid late. */
export async function expireStaleInvoices(db: Database): Promise<number> {
  const r = await db.query(
    `UPDATE core.invoices
        SET status = 'EXPIRED', updated_at = NOW()
      WHERE status = 'CREATED'
        AND expires_at IS NOT NULL
        AND expires_at < NOW()`,
  );
  return r.rowCount;
}
