/**
 * SPEC 117.86 — the first tests to write: money arithmetic and fee calculation.
 * SPEC 103926: rounding must never create or destroy value.
 */

import { describe, it, expect } from 'vitest';
import { Money, Percentage, Rate, MoneyError } from '../../packages/money/src/index.ts';
import { calculateFees, calculateProviderCost } from '../../packages/core/src/fees.ts';
import {
  assertTomanWithinBounds,
  assertGramWithinBounds,
  MAX_TOMAN_ATOMIC,
  MAX_GRAM_ATOMIC,
} from '../../packages/core/src/limits.ts';

const FEE = { rate: Percentage.fromPercent(15), version: 'v1' };

describe('Money', () => {
  it('refuses floats entirely', () => {
    expect(() => Money.of(1.5, 'TOMAN')).toThrow(MoneyError);
    expect(() => Money.toman('1.5')).toThrow(MoneyError);
    expect(() => Money.toman(1000).multiply(0.15 as unknown as number)).toThrow(MoneyError);
  });

  it('refuses arithmetic across currencies', () => {
    expect(() => Money.toman(100).add(Money.gram(100))).toThrow(MoneyError);
  });

  it('handles amounts far beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const huge = Money.toman('99999999999999999999999999');
    expect(huge.add(Money.toman(1)).toAtomicString()).toBe('100000000000000000000000000');
  });

  it('parses decimal GRAM into nanoGRAM without loss', () => {
    expect(Money.parse('1.5', 'GRAM').toAtomicString()).toBe('1500000000');
    expect(Money.parse('0.000000001', 'GRAM').toAtomicString()).toBe('1');
    expect(() => Money.parse('0.0000000001', 'GRAM')).toThrow(MoneyError);
  });
});

describe('calculateFees', () => {
  // The invariant that must hold for every mode and every amount.
  const conserves = (b: ReturnType<typeof calculateFees>) =>
    b.customerTotal.subtract(b.platformFee).equals(b.merchantNet);

  it('CUSTOMER mode: buyer pays 115%, seller receives 100%', () => {
    const b = calculateFees(Money.toman(1_000_000), 'CUSTOMER', FEE);
    expect(b.customerTotal.toAtomicString()).toBe('1150000');
    expect(b.merchantNet.toAtomicString()).toBe('1000000');
    expect(b.platformFee.toAtomicString()).toBe('150000');
    expect(conserves(b)).toBe(true);
  });

  it('MERCHANT mode: buyer pays 100%, seller receives 85%', () => {
    const b = calculateFees(Money.toman(1_000_000), 'MERCHANT', FEE);
    expect(b.customerTotal.toAtomicString()).toBe('1000000');
    expect(b.merchantNet.toAtomicString()).toBe('850000');
    expect(b.platformFee.toAtomicString()).toBe('150000');
    expect(conserves(b)).toBe(true);
  });

  it('SPLIT mode: 7.5% each way — buyer pays 107.5%, seller gets 92.5%', () => {
    const b = calculateFees(Money.toman(1_000_000), 'SPLIT', FEE);
    expect(b.customerTotal.toAtomicString()).toBe('1075000');
    expect(b.merchantNet.toAtomicString()).toBe('925000');
    expect(b.platformFee.toAtomicString()).toBe('150000');
    expect(conserves(b)).toBe(true);
  });

  it('conserves value for awkward amounts in every mode', () => {
    // Amounts chosen to force rounding in the fee and in the split.
    for (const amount of [1n, 3n, 7n, 13n, 99n, 101n, 333n, 9_999n, 1_000_003n, 7_777_777n]) {
      for (const mode of ['CUSTOMER', 'MERCHANT', 'SPLIT'] as const) {
        const b = calculateFees(Money.toman(amount), mode, FEE);
        expect(conserves(b), `${mode} ${amount}`).toBe(true);
        // The fee halves must add back up to the whole fee.
        expect(b.customerFeeShare.add(b.merchantFeeShare).equals(b.platformFee)).toBe(true);
        // Nobody is ever owed a negative amount.
        expect(b.merchantNet.isNegative()).toBe(false);
        expect(b.platformFee.isNegative()).toBe(false);
      }
    }
  });
});

describe('Rate', () => {
  it('converts Toman to nanoGRAM exactly at a round rate', () => {
    const rate = Rate.of('100000', 'TEST');
    expect(rate.tomanToGram(Money.toman(1_000_000)).toAtomicString()).toBe('10000000000');
  });

  it('floors so a merchant is never paid more GRAM than their liability covers', () => {
    const rate = Rate.of('3', 'TEST');
    // 10 Toman / 3 = 3.333... GRAM -> floored at nanoGRAM precision.
    expect(rate.tomanToGram(Money.toman(10)).toAtomicString()).toBe('3333333333');
  });

  it('round-trips through its database representation', () => {
    const rate = Rate.of('123456.789', 'TEST');
    expect(Rate.fromDbString(rate.toDbString(), 'TEST').scaledTomanPerGram).toBe(
      rate.scaledTomanPerGram,
    );
  });

  it('rejects a zero or malformed rate', () => {
    expect(() => Rate.of('0', 'TEST')).toThrow(MoneyError);
    expect(() => Rate.of('abc', 'TEST')).toThrow(MoneyError);
  });
});

