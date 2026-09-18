/**
 * RateAggregator — derives TOMAN/GRAM from two independent market legs.
 *
 *     GRAM/USD  ×  USD/TOMAN  =  TOMAN/GRAM
 *
 * Each leg may have several sources tried in order, so one upstream outage does
 * not stop settlement. What it must never do is quietly serve a stale or absurd
 * number: a payout priced off a broken feed sends the wrong amount of GRAM, and
 * that is unrecoverable once it is on chain. So every quote is checked for
 * freshness and sanity, and a failure surfaces as WAITING_RATE rather than a
 * fallback to the last known value.
 *
 * All arithmetic is integer-scaled. A float here could round a rate and change
 * the amount actually sent.
 */

import { randomUUID } from 'node:crypto';
import type { RateProvider, RateQuote } from '../ports/rate-provider.ts';
import type { CryptoMarketProvider, FxProvider, MarketObservation } from '../ports/market-data.ts';
import { IntegrationError, ValidationError } from '../../../errors/src/index.ts';

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Fixed-point scale for the intermediate multiplication. */
const SCALE = 18n;
const SCALE_FACTOR = 10n ** SCALE;

/** Parse a positive decimal string into a bigint scaled by 10^18. */
function toScaled(value: string, label: string): bigint {
  if (!DECIMAL_RE.test(value) || !/[1-9]/.test(value)) {
    throw new IntegrationError('RATE_INVALID', `${label} is not a positive decimal`, {
      retryable: false,
      details: { value },
    });
  }
  const [whole, frac = ''] = value.split('.');
  const padded = (frac + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  return BigInt((whole as string) + padded);
}

/** Render a 10^18-scaled bigint back to a plain decimal string. */
function fromScaled(scaled: bigint): string {
  const whole = scaled / SCALE_FACTOR;
  const frac = (scaled % SCALE_FACTOR).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface RateAggregatorOptions {
  /** Crypto sources for GRAM/USD, tried in order. */
  cryptoSources: readonly CryptoMarketProvider[];
  /** FX sources for USD/TOMAN, tried in order. */
  fxSources: readonly FxProvider[];
  /** How long a derived quote stays usable. */
  ttlSeconds?: number;
  /**
   * How old an upstream observation may be before it is refused.
   * A rate that stopped updating is more dangerous than no rate at all,
   * because it looks perfectly valid.
   */
  maxObservationAgeSeconds?: number;
  /** Sanity bounds on the derived TOMAN/GRAM rate. */
  minTomanPerGram?: string;
  maxTomanPerGram?: string;
  /**
   * Largest tolerated jump from the previous quote, in percent. A feed that
   * suddenly moves 90% is far more likely to be broken than the market to have
   * moved that far between two payouts.
   */
  maxDeviationPercent?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Returns the last good TOMAN/GRAM rate, so the guard survives a restart. */
  loadBaseline?: () => Promise<string | null>;
}

export class RateAggregator implements RateProvider {
  #crypto: readonly CryptoMarketProvider[];
  #fx: readonly FxProvider[];
  #ttlSeconds: number;
  #maxAgeSeconds: number;
  #minScaled: bigint;
  #maxScaled: bigint;
  #maxDeviationPercent: number;
  #now: () => Date;
  #lastScaled: bigint | null = null;
  /**
   * Supplies the last good rate from storage.
   *
   * Without it the first quote after a restart has nothing to compare against,
   * so the deviation guard is silently disabled exactly when a bad feed is
   * most likely to slip through.
   */
  #loadBaseline?: () => Promise<string | null>;
  #baselineLoaded = false;

  constructor(options: RateAggregatorOptions) {
    if (options.cryptoSources.length === 0 || options.fxSources.length === 0) {
      throw new ValidationError(
        'RATE_SOURCES_MISSING',
        'the aggregator needs at least one crypto source and one FX source',
      );
    }
    this.#crypto = options.cryptoSources;
    this.#fx = options.fxSources;
    this.#ttlSeconds = options.ttlSeconds ?? 60;
    this.#maxAgeSeconds = options.maxObservationAgeSeconds ?? 900;
    this.#minScaled = toScaled(options.minTomanPerGram ?? '1', 'minTomanPerGram');
    this.#maxScaled = toScaled(options.maxTomanPerGram ?? '1000000000', 'maxTomanPerGram');
    this.#maxDeviationPercent = options.maxDeviationPercent ?? 25;
    this.#now = options.now ?? (() => new Date());
    if (options.loadBaseline) this.#loadBaseline = options.loadBaseline;
  }

  /** Load the persisted baseline once, so a restart does not reset the guard. */
  async #ensureBaseline(): Promise<void> {
    if (this.#baselineLoaded || !this.#loadBaseline) return;
    this.#baselineLoaded = true;
    try {
      const last = await this.#loadBaseline();
      if (last && /^\d+(\.\d+)?$/.test(last)) this.#lastScaled = toScaled(last, 'baseline');
    } catch {
      // A missing baseline must not stop settlement; the guard simply has
      // nothing to compare against until the next quote.
    }
  }

  async getQuote(): Promise<RateQuote> {
    await this.#ensureBaseline();
    const now = this.#now();

    const gramUsd = await this.#firstUsable(
      this.#crypto.map((s) => ({ name: s.name, fetch: () => s.getGramUsd() })),
      'GRAM/USD',
      now,
    );
    const usdToman = await this.#firstUsable(
      this.#fx.map((s) => ({ name: s.name, fetch: () => s.getUsdToman() })),
      'USD/TOMAN',
      now,
    );

    // (GRAM/USD × USD/TOMAN) with one factor of SCALE divided back out.
    const derived = (toScaled(gramUsd.value, 'GRAM/USD') * toScaled(usdToman.value, 'USD/TOMAN'))
      / SCALE_FACTOR;

    this.#assertSane(derived);
    this.#lastScaled = derived;

    return {
      id: randomUUID(),
      tomanPerGram: fromScaled(derived),
      // The source string records BOTH legs, so a payout can always be traced
      // back to the exact feeds that priced it.
      source: `${gramUsd.source}*${usdToman.source}`,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#ttlSeconds * 1000),
      legs: {
        cryptoUsd: {
          value: gramUsd.value,
          source: gramUsd.source,
          observedAt: gramUsd.observedAt,
        },
        usdToman: {
          value: usdToman.value,
          source: usdToman.source,
          observedAt: usdToman.observedAt,
        },
      },
    };
  }

  /** Try each source in order; the first fresh, well-formed answer wins. */
  async #firstUsable(
    sources: readonly { name: string; fetch: () => Promise<MarketObservation> }[],
    leg: string,
    now: Date,
  ): Promise<MarketObservation> {
    const failures: string[] = [];

    for (const source of sources) {
      try {
        const observation = await source.fetch();
        const ageSeconds = (now.getTime() - observation.observedAt.getTime()) / 1000;
        if (ageSeconds > this.#maxAgeSeconds) {
          failures.push(`${source.name}: stale by ${Math.round(ageSeconds)}s`);
          continue;
        }
        // A clock-skewed future timestamp is not trustworthy either.
        if (ageSeconds < -60) {
          failures.push(`${source.name}: timestamp is in the future`);
          continue;
        }
        toScaled(observation.value, `${leg} from ${source.name}`);
        return observation;
      } catch (e) {
        failures.push(`${source.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Every source failed. Refusing is correct: WAITING_RATE is recoverable,
    // a payout priced off a bad feed is not.
    throw new IntegrationError('RATE_UNAVAILABLE', `no usable ${leg} source`, {
      retryable: true,
      details: { leg, failures },
    });
  }

  #assertSane(derived: bigint): void {
    if (derived <= 0n) {
      throw new IntegrationError('RATE_INVALID', 'derived rate is not positive', {
        retryable: false,
      });
    }
    if (derived < this.#minScaled || derived > this.#maxScaled) {
      throw new IntegrationError('RATE_OUT_OF_BOUNDS', 'derived rate is outside sane bounds', {
        retryable: false,
        details: {
          derived: fromScaled(derived),
          min: fromScaled(this.#minScaled),
          max: fromScaled(this.#maxScaled),
        },
      });
    }

    if (this.#lastScaled !== null) {
      const previous = this.#lastScaled;
      const delta = derived > previous ? derived - previous : previous - derived;
      // Percent move, computed in integers.
      const movePercent = (delta * 100n) / previous;
      if (movePercent > BigInt(this.#maxDeviationPercent)) {
        throw new IntegrationError('RATE_DEVIATION_TOO_LARGE', 'rate moved implausibly far', {
          retryable: true,
          details: {
            previous: fromScaled(previous),
            derived: fromScaled(derived),
            movePercent: movePercent.toString(),
            allowedPercent: this.#maxDeviationPercent,
          },
        });
      }
    }
  }
}

/** A market source backed by a fixed observation — for tests and sandbox runs. */
export class StaticCryptoMarketProvider implements CryptoMarketProvider {
  readonly name: string;
  #value: string;
  #now: () => Date;

  constructor(value: string, options: { name?: string; now?: () => Date } = {}) {
    this.#value = value;
    this.name = options.name ?? 'STATIC_CRYPTO';
    this.#now = options.now ?? (() => new Date());
  }

  async getGramUsd(): Promise<MarketObservation> {
    return { value: this.#value, source: this.name, observedAt: this.#now() };
  }
}

export class StaticFxProvider implements FxProvider {
  readonly name: string;
  #value: string;
  #now: () => Date;

  constructor(value: string, options: { name?: string; now?: () => Date } = {}) {
    this.#value = value;
    this.name = options.name ?? 'STATIC_FX';
    this.#now = options.now ?? (() => new Date());
  }

  async getUsdToman(): Promise<MarketObservation> {
    return { value: this.#value, source: this.name, observedAt: this.#now() };
  }
}
