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

async function fetchJson(
  options: HttpOptions,
): Promise<{ body: Record<string, unknown>; rawBody: string }> {
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
    const rawBody = await res.text();
    return { body: JSON.parse(rawBody) as Record<string, unknown>, rawBody };
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

/**
 * Read a price as an exact decimal string.
 *
 * JSON.parse turns every number into a float, so by the time a value is a
 * `number` its precision is already fixed. The only way to avoid that is to
 * take the digits out of the RAW body before parsing — which this does when the
 * upstream sends a number, falling back to the parsed float only when the shape
 * is unexpected.
 *
 * Market rates are not amounts of money, so a last-digit difference does not
 * mint or destroy anything. But the rate multiplies into a GRAM amount that IS
 * money, and the project forbids floats in that path, so the exact digits are
 * preserved wherever they are available.
 */
function readDecimal(raw: unknown, rawBody: string, field: string): string | null {
  // Preferred: pull the literal digits straight out of the response text.
  const literal = new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(rawBody);
  if (literal?.[1]) return literal[1];

  if (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw)) return raw;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // Scientific notation would be rejected downstream, so render plainly.
    return raw.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  }
  return null;
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
    const { body, rawBody } = await fetchJson({
      url: this.#url,
      timeoutMs: this.#timeoutMs,
      name: this.name,
      headers: this.#apiKey ? { 'x-cg-demo-api-key': this.#apiKey } : {},
    });

    const entry = body[this.#coinId] as Record<string, unknown> | undefined;
    const usd = readDecimal(entry?.['usd'], rawBody, 'usd');
    if (!usd) {
      throw new IntegrationError('MARKET_INVALID_VALUE', 'no usd price in the response', {
        retryable: false,
        details: { source: this.name, coinId: this.#coinId },
      });
    }

    const updatedAt = entry?.['last_updated_at'];
    // Fall back to "now" only when the upstream publishes no timestamp at all.
    const observedAt =
      typeof updatedAt === 'number' ? new Date(updatedAt * 1000) : new Date();

    return { value: usd, source: this.name, observedAt };
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
    const { body, rawBody } = await fetchJson({
      url: this.#url,
      timeoutMs: this.#timeoutMs,
      name: this.name,
      headers: this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {},
    });

    let value: string | null = null;
    for (const field of ['price', 'value', 'toman', 'usd_toman']) {
      if (body[field] === undefined) continue;
      value = readDecimal(body[field], rawBody, field);
      if (value) break;
    }

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
