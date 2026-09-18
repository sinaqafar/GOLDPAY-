/**
 * RateProvider — SPEC 1257/1258/1259: the system obtains a TOMAN/GRAM rate,
 * snapshots it with its source and timestamp, and locks it onto the payout.
 */

export interface RateQuote {
  id: string;
  /** How many TOMAN one whole GRAM costs, as an exact decimal string. */
  tomanPerGram: string;
  source: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface RateProvider {
  getQuote(base: 'TOMAN', quote: 'GRAM'): Promise<RateQuote>;
}
