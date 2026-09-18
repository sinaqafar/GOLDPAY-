/**
 * Risk scoring. Pure function, so these are exact.
 */

import { describe, it, expect } from 'vitest';
import {
  scorePayment,
  levelFor,
  decisionFor,
  DEFAULT_THRESHOLDS,
} from '../../packages/core/src/risk.ts';

const baseline = {
  merchantId: 'm1',
  paymentId: 'p1',
  amountAtomic: 1_000_000n,
  merchantAgeDays: 365,
  priorPaymentCount: 500,
  recentFailures: 0,
  paymentsLastHour: 2,
  amountMismatch: false,
  walletChangedRecently: false,
};

describe('risk scoring', () => {
  it('scores an ordinary payment as ALLOW with no signals', () => {
    const result = scorePayment(baseline);
    expect(result.score).toBe(0);
    expect(result.level).toBe('LOW');
    expect(result.decision).toBe('ALLOW');
    expect(result.signals).toHaveLength(0);
  });

  it('compounds merchant age with amount rather than judging them separately', () => {
    // A new merchant taking a small payment is mildly interesting...
    const small = scorePayment({ ...baseline, merchantAgeDays: 2, amountAtomic: 1_000_000n });
    // ...the same merchant taking a large one is the bust-out pattern.
    const large = scorePayment({ ...baseline, merchantAgeDays: 2, amountAtomic: 90_000_000n });

    expect(large.score).toBeGreaterThan(small.score);
    expect(large.signals.find((s) => s.code === 'NEW_MERCHANT')?.weight).toBe(30);
  });

  it('flags a large first payment', () => {
    const result = scorePayment({
      ...baseline,
      priorPaymentCount: 0,
      amountAtomic: 30_000_000n,
    });
    expect(result.signals.map((s) => s.code)).toContain('LARGE_FIRST_PAYMENT');
  });

  it('treats a recent wallet change as serious', () => {
    // Money about to go to an address that changed minutes ago is the
    // signature of a compromised account.
    const result = scorePayment({ ...baseline, walletChangedRecently: true });
    expect(result.signals.find((s) => s.code === 'RECENT_WALLET_CHANGE')?.weight).toBe(30);
  });

  it('reaches REVIEW when several signals combine', () => {
    const result = scorePayment({
      ...baseline,
      merchantAgeDays: 1,
      priorPaymentCount: 0,
      amountAtomic: 80_000_000n,
      walletChangedRecently: true,
    });
    expect(result.decision).toBe('REVIEW');
    expect(result.level).toBe('HIGH');
  });

  it('never exceeds 100 however many signals fire', () => {
    const result = scorePayment({
      merchantId: 'm',
      paymentId: 'p',
      amountAtomic: 999_000_000n,
      merchantAgeDays: 0,
      priorPaymentCount: 0,
      recentFailures: 50,
      paymentsLastHour: 500,
      amountMismatch: true,
      walletChangedRecently: true,
    });
    expect(result.score).toBe(100);
  });

  it('explains itself: every signal carries a code and a weight', () => {
    // A decision a merchant cannot be told the reason for is not acceptable.
    const result = scorePayment({ ...baseline, merchantAgeDays: 1, amountAtomic: 80_000_000n });
    for (const signal of result.signals) {
      expect(signal.code).toMatch(/^[A-Z_]+$/);
      expect(signal.weight).toBeGreaterThan(0);
    }
  });

  it('maps levels and decisions at the documented boundaries', () => {
    expect(levelFor(29)).toBe('LOW');
    expect(levelFor(30)).toBe('MEDIUM');
    expect(levelFor(70)).toBe('HIGH');

    expect(decisionFor(39)).toBe('ALLOW');
    expect(decisionFor(40)).toBe('MONITOR');
    expect(decisionFor(70)).toBe('REVIEW');
  });

  it('honours configured thresholds instead of hardcoding them', () => {
    const strict = { review: 20, monitor: 10 };
    expect(decisionFor(25, strict)).toBe('REVIEW');
    expect(decisionFor(25, DEFAULT_THRESHOLDS)).toBe('ALLOW');
  });

  it('offers no decision that blocks (SPEC 1415)', () => {
    // The strongest outcome is REVIEW. The engine may pause, never seize.
    for (let score = 0; score <= 100; score++) {
      expect(['ALLOW', 'MONITOR', 'REVIEW']).toContain(decisionFor(score));
    }
  });
});
