/**
 * Hardening checks.
 *
 * These assert the defensive properties that are easy to regress silently:
 * secret redaction, error-message leakage, guarded SQL identifiers and
 * float-free rate parsing.
 */

import { describe, it, expect } from 'vitest';
import { redact, createLogger } from '../../packages/core/src/logger.ts';
import { toErrorResponse } from '../../apps/api/src/http.ts';
import { silentLogger } from '../../packages/core/src/logger.ts';
import { transitionState } from '../../packages/core/src/transitions.ts';
import { StaticRateProvider } from '../../packages/core/src/adapters/rate-provider.ts';
import {
  RateAggregator,
  StaticCryptoMarketProvider,
  StaticFxProvider,
} from '../../packages/core/src/adapters/rate-aggregator.ts';
import type { CryptoMarketProvider } from '../../packages/core/src/ports/market-data.ts';
import { AppError, ValidationError, FinancialError } from '../../packages/errors/src/index.ts';

describe('log redaction', () => {
  it('masks every flavour of secret-bearing key', () => {
    const out = redact({
      apiKey: 'sk_live_supersecret',
      api_secret: 'shhh',
      password: 'hunter2',
      token: 'ghp_aaa',
      authorization: 'Bearer abc',
      signature: 'deadbeef',
      secret_hash: 'scrypt$xyz',
      merchantId: 'm-1',
      amount: '1000',
    }) as Record<string, unknown>;

    for (const key of [
      'apiKey',
      'api_secret',
      'password',
      'token',
      'authorization',
      'signature',
      'secret_hash',
    ]) {
      expect(String(out[key]), `${key} must be redacted`).not.toContain('secret');
      expect(out[key]).toBe('[redacted]');
    }
    // Non-sensitive fields survive, otherwise logs would be useless.
    expect(out['merchantId']).toBe('m-1');
    expect(out['amount']).toBe('1000');
  });

  it('redacts nested objects and arrays', () => {
    const out = redact({
      merchant: { name: 'shop', credentials: { apiSecret: 'leak-me' } },
      events: [{ token: 'leak-me-too' }],
    }) as { merchant: { credentials: Record<string, unknown> }; events: Record<string, unknown>[] };

    expect(out.merchant.credentials['apiSecret']).toBe('[redacted]');
    expect((out.events[0] as Record<string, unknown>)['token']).toBe('[redacted]');
  });

  it('does not emit a raw secret through a real logger', () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      createLogger({ service: 'test', level: 'info' }).info('auth.attempt', {
        apiSecret: 'sk_live_TOPSECRET',
        merchantId: 'm-1',
      });
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
    }

    expect(lines.join('\n')).not.toContain('TOPSECRET');
    expect(lines.join('\n')).toContain('m-1');
  });
});

describe('error responses', () => {
  it('never leaks an unexpected error message or stack to the client', () => {
    const boom = new Error('connection string postgres://user:pa55w0rd@db/main failed');
    const res = toErrorResponse(boom, silentLogger, 'req-1');

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('pa55w0rd');
    expect(body).not.toContain('postgres://');
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'internal error', retryable: true },
    });
  });

  it('surfaces typed errors with a safe projection only', () => {
    const err = new ValidationError('INVALID_AMOUNT', 'amount must be a whole number of Toman', {
      details: { internalHint: 'do-not-leak' },
    });
    const res = toErrorResponse(err, silentLogger, 'req-2');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('do-not-leak');
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_AMOUNT');
  });

  it('maps each category to the right status', () => {
    const cases: [AppError, number][] = [
      [new ValidationError('X', 'x'), 400],
      [new AppError('X', 'AUTH', 'x'), 401],
      [new AppError('X', 'SECURITY', 'x'), 403],
      [new AppError('X', 'NOT_FOUND', 'x'), 404],
      [new AppError('X', 'CONFLICT', 'x'), 409],
      [new FinancialError('X', 'x'), 422],
    ];
    for (const [err, status] of cases) {
      expect(toErrorResponse(err, silentLogger, 'r').status).toBe(status);
    }
  });
});

describe('guarded SQL identifiers', () => {
  it('refuses a table that is not on the allow-list', async () => {
    const fakeTx = {
      query: async () => {
        throw new Error('the query should never be reached');
      },
    };

    await expect(
      transitionState(fakeTx as never, {
        table: 'core.invoices; DROP TABLE core.payments; --',
        entityType: 'INVOICE',
        entityId: 'x',
        fromState: 'PENDING',
        toState: 'PAID',
        event: 'invoice.paid',
      }),
    ).rejects.toThrow(/allow-listed/);
  });
});

describe('rate parsing without floats', () => {
  it('rejects zero written in any form', async () => {
    for (const bad of ['0', '0.0', '0.000000000000000000']) {
      expect(() => new StaticRateProvider(bad)).toThrow(/greater than zero/);
    }
  });

  it('rejects non-numeric and signed input', () => {
    for (const bad of ['-1', 'abc', '1e5', '', ' 1 ', 'Infinity', 'NaN']) {
      expect(() => new StaticRateProvider(bad), `${bad} must be rejected`).toThrow();
    }
  });

  it('accepts a rate too small to survive a float round-trip', async () => {
    // 0.000000000000000001 is fine as a decimal string; naive float handling
    // would have compared it against zero after rounding.
    const provider = new StaticRateProvider('0.000000000000000001');
    const quote = await provider.getQuote();
    expect(quote.tomanPerGram).toBe('0.000000000000000001');
  });

  it('accepts a realistic GRAM rate', async () => {
    const provider = new StaticRateProvider('75000000');
    expect((await provider.getQuote()).tomanPerGram).toBe('75000000');
  });
});

