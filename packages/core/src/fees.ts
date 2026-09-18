/**
 * Fee engine — the single place where the 15% platform fee is computed.
 *
 * SPEC (03 · کارمزد / قواعد مالی):
 *   CUSTOMER : buyer pays 115% of base; merchant is owed 100% of base.
 *   MERCHANT : buyer pays 100%; 15% is deducted; merchant is owed 85%.
 *   SPLIT    : 7.5% to each side; customer pays 107.5%, merchant is owed 92.5%.
 *
 * SPEC 4334/4335 + "Snapshot": the rate and mode are frozen onto the invoice at
 * creation; later config changes must never alter an existing invoice.
 * SPEC 103900: `amount * 0.15` must never appear anywhere outside this module.
 */

import { Money, Percentage, type Rounding } from '../../money/src/index.ts';
import { ValidationError } from '../../errors/src/index.ts';

export type FeeMode = 'CUSTOMER' | 'MERCHANT' | 'SPLIT';

export const FEE_MODES: readonly FeeMode[] = ['CUSTOMER', 'MERCHANT', 'SPLIT'];

export function isFeeMode(value: unknown): value is FeeMode {
  return typeof value === 'string' && (FEE_MODES as readonly string[]).includes(value);
}

/**
 * The immutable financial snapshot attached to an invoice.
 * Every downstream ledger posting reads these numbers and never recomputes them.
 */
export interface FeeBreakdown {
  /** The merchant's listed price. */
  readonly baseAmount: Money;
  /** What the customer is charged. */
  readonly customerTotal: Money;
  /** Platform revenue recognised on this invoice. */
  readonly platformFee: Money;
  /** Portion of the fee visibly added on top for the customer. */
  readonly customerFeeShare: Money;
  /** Portion of the fee deducted from the merchant. */
  readonly merchantFeeShare: Money;
  /** What the merchant is owed (their liability balance credit). */
  readonly merchantNet: Money;
  readonly feeMode: FeeMode;
  /** Snapshotted rate in basis points, e.g. 1500 for 15%. */
  readonly feeRateBps: bigint;
  /** Version of the fee policy used, for audit (SPEC 4333). */
  readonly feePolicyVersion: string;
}

export interface FeePolicy {
  readonly rate: Percentage;
  readonly version: string;
  /** Rounding for the fee itself. FLOOR never over-charges by a rounding unit. */
  readonly rounding?: Rounding;
}

/**
 * Compute the invoice financial snapshot.
 *
 * The identity that MUST hold for every mode and is asserted below:
 *   customerTotal - platformFee == merchantNet
 * i.e. every Toman the customer pays is either platform revenue or merchant liability.
 * Nothing is created or destroyed by rounding.
 */
export function calculateFees(
  baseAmount: Money,
  feeMode: FeeMode,
  policy: FeePolicy,
): FeeBreakdown {
  if (baseAmount.currency !== 'TOMAN') {
    throw new ValidationError('FEE_CURRENCY', 'fees are only defined for TOMAN invoices', {
      currency: baseAmount.currency,
    });
  }
  if (!baseAmount.isPositive()) {
    throw new ValidationError('FEE_NON_POSITIVE_BASE', 'base amount must be greater than zero');
  }
  if (!isFeeMode(feeMode)) {
    throw new ValidationError('FEE_UNKNOWN_MODE', `unknown fee mode: ${String(feeMode)}`);
  }

  const rounding = policy.rounding ?? 'FLOOR';
  const totalFee = policy.rate.applyTo(baseAmount, rounding);

  let customerFeeShare: Money;
  let merchantFeeShare: Money;

  switch (feeMode) {
    case 'CUSTOMER':
      customerFeeShare = totalFee;
      merchantFeeShare = Money.zero('TOMAN');
      break;
    case 'MERCHANT':
      customerFeeShare = Money.zero('TOMAN');
      merchantFeeShare = totalFee;
      break;
    case 'SPLIT': {
      // Half to the customer (FLOOR), remainder to the merchant, so the two
      // shares always re-sum to exactly totalFee with no lost unit.
      customerFeeShare = totalFee.mulDiv(1n, 2n, 'FLOOR');
      merchantFeeShare = totalFee.subtract(customerFeeShare);
      break;
    }
  }

  const customerTotal = baseAmount.add(customerFeeShare);
  const merchantNet = baseAmount.subtract(merchantFeeShare);
  const platformFee = customerFeeShare.add(merchantFeeShare);

  // Conservation invariant — a bug here would silently mint or burn money.
  if (!customerTotal.subtract(platformFee).equals(merchantNet)) {
    throw new ValidationError(
      'FEE_CONSERVATION_VIOLATION',
      'fee breakdown does not conserve value',
      {
        customerTotal: customerTotal.toAtomicString(),
        platformFee: platformFee.toAtomicString(),
        merchantNet: merchantNet.toAtomicString(),
      },
    );
  }
  if (merchantNet.isNegative()) {
    throw new ValidationError('FEE_EXCEEDS_BASE', 'fee cannot exceed the base amount');
  }

  return Object.freeze({
    baseAmount,
    customerTotal,
    platformFee,
    customerFeeShare,
    merchantFeeShare,
    merchantNet,
    feeMode,
    feeRateBps: policy.rate.bps,
    feePolicyVersion: policy.version,
  });
}

/**
 * Rebuild a breakdown from persisted invoice columns instead of recomputing it.
 * SPEC 4335: an old invoice keeps its own snapshot even after the policy changes.
 */
export function feeBreakdownFromSnapshot(row: {
  base_amount: string;
  customer_total_amount: string;
  platform_fee_amount: string;
  merchant_net_amount: string;
  customer_fee_share: string;
  merchant_fee_share: string;
  fee_mode: string;
  fee_rate_bps: string;
  fee_policy_version: string;
}): FeeBreakdown {
  if (!isFeeMode(row.fee_mode)) {
    throw new ValidationError('FEE_UNKNOWN_MODE', `unknown persisted fee mode: ${row.fee_mode}`);
  }
  return Object.freeze({
    baseAmount: Money.toman(row.base_amount),
    customerTotal: Money.toman(row.customer_total_amount),
    platformFee: Money.toman(row.platform_fee_amount),
    customerFeeShare: Money.toman(row.customer_fee_share),
    merchantFeeShare: Money.toman(row.merchant_fee_share),
    merchantNet: Money.toman(row.merchant_net_amount),
    feeMode: row.fee_mode,
    feeRateBps: BigInt(row.fee_rate_bps),
    feePolicyVersion: row.fee_policy_version,
  });
}
