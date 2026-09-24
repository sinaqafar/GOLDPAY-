/**
 * RateAggregator — derives TOMAN/GRAM from two independent market legs
 * with multi-source consensus, outlier filtering, and cross-source validation.
 *
 *     GRAM/USD  ×  USD/TOMAN  =  TOMAN/GRAM
 *
 * Strict Production Quorum Rules:
 * When multiple sources are configured for a leg (sources.length >= 2):
 * - valid.length === 0 -> RATE_UNAVAILABLE
 * - valid.length === 1 -> RATE_DISCREPANCY (minimum quorum of 2 independent sources required)
 * - valid.length >= 2 -> cross-source divergence check and median consensus.
 *
 * Arithmetic is strictly integer-scaled (10^18 fixed-point). Zero floats.
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
export function toScaled(value: string, label: string): bigint {
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
export function fromScaled(scaled: bigint): string {
  const whole = scaled / SCALE_FACTOR;
  const frac = (scaled % SCALE_FACTOR).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface RateAggregatorOptions {
  /** Crypto sources for GRAM/USD. */
  cryptoSources: readonly CryptoMarketProvider[];
  /** FX sources for USD/TOMAN. */
  fxSources: readonly FxProvider[];
  /** Minimum number of valid concurring sources required for quorum. */
  minQuorum?: number;
  /** How long a derived quote stays usable. */
  ttlSeconds?: number;
  /** How old an upstream observation may be before it is refused. */
  maxObservationAgeSeconds?: number;
  /** Sanity bounds on the derived TOMAN/GRAM rate. */
  minTomanPerGram?: string;
  maxTomanPerGram?: string;
  /** Largest tolerated jump from the previous persisted quote in percent. */
  maxDeviationPercent?: number;
  /** Largest tolerated disagreement between concurrent sources in percent. */
  maxCrossSourceDeviationPercent?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Returns the last good TOMAN/GRAM rate, so the guard survives a restart. */
  loadBaseline?: () => Promise<string | null>;
}

