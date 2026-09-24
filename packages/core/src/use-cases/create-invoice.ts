/**
 * CreateInvoiceUseCase.
 *
 * SPEC 1243: Validate -> Snapshot -> Create internal invoice -> create payment intent.
 * SPEC 1232: the customer's final amount is fully determined before payment.
 * SPEC 4335: the fee snapshot is frozen onto the invoice at creation.
 * SPEC v3.3: Canonical PaymentIntent lifecycle and DB-backed provider mode resolution.
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
  /** Optional override for provider mode (default comes from config.cubepay.activeMode). */
  providerMode?: 'VIP' | 'STANDARD';
}

export interface CreateInvoiceResult {
  invoiceId: string;
  paymentIntentId: string;
  invoiceNumber: string;
  baseAmount: string;
  customerTotal: string;
  platformFee: string;
  merchantNet: string;
  feeMode: FeeMode;
  provider: string;
  providerMode: 'VIP' | 'STANDARD';
  providerVersion: string;
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

  if (baseAmount.atomic > MAX_TOMAN_AMOUNT) {
    throw new ValidationError('AMOUNT_TOO_LARGE', 'amount exceeds the maximum supported value', {
      maximum: MAX_TOMAN_AMOUNT.toString(),
    });
  }

  if (input.feeMode !== undefined && !isFeeMode(input.feeMode)) {
    throw new ValidationError('INVALID_FEE_MODE', `unknown fee mode: ${String(input.feeMode)}`);
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

  const invoiceNumber = input.invoiceNumber ?? `INV-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (invoiceNumber.length > 64) {
    throw new ValidationError('INVOICE_NUMBER_TOO_LONG', 'invoiceNumber must be at most 64 characters');
  }

  return db.transaction(async (tx) => {
    // 1. Lock merchant and verify status
    const merchant = await tx.query<{ id: string; status: string; default_fee_mode: string }>(
      'SELECT id, status, default_fee_mode FROM core.merchants WHERE id = $1 FOR UPDATE',
      [input.merchantId],
    );
    const m = merchant.rows[0];
    if (!m) throw new NotFoundError('merchant', input.merchantId);
    if (m.status !== 'ACTIVE') {
      throw new ValidationError('MERCHANT_NOT_ACTIVE', `merchant status is ${m.status}`, {
        status: m.status,
      });
    }

    const merchantDefault = isFeeMode(m.default_fee_mode) ? m.default_fee_mode : undefined;
    const feeMode: FeeMode = input.feeMode ?? merchantDefault ?? config.fees.defaultFeeMode;

    const breakdown: FeeBreakdown = calculateFees(baseAmount, feeMode, {
      rate: config.fees.platformFeePercent,
      version: config.fees.policyVersion,
    });

    const invoiceId = randomUUID();
    const paymentIntentId = randomUUID();
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const provider = 'CUBEPAY';

    // 2. Query authoritative DB runtime state for active mode if not explicitly overridden
    let activeMode = input.providerMode;
    if (!activeMode) {
      if (config.cubepay?.activeMode === 'STANDARD') {
        activeMode = 'STANDARD';
      } else {
        const modeRes = await tx.query<{ active_mode: string }>(
          `SELECT active_mode FROM core.provider_runtime_state WHERE provider_name = 'CUBEPAY'`,
        );
        if (modeRes.rows.length > 0 && modeRes.rows[0]?.active_mode) {
          activeMode = modeRes.rows[0].active_mode.toUpperCase() as 'VIP' | 'STANDARD';
        } else {
          activeMode = config.cubepay.activeMode ?? 'VIP';
        }
      }
    }
    const providerMode: 'VIP' | 'STANDARD' = activeMode === 'STANDARD' ? 'STANDARD' : 'VIP';
    const providerVersion = providerMode === 'VIP' ? '2026-09-VIP' : '2026-09-STANDARD';
    const providerConfigRef = `${provider}_${providerMode}_${config.fees.policyVersion}`;

    // 3. Insert internal invoice with immutable provider snapshot
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO core.invoices (
         id, merchant_id, invoice_number,
         base_amount, base_currency,
         fee_mode, fee_rate_bps, fee_policy_version,
         platform_fee_amount, customer_fee_share, merchant_fee_share,
         customer_total_amount, merchant_net_amount,
         description, customer_reference,
         provider, provider_mode, provider_version, provider_config_ref,
         status, expires_at
       ) VALUES (
         $1, $2, $3,
         $4, 'TOMAN',
         $5, $6, $7,
         $8, $9, $10,
         $11, $12,
         $13, $14,
         $15, $16, $17, $18,
         'CREATED', $19
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
        provider,
        providerMode,
        providerVersion,
        providerConfigRef,
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

    // 4. Create canonical PaymentIntent
    await tx.query(
      `INSERT INTO core.payment_intents (
         id, invoice_id, merchant_id, amount_toman, currency, status
       ) VALUES ($1, $2, $3, $4, 'TOMAN', 'REQUIRES_PAYMENT')`,
      [
        paymentIntentId,
        invoiceId,
        input.merchantId,
        breakdown.customerTotal.toAtomicString(),
      ],
    );

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
        payment_intent_id: paymentIntentId,
        merchant_id: input.merchantId,
        base_amount: breakdown.baseAmount.toAtomicString(),
        customer_total: breakdown.customerTotal.toAtomicString(),
        fee_mode: breakdown.feeMode,
        provider,
        provider_mode: providerMode,
      },
    });

    return {
      invoiceId,
      paymentIntentId,
      invoiceNumber,
      baseAmount: breakdown.baseAmount.toAtomicString(),
      customerTotal: breakdown.customerTotal.toAtomicString(),
      platformFee: breakdown.platformFee.toAtomicString(),
      merchantNet: breakdown.merchantNet.toAtomicString(),
      feeMode: breakdown.feeMode,
      provider,
      providerMode,
      providerVersion,
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

/**
 * Cancel an invoice.
 */
export async function cancelInvoice(
  db: Database,
  params: { merchantId: string; invoiceId: string; reason?: string },
): Promise<{ invoiceId: string; status: 'CANCELLED'; alreadyCancelled: boolean }> {
  return db.transaction(async (tx) => {
    const r = await tx.query<{ id: string; merchant_id: string; status: string }>(
      'SELECT id, merchant_id, status FROM core.invoices WHERE id = $1 FOR UPDATE',
      [params.invoiceId],
    );
    const invoice = r.rows[0];
    if (!invoice) throw new NotFoundError('invoice', params.invoiceId);

    if (invoice.merchant_id !== params.merchantId) {
      throw new NotFoundError('invoice', params.invoiceId);
    }

    if (invoice.status === 'CANCELLED') {
      return { invoiceId: invoice.id, status: 'CANCELLED' as const, alreadyCancelled: true };
    }

    if (invoice.status !== 'CREATED') {
      throw new ConflictError(
        'INVOICE_NOT_CANCELLABLE',
        `an invoice in status ${invoice.status} cannot be cancelled`,
        { status: invoice.status },
      );
    }

    const payment = await tx.query<{ id: string }>(
      `SELECT id FROM core.payments
        WHERE invoice_id = $1 AND status IN ('VERIFIED','PENDING','REVIEW')`,
      [params.invoiceId],
    );
    if (payment.rows.length > 0) {
      throw new ConflictError(
        'INVOICE_HAS_PAYMENT',
        'this invoice already has a payment in progress or verified',
      );
    }

    await tx.query(
      `UPDATE core.invoices SET status = 'CANCELLED', updated_at = NOW()
        WHERE id = $1 AND status = 'CREATED'`,
      [params.invoiceId],
    );

    await tx.query(
      `UPDATE core.payment_intents SET status = 'CANCELLED', updated_at = NOW()
        WHERE invoice_id = $1`,
      [params.invoiceId],
    );

    await recordTransition(tx, {
      entityType: 'INVOICE',
      entityId: params.invoiceId,
      fromState: 'CREATED',
      toState: 'CANCELLED',
      event: 'CANCEL',
      actorType: 'MERCHANT',
      metadata: params.reason ? { reason: params.reason.slice(0, 200) } : {},
    });

    await enqueue(tx, {
      eventType: 'invoice.cancelled',
      aggregateType: 'INVOICE',
      aggregateId: params.invoiceId,
      payload: { invoice_id: params.invoiceId, merchant_id: params.merchantId },
    });

    return { invoiceId: invoice.id, status: 'CANCELLED' as const, alreadyCancelled: false };
  });
}
