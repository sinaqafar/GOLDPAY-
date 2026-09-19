/**
 * Rate providers.
 *
 * A quote is only usable while it is fresh: `LockPayoutRateUseCase` refuses an
 * expired quote so the Toman/GRAM conversion can never drift silently.
 */

import { randomUUID } from 'node:crypto';
import type { RateProvider, RateQuote } from '../ports/rate-provider.ts';
import { IntegrationError, ValidationError } from '../../../errors/src/index.ts';

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * Positivity check without floating point: a decimal string is > 0 exactly when
 * it contains a non-zero digit. Parsing to a float here could round a very small
 * rate to 0 (or a very large one to Infinity), which is precisely the class of
 * bug this codebase forbids in money paths.
 */
function isPositiveDecimal(value: string): boolean {
  return DECIMAL_RE.test(value) && /[1-9]/.test(value);
}

/**
 * A fixed rate. TESTS AND DEVELOPMENT ONLY.
 *
 * Named so nobody can mistake it for a deployable provider: settling real GRAM
 * against a hardcoded number sends the wrong amount the moment the market
 * moves. The composition root refuses it in production.
 */
export class TestOnlyStaticRateProvider implements RateProvider {
  #tomanPerGram: string;
  #ttlSeconds: number;
  #source: string;

  constructor(tomanPerGram: string, options: { ttlSeconds?: number; source?: string } = {}) {
    if (!DECIMAL_RE.test(tomanPerGram)) {
      throw new ValidationError('INVALID_RATE', 'rate must be a positive decimal string');
    }
    if (!isPositiveDecimal(tomanPerGram)) {
      throw new ValidationError('INVALID_RATE', 'rate must be greater than zero');
    }
    this.#tomanPerGram = tomanPerGram;
    this.#ttlSeconds = options.ttlSeconds ?? 120;
    this.#source = options.source ?? 'STATIC';
  }

  async getQuote(): Promise<RateQuote> {
    const now = new Date();
    return {
      id: randomUUID(),
      tomanPerGram: this.#tomanPerGram,
      source: this.#source,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#ttlSeconds * 1000),
    };
  }
}

/** Fetches a quote over HTTP and caches it until just before it expires. */
export class HttpRateProvider implements RateProvider {
  #url: string;
  #ttlSeconds: number;
  #timeoutMs: number;
  #source: string;
  #cached: RateQuote | null = null;

  constructor(options: { url: string; ttlSeconds?: number; timeoutMs?: number; source?: string }) {
    this.#url = options.url;
    this.#ttlSeconds = options.ttlSeconds ?? 60;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#source = options.source ?? 'HTTP';
  }

  async getQuote(): Promise<RateQuote> {
    // Re-use the cached quote while it still has a safety margin of life left.
    if (this.#cached && this.#cached.expiresAt.getTime() - Date.now() > 10_000) {
      return this.#cached;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await fetch(this.#url, { signal: controller.signal });
      if (!res.ok) {
        throw new IntegrationError('RATE_HTTP_ERROR', `rate source returned ${res.status}`, {
          retryable: res.status >= 500,
        });
      }
      const body = (await res.json()) as Record<string, unknown>;
      const raw = body['toman_per_gram'] ?? body['rate'] ?? body['price'];
      const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : null;
      if (!value || !isPositiveDecimal(value)) {
        throw new IntegrationError('RATE_INVALID', 'rate source returned an unusable rate', {
          retryable: false,
          details: { raw },
        });
      }
      const now = new Date();
      this.#cached = {
        id: randomUUID(),
        tomanPerGram: value,
        source: this.#source,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.#ttlSeconds * 1000),
      };
      return this.#cached;
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      throw new IntegrationError('RATE_UNREACHABLE', 'could not fetch a rate quote', {
        retryable: true,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
