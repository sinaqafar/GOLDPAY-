/**
 * Liquidity-fit selection. The policy is pure, so these are exact.
 */

import { describe, it, expect } from 'vitest';
import {
  selectByLiquidityFit,
  type LiquidityCandidate,
} from '../../packages/core/src/use-cases/payout.ts';

const make = (id: string, gram: bigint, ageSeconds = 0): LiquidityCandidate => ({
  payoutId: id,
  merchantId: `m-${id}`,
  gramAtomic: gram,
  ageSeconds,
});

describe('liquidity fit', () => {
  it('pays two merchants instead of one, given the spec example', () => {
    // 1000 spendable, payouts of 900/600/400. Oldest-first pays only A and
    // leaves 100 idle; B+C pays two merchants and uses everything.
    const selected = selectByLiquidityFit(
      [make('A', 900n, 300), make('B', 600n, 200), make('C', 400n, 100)],
      1000n,
    );

    const ids = selected.map((s) => s.payoutId).sort();
    expect(ids).toEqual(['B', 'C']);
    expect(selected.reduce((sum, s) => sum + s.gramAtomic, 0n)).toBe(1000n);
  });

  it('never selects more than the treasury can cover', () => {
    const selected = selectByLiquidityFit(
      [make('A', 700n), make('B', 600n), make('C', 500n)],
      1000n,
    );
    expect(selected.reduce((sum, s) => sum + s.gramAtomic, 0n)).toBeLessThanOrEqual(1000n);
  });

  it('skips a payout larger than the whole spendable balance', () => {
    const selected = selectByLiquidityFit([make('BIG', 5000n)], 1000n);
    expect(selected).toHaveLength(0);
  });

  it('takes a starved payout first even when smaller ones pack better', () => {
    // A has waited two hours. Without anti-starvation it loses to B+C every
    // cycle and is never paid at all.
    const selected = selectByLiquidityFit(
      [make('A', 900n, 7200), make('B', 600n, 60), make('C', 400n, 30)],
      1000n,
      { starvationSeconds: 3600 },
    );

    expect(selected.map((s) => s.payoutId)).toContain('A');
    // And having taken it, only 100 remains, so nothing else fits.
    expect(selected.reduce((sum, s) => sum + s.gramAtomic, 0n)).toBe(900n);
  });

  it('prefers the older of two equally sized payouts', () => {
    const selected = selectByLiquidityFit(
      [make('NEW', 500n, 10), make('OLD', 500n, 500)],
      500n,
    );
    expect(selected.map((s) => s.payoutId)).toEqual(['OLD']);
  });

  it('returns nothing when there is no liquidity', () => {
    expect(selectByLiquidityFit([make('A', 100n)], 0n)).toHaveLength(0);
  });

  it('ignores a zero-amount payout', () => {
    expect(selectByLiquidityFit([make('ZERO', 0n)], 1000n)).toHaveLength(0);
  });

  it('caps how many it takes in one pass', () => {
    const many = Array.from({ length: 50 }, (_, i) => make(`p${i}`, 10n, i));
    const selected = selectByLiquidityFit(many, 100_000n, { maxSelected: 5 });
    expect(selected).toHaveLength(5);
  });

  it('never selects the same payout twice', () => {
    const selected = selectByLiquidityFit(
      [make('A', 300n, 7200), make('B', 300n, 60), make('C', 300n, 30)],
      900n,
      { starvationSeconds: 3600 },
    );
    const ids = selected.map((s) => s.payoutId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