describe('amount ceiling', () => {
  it('rejects an amount too large for the NUMERIC(30,0) columns', async () => {
    const { createInvoice } = await import('../../packages/core/src/use-cases/create-invoice.ts');
    const explodingDb = {
      transaction: async () => {
        throw new Error('validation must happen before any SQL runs');
      },
    };

    await expect(
      createInvoice(explodingDb as never, { fees: { platformFeePercent: null } } as never, {
        merchantId: 'm-1',
        baseAmount: '9'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE' });
  });
});

describe('RateAggregator (GRAM/USD × USD/TOMAN)', () => {
  const at = (iso: string) => () => new Date(iso);
  const NOW = '2026-01-01T12:00:00.000Z';

  it('derives TOMAN/GRAM from the two legs', async () => {
    const aggregator = new RateAggregator({
      cryptoSources: [new StaticCryptoMarketProvider('2.5', { now: at(NOW) })],
      fxSources: [new StaticFxProvider('80000', { now: at(NOW) })],
      now: at(NOW),
    });

    const quote = await aggregator.getQuote();
    // 2.5 USD per GRAM × 80,000 Toman per USD = 200,000 Toman per GRAM.
    expect(quote.tomanPerGram).toBe('200000');
    // Both legs are named, so a payout can be traced back to what priced it.
    expect(quote.source).toBe('STATIC_CRYPTO*STATIC_FX');
  });

  it('keeps fractional precision without floating point', async () => {
    const aggregator = new RateAggregator({
      cryptoSources: [new StaticCryptoMarketProvider('0.1', { now: at(NOW) })],
      fxSources: [new StaticFxProvider('91234.567', { now: at(NOW) })],
      now: at(NOW),
    });
    const quote = await aggregator.getQuote();
    expect(quote.tomanPerGram).toBe('9123.4567');
  });

  it('falls over to the next source when the first fails', async () => {
    const broken: CryptoMarketProvider = {
      name: 'BROKEN',
      async getGramUsd() {
        throw new Error('upstream down');
      },
    };
    const aggregator = new RateAggregator({
      cryptoSources: [broken, new StaticCryptoMarketProvider('3', { name: 'BACKUP', now: at(NOW) })],
      fxSources: [new StaticFxProvider('100000', { now: at(NOW) })],
      now: at(NOW),
    });

    const quote = await aggregator.getQuote();
    expect(quote.tomanPerGram).toBe('300000');
    expect(quote.source).toContain('BACKUP');
  });

  it('refuses a stale observation rather than pricing off it', async () => {
    // The upstream last updated an hour ago; the limit is 15 minutes.
    const aggregator = new RateAggregator({
      cryptoSources: [
        new StaticCryptoMarketProvider('2', { now: at('2026-01-01T11:00:00.000Z') }),
      ],
      fxSources: [new StaticFxProvider('100000', { now: at(NOW) })],
      maxObservationAgeSeconds: 900,
      now: at(NOW),
    });

    // No fallback exists, so this surfaces as unavailable — which becomes
    // WAITING_RATE upstream, never a silent stale price.
    await expect(aggregator.getQuote()).rejects.toThrow(/no usable GRAM\/USD source/);
  });

  it('refuses a rate outside sane bounds', async () => {
    const aggregator = new RateAggregator({
      cryptoSources: [new StaticCryptoMarketProvider('0.0000001', { now: at(NOW) })],
      fxSources: [new StaticFxProvider('2', { now: at(NOW) })],
      minTomanPerGram: '1000',
      maxTomanPerGram: '10000000',
      now: at(NOW),
    });
    await expect(aggregator.getQuote()).rejects.toThrow(/outside sane bounds/);
  });

  it('refuses an implausible jump from the previous quote', async () => {
    let usd = '2';
    const crypto: CryptoMarketProvider = {
      name: 'MOVING',
      async getGramUsd() {
        return { value: usd, source: 'MOVING', observedAt: new Date(NOW) };
      },
    };
    const aggregator = new RateAggregator({
      cryptoSources: [crypto],
      fxSources: [new StaticFxProvider('100000', { now: at(NOW) })],
      maxDeviationPercent: 25,
      now: at(NOW),
    });

    expect((await aggregator.getQuote()).tomanPerGram).toBe('200000');

    // The feed suddenly halves: far more likely broken than a real move.
    usd = '1';
    await expect(aggregator.getQuote()).rejects.toThrow(/moved implausibly far/);
  });

  it('needs at least one source per leg', () => {
    expect(
      () =>
        new RateAggregator({
          cryptoSources: [],
          fxSources: [new StaticFxProvider('100000')],
        }),
    ).toThrow(/at least one crypto source/);
  });
});
