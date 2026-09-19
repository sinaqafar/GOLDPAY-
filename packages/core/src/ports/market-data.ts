/**
 * Market data ports.
 *
 * A TOMAN/GRAM rate is not quoted anywhere directly, so it is derived:
 *
 *     GRAM/USD  ×  USD/TOMAN  =  TOMAN/GRAM
 *
 * Those two legs come from different kinds of source — a crypto market and an
 * FX source — and each can fail independently. Keeping them as separate ports
 * means either leg can be swapped or given a fallback without touching the
 * payout engine.
 */

export interface MarketObservation {
  /** The observed price, as an exact decimal string. Never a float. */
  value: string;
  /** Which upstream produced it, recorded on the quote for audit. */
  source: string;
  /** When the UPSTREAM last updated this figure, not when we fetched it. */
  observedAt: Date;
}

/** GRAM priced in USD, from a crypto market aggregator. */
export interface CryptoMarketProvider {
  readonly name: string;
  getGramUsd(): Promise<MarketObservation>;
}

/** USD priced in Toman, from an FX source. */
export interface FxProvider {
  readonly name: string;
  getUsdToman(): Promise<MarketObservation>;
}
