/**
 * Fee engine — the single place where the 14% platform fee is computed.
 *
 * SPEC (03 · کارمزد / قواعد مالی):
 *   CUSTOMER : buyer pays 114% of base; merchant is owed 100% of base.
 *   MERCHANT : buyer pays 100%; 14% is deducted; merchant is owed 86%.
 *   SPLIT    : 7% to each side; customer pays 107%, merchant is owed 93%.
 *
 * SPEC 4334/4335 + "Snapshot": the rate and mode are frozen onto the invoice at
 * creation; later config changes must never alter an existing invoice.
 * SPEC 103900: `amount * 0.14` must never appear anywhere outside this module.
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
 * The provider's own cut, which is NOT the platform fee.
 *
 * CubePay charges ~9% of the amount it actually collects. The spec is explicit
 * that this must never be merged with our 14% into a single headline number for
 * the merchant: the merchant's contract is with us, and CubePay deducts its
 * cost from OUR receipts.
 *
 *     Invoice Amount − CubePay Fee = CubePay Net
 *     Base Amount    − Merchant Fee = Merchant Credit
 *     CubePay Net    − Merchant Credit = Platform Gross Margin
 *
 * Worked example (MERCHANT mode, 1,000,000 base, 14% platform, 9% provider):
 *     customer pays          1,000,000
 *     provider keeps            90,000
 *     we receive               910,000
 *     merchant is credited     860,000
 *     our gross margin          50,000
 *
 * Worked example (CUSTOMER mode, 1,000,000 base, 14% platform, 9% provider):
 *     customer pays          1,140,000
 *     provider keeps           102,600
 *     we receive             1,037,400
 *     merchant is credited   1,000,000
 *     our gross margin          37,400 (≈3.74% on base)
 *
 * Worked example (SPLIT mode, 1,000,000 base, 14% platform (7%+7%), 9% provider):
 *     customer pays          1,070,000
 *     provider keeps            96,300
 *     we receive               973,700
 *     merchant is credited     930,000
 *     our gross margin          43,700 (≈4.37% on base)
 */
export interface ProviderCostBreakdown {
  /** Amount the provider actually collected from the customer. */
  readonly collectedAmount: Money;
  /** The provider's fee on that amount — a platform expense, not merchant's. */
  readonly providerFee: Money;
  /** What the provider will settle to us. */
  readonly providerNet: Money;
  /** Snapshotted provider rate in basis points, e.g. 900 for 9%. */
  readonly providerFeeRateBps: bigint;
}

/**
 * Compute the provider's cost on a collected amount.
 *
 * Rounded CEIL deliberately: under-stating a cost we will actually be charged
 * would overstate platform margin, and the ledger must never flatter itself.
 */
export function calculateProviderCost(
  collectedAmount: Money,
  rate: Percentage,
): ProviderCostBreakdown {
  if (collectedAmount.currency !== 'TOMAN') {
    throw new ValidationError('PROVIDER_FEE_CURRENCY', 'provider fees are only defined for TOMAN', {
      currency: collectedAmount.currency,
    });
  }
  if (collectedAmount.isNegative()) {
    throw new ValidationError('PROVIDER_FEE_NEGATIVE_BASE', 'collected amount cannot be negative');
  }

  const providerFee = rate.applyTo(collectedAmount, 'CEIL');
  if (providerFee.compare(collectedAmount) > 0) {
    throw new ValidationError(
      'PROVIDER_FEE_EXCEEDS_COLLECTED',
      'provider fee cannot exceed the collected amount',
      { collected: collectedAmount.toAtomicString(), fee: providerFee.toAtomicString() },
    );
  }

  return Object.freeze({
    collectedAmount,
    providerFee,
    providerNet: collectedAmount.subtract(providerFee),
    providerFeeRateBps: rate.bps,
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