export class RateAggregator implements RateProvider {
  #crypto: readonly CryptoMarketProvider[];
  #fx: readonly FxProvider[];
  #minQuorum?: number;
  #ttlSeconds: number;
  #maxAgeSeconds: number;
  #minScaled: bigint;
  #maxScaled: bigint;
  #maxDeviationPercent: number;
  #maxCrossSourceDeviationPercent: number;
  #now: () => Date;
  #lastScaled: bigint | null = null;
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
    this.#minQuorum = options.minQuorum;
    this.#ttlSeconds = options.ttlSeconds ?? 60;
    this.#maxAgeSeconds = options.maxObservationAgeSeconds ?? 900;
    this.#minScaled = toScaled(options.minTomanPerGram ?? '1', 'minTomanPerGram');
    this.#maxScaled = toScaled(options.maxTomanPerGram ?? '1000000000', 'maxTomanPerGram');
    this.#maxDeviationPercent = options.maxDeviationPercent ?? 25;
    this.#maxCrossSourceDeviationPercent = options.maxCrossSourceDeviationPercent ?? 10;
    this.#now = options.now ?? (() => new Date());
    if (options.loadBaseline) this.#loadBaseline = options.loadBaseline;
  }

  async #ensureBaseline(): Promise<void> {
    if (this.#baselineLoaded || !this.#loadBaseline) return;
    this.#baselineLoaded = true;
    try {
      const last = await this.#loadBaseline();
      if (last && /^\d+(\.\d+)?$/.test(last)) this.#lastScaled = toScaled(last, 'baseline');
    } catch {
      // Missing baseline does not stop settlement
    }
  }

  async getQuote(): Promise<RateQuote> {
    await this.#ensureBaseline();
    const now = this.#now();

    const gramUsd = await this.#resolveLegConsensus(
      this.#crypto.map((s) => ({ name: s.name, fetch: () => s.getGramUsd() })),
      'GRAM/USD',
      now,
    );
    const usdToman = await this.#resolveLegConsensus(
      this.#fx.map((s) => ({ name: s.name, fetch: () => s.getUsdToman() })),
      'USD/TOMAN',
      now,
    );

    const derived = (toScaled(gramUsd.value, 'GRAM/USD') * toScaled(usdToman.value, 'USD/TOMAN'))
      / SCALE_FACTOR;

    this.#assertSane(derived);
    this.#lastScaled = derived;

    return {
      id: randomUUID(),
      tomanPerGram: fromScaled(derived),
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

  /**
   * Concurrently queries all sources for a leg and performs cross-source validation and quorum enforcement.
   */
  async #resolveLegConsensus(
    sources: readonly { name: string; fetch: () => Promise<MarketObservation> }[],
    leg: string,
    now: Date,
  ): Promise<MarketObservation> {
    const results = await Promise.allSettled(
      sources.map(async (s) => {
        const obs = await s.fetch();
        const ageSeconds = (now.getTime() - obs.observedAt.getTime()) / 1000;
        if (ageSeconds > this.#maxAgeSeconds) {
          throw new Error(`stale by ${Math.round(ageSeconds)}s`);
        }
        if (ageSeconds < -60) {
          throw new Error('timestamp is in the future');
        }
        toScaled(obs.value, `${leg} from ${s.name}`);
        return obs;
      }),
    );

    const valid: MarketObservation[] = [];
    const failures: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      const name = sources[i]?.name ?? `source_${i}`;
      if (res?.status === 'fulfilled') {
        valid.push(res.value);
      } else {
        failures.push(`${name}: ${res?.reason instanceof Error ? res.reason.message : String(res?.reason)}`);
      }
    }

    const requiredQuorum = this.#minQuorum ?? (sources.length >= 2 ? 2 : 1);

    if (valid.length < requiredQuorum) {
      if (valid.length === 0) {
        throw new IntegrationError('RATE_UNAVAILABLE', `no usable ${leg} source`, {
          retryable: true,
          details: { leg, failures },
        });
      }
      throw new IntegrationError(
        'RATE_DISCREPANCY',
        `fewer than ${requiredQuorum} independent sources reached consensus on ${leg}; single unverified feed rejected`,
        {
          retryable: true,
          details: {
            leg,
            validSource: valid[0]?.source,
            failures,
            threshold: this.#maxCrossSourceDeviationPercent,
          },
        },
      );
    }

    if (valid.length === 1) {
      return valid[0] as MarketObservation;
    }

    // Multiple valid sources: perform cross-validation and consensus
    const scaledItems = valid.map((v) => ({
      obs: v,
      scaled: toScaled(v.value, `${leg}:${v.source}`),
    }));

    scaledItems.sort((a, b) => (a.scaled < b.scaled ? -1 : a.scaled > b.scaled ? 1 : 0));

    const min = scaledItems[0]?.scaled as bigint;
    const max = scaledItems[scaledItems.length - 1]?.scaled as bigint;
    const crossDivergence = ((max - min) * 100n) / min;

    if (crossDivergence > BigInt(this.#maxCrossSourceDeviationPercent)) {
      if (scaledItems.length === 2) {
        throw new IntegrationError('RATE_DISCREPANCY', `cross-source divergence on ${leg} exceeded threshold`, {
          retryable: true,
          details: {
            leg,
            sources: valid.map((v) => `${v.source}=${v.value}`),
            divergencePercent: crossDivergence.toString(),
            threshold: this.#maxCrossSourceDeviationPercent,
          },
        });
      }

      // 3 or more sources: exclude the most extreme outlier and take the median of remaining
      const medianIdx = Math.floor(scaledItems.length / 2);
      const medianScaled = scaledItems[medianIdx]?.scaled as bigint;

      // Filter items within threshold of the median
      const accepted = scaledItems.filter((item) => {
        const diff = item.scaled > medianScaled ? item.scaled - medianScaled : medianScaled - item.scaled;
        return (diff * 100n) / medianScaled <= BigInt(this.#maxCrossSourceDeviationPercent);
      });

      // Production Quorum requirement: must have at least 2 independent sources agreeing
      if (accepted.length < 2) {
        throw new IntegrationError('RATE_DISCREPANCY', `fewer than 2 independent sources reached consensus on ${leg}`, {
          retryable: true,
          details: { leg, divergencePercent: crossDivergence.toString(), acceptedSources: accepted.map(a => a.obs.source) },
        });
      }

      const consensusMedian = accepted[Math.floor(accepted.length / 2)] as { obs: MarketObservation; scaled: bigint };
      const sourceNames = accepted.map((a) => a.obs.source).join('+');

      return {
        value: fromScaled(consensusMedian.scaled),
        source: `[${sourceNames}]`,
        observedAt: consensusMedian.obs.observedAt,
      };
    }

    // Sources agree within threshold: compute median
    const midIdx = Math.floor(scaledItems.length / 2);
    const medianItem = scaledItems[midIdx] as { obs: MarketObservation; scaled: bigint };
    const sourceNames = valid.map((v) => v.source).join('+');

    return {
      value: fromScaled(medianItem.scaled),
      source: `[${sourceNames}]`,
      observedAt: medianItem.obs.observedAt,
    };
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
      const movePercent = (delta * 100n) / previous;
      if (movePercent > BigInt(this.#maxDeviationPercent)) {
        throw new IntegrationError('RATE_DEVIATION_TOO_LARGE', 'rate moved implausibly far', {
          retryable: true,
          details: {
            previous: fromScaled(previous),
            derived: fromScaled(derived),
            moveBps: moveBps.toString(),
            allowedBps: allowedBps.toString(),
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
