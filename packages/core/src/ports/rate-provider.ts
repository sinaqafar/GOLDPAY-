/**
 * RateProvider — SPEC 1257/1258/1259: the system obtains a TOMAN/GRAM rate,
 * snapshots it with its source and timestamp, and locks it onto the payout.
 */

/** One market observation that contributed to a derived rate. */
export interface RateLeg {
  value: string;
  source: string;
  observedAt: Date;
}

export interface RateQuote {
  id: string;
  /** How many TOMAN one whole GRAM costs, as an exact decimal string. */
  tomanPerGram: string;
  source: string;
  createdAt: Date;
  expiresAt: Date;
  /**
   * The observations this was derived from, when it was derived rather than
   * quoted directly.
   *
   * Persisted with the quote so a settlement can be explained long afterwards:
   * a payout that moved real money should never be unreconstructable.
   */
  legs?: { cryptoUsd: RateLeg; usdToman: RateLeg };
}

export interface RateProvider {
  getQuote(base: 'TOMAN', quote: 'GRAM'): Promise<RateQuote>;
}
