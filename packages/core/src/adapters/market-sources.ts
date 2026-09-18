/**
 * Concrete market-data sources.
 *
 * Each adapter does one thing: fetch a figure and report when the UPSTREAM last
 * updated it. Deciding whether that figure is fresh enough, sane, or should be
 * replaced by a fallback belongs to RateAggregator, not here.
 *
 * `observedAt` matters as much as the value. An adapter that reports "now"
 * when the upstream figure is hours old defeats the freshness check, so each
 * one reads the upstream's own timestamp where it publishes one.
 */

import type { CryptoMarketProvider, FxProvider, MarketObservation } from '../ports/market-data.ts';
import { IntegrationError } from '../../../errors/src/index.ts';

interface HttpOptions {
  url: string;
  timeoutMs?: number;
  name?: string;
  headers?: Record<string, string>;
}

async function fetchJson(options: HttpOptions): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const res = await fetch(options.url, {
      signal: controller.signal,
      headers: { accept: 'application/json', ...(options.headers ?? {}) },
    });
    if (!res.ok) {
      throw new IntegrationError('MARKET_HTTP_ERROR', `market source returned ${res.status}`, {
        retryable: res.status >= 500 || res.status === 429,
        details: { status: res.status, source: options.name },
      });
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof IntegrationError) throw e;
    throw new IntegrationError('MARKET_UNREACHABLE', 'market source request failed', {
      retryable: true,
      cause: e,
      details: { source: options.name },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Numbers arrive as JSON floats; stringify without scientific notation. */
function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new IntegrationError('MARKET_INVALID_VALUE', 'market source returned a non-positive value', {
      retryable: false,
      details: { value },
    });
  }
  // toFixed(12) keeps small prices intact and avoids 1e-7 style output, which
  // the aggregator's decimal parser would reject.
  return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * GRAM/USD from a CoinGecko-style simple price endpoint.
 *
 * Expected shape:
 *   { "<coinId>": { "usd": 1.23, "last_updated_at": 1700000000 } }
 */
export class CoinGeckoCryptoProvider implements CryptoMarketProvider {
  readonly name: string;
  #url: string;
  #coinId: string;
  #timeoutMs: number;
  #apiKey: string | null;

  constructor(options: {
    baseUrl?: string;
    coinId?: string;
    timeoutMs?: number;
    apiKey?: string | null;
    name?: string;
  } = {}) {
    const base = options.baseUrl ?? 'https://api.coingecko.com/api/v3';
    this.#coinId = options.coinId ?? 'the-open-network';
    this.#url =
      `${base}/simple/price?ids=${encodeURIComponent(this.#coinId)}` +
      `&vs_currencies=usd&include_last_updated_at=true`;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#apiKey = options.apiKey ?? null;
    this.name = options.name ?? 'COINGECKO';
  }

  async getGramUsd(): Promise<MarketObservation> {
    const body = await fetchJson({
      url: this.#url,
      timeoutMs: this.#timeoutMs,
      name: this.name,
      headers: this.#apiKey ? { 'x-cg-demo-api-key': this.#apiKey } : {},
    });

    const entry = body[this.#coinId] as Record<string, unknown> | undefined;
    const usd = entry?.['usd'];
    if (typeof usd !== 'number') {
      throw new IntegrationError('MARKET_INVALID_VALUE', 'no usd price in the response', {
        retryable: false,
        details: { source: this.name, coinId: this.#coinId },
      });
    }

    const updatedAt = entry?.['last_updated_at'];
    // Fall back to "now" only when the upstream publishes no timestamp at all.
    const observedAt =
      typeof updatedAt === 'number' ? new Date(updatedAt * 1000) : new Date();

    return { value: numberToDecimalString(usd), source: this.name, observedAt };
  }
}

/**
 * USD/TOMAN from a Tindex-style endpoint.
 *
 * Expected shape (tolerant about exact field names):
 *   { "price": 123456, "updated_at": "2026-01-01T00:00:00Z" }
 */
export class TindexFxProvider implements FxProvider {
  readonly name: string;
  #url: string;
  #timeoutMs: number;
  #apiKey: string | null;

  constructor(options: { url: string; timeoutMs?: number; apiKey?: string | null; name?: string }) {
    this.#url = options.url;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#apiKey = options.apiKey ?? null;
    this.name = options.name ?? 'TINDEX';
  }

  async getUsdToman(): Promise<MarketObservation> {
    const body = await fetchJson({
      url: this.#url,
      timeoutMs: this.#timeoutMs,
      name: this.name,
      headers: this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {},
    });

    const raw = body['price'] ?? body['value'] ?? body['toman'] ?? body['usd_toman'];
    const value =
      typeof raw === 'number'
        ? numberToDecimalString(raw)
        : typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw)
          ? raw
          : null;

    if (!value) {
      throw new IntegrationError('MARKET_INVALID_VALUE', 'no usable USD/TOMAN price', {
        retryable: false,
        details: { source: this.name },
      });
    }

    const updated = body['updated_at'] ?? body['updatedAt'] ?? body['timestamp'];
    let observedAt = new Date();
    if (typeof updated === 'string' && !Number.isNaN(Date.parse(updated))) {
      observedAt = new Date(updated);
    } else if (typeof updated === 'number') {
      // Seconds or milliseconds, depending on the upstream.
      observedAt = new Date(updated > 1e12 ? updated : updated * 1000);
    }

    return { value, source: this.name, observedAt };
  }
}