describe('provider cost (CubePay 9%)', () => {
  const PROVIDER = Percentage.fromPercent(9);

  it('is kept separate from the platform fee and never merged into one rate', () => {
    // MERCHANT mode on a 1,000,000 base: the customer pays the base, we credit
    // 850,000, CubePay keeps 90,000 of what it collects, so our real margin is
    // 150,000 − 90,000 = 60,000. The merchant only ever sees our 15%.
    const breakdown = calculateFees(Money.toman(1_000_000), 'MERCHANT', FEE);
    const cost = calculateProviderCost(breakdown.customerTotal, PROVIDER);

    expect(breakdown.customerTotal.toAtomicString()).toBe('1000000');
    expect(breakdown.merchantNet.toAtomicString()).toBe('850000');
    expect(breakdown.platformFee.toAtomicString()).toBe('150000');

    expect(cost.providerFee.toAtomicString()).toBe('90000');
    expect(cost.providerNet.toAtomicString()).toBe('910000');

    const grossMargin = cost.providerNet.subtract(breakdown.merchantNet);
    expect(grossMargin.toAtomicString()).toBe('60000');
  });

  it('charges the provider rate on what was actually collected, not on the base', () => {
    // CUSTOMER mode: the customer pays 1,150,000, so CubePay's 9% applies to
    // the larger figure — 103,500, not 90,000.
    const breakdown = calculateFees(Money.toman(1_000_000), 'CUSTOMER', FEE);
    const cost = calculateProviderCost(breakdown.customerTotal, PROVIDER);

    expect(breakdown.customerTotal.toAtomicString()).toBe('1150000');
    expect(cost.providerFee.toAtomicString()).toBe('103500');

    const grossMargin = cost.providerNet.subtract(breakdown.merchantNet);
    expect(grossMargin.toAtomicString()).toBe('46500');
  });

  it('rounds the cost up so platform margin is never flattered', () => {
    // 9% of 1,001 = 90.09 -> 91, never 90.
    const cost = calculateProviderCost(Money.toman(1_001), PROVIDER);
    expect(cost.providerFee.toAtomicString()).toBe('91');
  });

  it('conserves value: collected == fee + net', () => {
    for (const amount of [1n, 7n, 999n, 1_000_000n, 123_456_789n]) {
      const cost = calculateProviderCost(Money.toman(amount), PROVIDER);
      expect(cost.providerFee.add(cost.providerNet).toAtomicString()).toBe(amount.toString());
    }
  });

  it('refuses a negative collected amount', () => {
    expect(() => calculateProviderCost(Money.toman(-1), PROVIDER)).toThrow();
  });
});

describe('numeric bounds', () => {
  it('accepts an amount at the ceiling and rejects one past it', () => {
    expect(() => assertTomanWithinBounds(MAX_TOMAN_ATOMIC, 'amount')).not.toThrow();
    expect(() => assertTomanWithinBounds(MAX_TOMAN_ATOMIC + 1n, 'amount')).toThrow();

    expect(() => assertGramWithinBounds(MAX_GRAM_ATOMIC, 'amount')).not.toThrow();
    expect(() => assertGramWithinBounds(MAX_GRAM_ATOMIC + 1n, 'amount')).toThrow();
  });

  it('keeps Toman inside NUMERIC(30,0) even after a 115% customer total', () => {
    // The ceiling must leave room for the largest derived figure.
    const maxCustomerTotal = (MAX_TOMAN_ATOMIC * 115n) / 100n;
    expect(maxCustomerTotal.toString().length).toBeLessThanOrEqual(30);
  });

  it('keeps nanoGRAM inside NUMERIC(40,0)', () => {
    expect(MAX_GRAM_ATOMIC.toString().length).toBeLessThanOrEqual(40);
  });

  it('names the offending field so the caller can act on it', () => {
    expect(() => assertGramWithinBounds(MAX_GRAM_ATOMIC + 1n, 'funding amount')).toThrow(
      /funding amount/,
    );
  });

  it('rejects negatives outright', () => {
    expect(() => assertTomanWithinBounds(-1n, 'amount')).toThrow();
    expect(() => assertGramWithinBounds(-1n, 'amount')).toThrow();
  });
});
