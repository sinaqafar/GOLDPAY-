/**
 * packages/money — Exact financial arithmetic.
 *
 * SPEC 103744: `float = forbidden`.
 * SPEC 103745: financial operations use Decimal / Integer.
 * SPEC 103746: currency units must be type-safe so `TOMAN + GRAM` is rejected.
 * SPEC 103961: GRAM settlement amounts are stored as integer smallest units.
 *
 * Every amount in this system is a bigint of the currency's *atomic* unit:
 *   TOMAN -> 1 atomic unit  = 1 Toman   (decimals = 0)
 *   GRAM  -> 1 atomic unit  = 1 nanoGRAM (decimals = 9)
 */

export const CURRENCIES = {
  TOMAN: { code: 'TOMAN', decimals: 0 },
  GRAM: { code: 'GRAM', decimals: 9 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export function currencyDecimals(code: CurrencyCode): number {
  return CURRENCIES[code].decimals;
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.hasOwn(CURRENCIES, value);
}

export class MoneyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}

/** Rounding policy for division / rate conversion. SPEC: rounding must be explicit. */
export type Rounding = 'FLOOR' | 'CEIL' | 'HALF_UP' | 'HALF_EVEN';

function divRound(numerator: bigint, denominator: bigint, mode: Rounding): bigint {
  if (denominator === 0n) throw new MoneyError('DIVISION_BY_ZERO', 'division by zero');
  // Normalise sign so the rounding logic only deals with a positive denominator.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const q = abs / d;
  const r = abs % d;
  if (r === 0n) return negative ? -q : q;

  let up: boolean;
  switch (mode) {
    case 'FLOOR':
      // Floor on the signed value: truncation already floors positives.
      return negative ? -(q + 1n) : q;
    case 'CEIL':
      return negative ? -q : q + 1n;
    case 'HALF_UP':
      up = r * 2n >= d;
      break;
    case 'HALF_EVEN': {
      const twice = r * 2n;
      if (twice > d) up = true;
      else if (twice < d) up = false;
      else up = q % 2n === 1n;
      break;
    }
  }
  const res = up ? q + 1n : q;
  return negative ? -res : res;
}

/**
 * An immutable amount of a single currency, held as a bigint of atomic units.
 * Arithmetic between different currencies throws (SPEC 103746).
 */
export class Money {
  readonly atomic: bigint;
  readonly currency: CurrencyCode;

  private constructor(atomic: bigint, currency: CurrencyCode) {
    this.atomic = atomic;
    this.currency = currency;
    Object.freeze(this);
  }

  static of(atomic: bigint | number | string, currency: CurrencyCode): Money {
    if (!isCurrencyCode(currency)) {
      throw new MoneyError('UNKNOWN_CURRENCY', `unknown currency: ${String(currency)}`);
    }
    let value: bigint;
    if (typeof atomic === 'bigint') {
      value = atomic;
    } else if (typeof atomic === 'number') {
      if (!Number.isInteger(atomic)) {
        // SPEC 103744 — a non-integer number is a float and is never a valid atomic amount.
        throw new MoneyError('FLOAT_FORBIDDEN', `non-integer atomic amount: ${atomic}`);
      }
      if (!Number.isSafeInteger(atomic)) {
        throw new MoneyError('UNSAFE_INTEGER', `atomic amount exceeds safe integer range: ${atomic}`);
      }
      value = BigInt(atomic);
    } else {
      const trimmed = atomic.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        throw new MoneyError('INVALID_ATOMIC_STRING', `not an integer string: ${atomic}`);
      }
      value = BigInt(trimmed);
    }
    return new Money(value, currency);
  }

  static zero(currency: CurrencyCode): Money {
    return Money.of(0n, currency);
  }

  static toman(atomic: bigint | number | string): Money {
    return Money.of(atomic, 'TOMAN');
  }

  static gram(atomic: bigint | number | string): Money {
    return Money.of(atomic, 'GRAM');
  }

  /**
   * Parse a human decimal string ("1000000", "1.5") into atomic units.
   * Rejects more fraction digits than the currency supports — silent truncation
   * of user money is never acceptable.
   */
  static parse(input: string, currency: CurrencyCode): Money {
    const decimals = currencyDecimals(currency);
    const trimmed = input.trim().replace(/[,_\s]/g, '');
    const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(trimmed);
    if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
      throw new MoneyError('INVALID_AMOUNT', `cannot parse amount: ${input}`);
    }
    const sign = m[1] === '-' ? -1n : 1n;
    const whole = m[2] === '' ? '0' : (m[2] as string);
    const frac = m[3] ?? '';
    if (frac.length > decimals) {
      throw new MoneyError(
        'TOO_MANY_DECIMALS',
        `${currency} supports ${decimals} decimals, got ${frac.length}`,
      );
    }
    const padded = frac.padEnd(decimals, '0');
    return new Money(sign * BigInt(whole + padded), currency);
  }

  private assertSame(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(
        'CURRENCY_MISMATCH',
        `cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSame(other);
    return new Money(this.atomic + other.atomic, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSame(other);
    return new Money(this.atomic - other.atomic, this.currency);
  }

  negated(): Money {
    return new Money(-this.atomic, this.currency);
  }

  abs(): Money {
    return this.atomic < 0n ? this.negated() : this;
  }

  multiply(factor: bigint | number): Money {
    if (typeof factor === 'number' && !Number.isInteger(factor)) {
      throw new MoneyError('FLOAT_FORBIDDEN', `multiply requires an integer factor, got ${factor}`);
    }
    return new Money(this.atomic * BigInt(factor), this.currency);
  }

  /** Multiply by numerator/denominator with an explicit rounding policy. */
  mulDiv(numerator: bigint, denominator: bigint, mode: Rounding = 'FLOOR'): Money {
    return new Money(divRound(this.atomic * numerator, denominator, mode), this.currency);
  }

  isZero(): boolean {
    return this.atomic === 0n;
  }

  isPositive(): boolean {
    return this.atomic > 0n;
  }

  isNegative(): boolean {
    return this.atomic < 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSame(other);
    if (this.atomic < other.atomic) return -1;
    if (this.atomic > other.atomic) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.atomic === other.atomic;
  }

  gte(other: Money): boolean {
    return this.compare(other) >= 0;
  }
  gt(other: Money): boolean {
    return this.compare(other) > 0;
  }
  lte(other: Money): boolean {
    return this.compare(other) <= 0;
  }
  lt(other: Money): boolean {
    return this.compare(other) < 0;
  }

  /** Database representation: an exact integer string for NUMERIC(n,0). */
  toAtomicString(): string {
    return this.atomic.toString();
  }

  /** Human representation, e.g. 1500000000 nanoGRAM -> "1.500000000". */
  format(): string {
    const decimals = currencyDecimals(this.currency);
    const negative = this.atomic < 0n;
    const abs = (negative ? -this.atomic : this.atomic).toString().padStart(decimals + 1, '0');
    const whole = abs.slice(0, abs.length - decimals) || '0';
    const frac = decimals > 0 ? '.' + abs.slice(abs.length - decimals) : '';
    return `${negative ? '-' : ''}${whole}${frac}`;
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toAtomicString(), currency: this.currency };
  }

  toString(): string {
    return `${this.format()} ${this.currency}`;
  }
}

/**
 * A percentage held in basis points (1 bp = 0.01%). 15% => 1500 bp.
 * SPEC 4333: the fee rate must be versioned; the value object stays exact.
 */
export class Percentage {
  readonly bps: bigint;

  private constructor(bps: bigint) {
    this.bps = bps;
    Object.freeze(this);
  }

  static fromBps(bps: bigint | number): Percentage {
    const v = BigInt(bps);
    if (v < 0n) throw new MoneyError('NEGATIVE_PERCENTAGE', 'percentage cannot be negative');
    return new Percentage(v);
  }

  static fromPercent(percent: number): Percentage {
    if (!Number.isFinite(percent)) {
      throw new MoneyError('INVALID_PERCENTAGE', `invalid percent: ${percent}`);
    }
    const scaled = Math.round(percent * 100);
    if (Math.abs(scaled - percent * 100) > 1e-9) {
      throw new MoneyError('PERCENT_PRECISION', `percent ${percent} is finer than 0.01%`);
    }
    return Percentage.fromBps(BigInt(scaled));
  }

  /** Apply to an amount. Default FLOOR keeps the platform from over-charging by a rounding unit. */
  applyTo(amount: Money, mode: Rounding = 'FLOOR'): Money {
    return amount.mulDiv(this.bps, 10_000n, mode);
  }

  toPercentString(): string {
    const whole = this.bps / 100n;
    const frac = this.bps % 100n;
    return frac === 0n ? `${whole}%` : `${whole}.${frac.toString().padStart(2, '0')}%`;
  }
}

/**
 * An exchange rate snapshot: how many TOMAN atomic units one whole GRAM costs.
 * SPEC 103943/103944: the rate is snapshotted onto the payout and later provider
 * changes must never mutate an existing payout.
 */
export class Rate {
  /** TOMAN atomic units per 1 whole GRAM, scaled by 10^scale for sub-unit precision. */
  readonly scaledTomanPerGram: bigint;
  readonly scale: number;
  readonly source: string;

  private constructor(scaledTomanPerGram: bigint, scale: number, source: string) {
    this.scaledTomanPerGram = scaledTomanPerGram;
    this.scale = scale;
    this.source = source;
    Object.freeze(this);
  }

  static of(tomanPerGram: string, source: string, scale = 18): Rate {
    const m = /^(\d+)(?:\.(\d*))?$/.exec(tomanPerGram.trim());
    if (!m) throw new MoneyError('INVALID_RATE', `cannot parse rate: ${tomanPerGram}`);
    const frac = (m[2] ?? '').slice(0, scale).padEnd(scale, '0');
    const scaled = BigInt((m[1] as string) + frac);
    if (scaled <= 0n) throw new MoneyError('NON_POSITIVE_RATE', 'rate must be > 0');
    if (!source) throw new MoneyError('RATE_SOURCE_REQUIRED', 'rate source is required');
    return new Rate(scaled, scale, source);
  }

  /**
   * Convert a TOMAN liability into nanoGRAM.
   *
   *   gramWhole      = toman / rate
   *   gramAtomic     = gramWhole * 10^9
   *
   * Rounded FLOOR by default: the merchant is never paid more GRAM than their
   * Toman liability covers, which protects treasury liquidity invariants.
   */
  tomanToGram(toman: Money, mode: Rounding = 'FLOOR'): Money {
    if (toman.currency !== 'TOMAN') {
      throw new MoneyError('CURRENCY_MISMATCH', `expected TOMAN, got ${toman.currency}`);
    }
    const gramUnitScale = 10n ** BigInt(currencyDecimals('GRAM'));
    const numerator = toman.atomic * gramUnitScale * 10n ** BigInt(this.scale);
    return Money.of(divRound(numerator, this.scaledTomanPerGram, mode), 'GRAM');
  }

  /** Inverse conversion, used by reconciliation reports. */
  gramToToman(gram: Money, mode: Rounding = 'FLOOR'): Money {
    if (gram.currency !== 'GRAM') {
      throw new MoneyError('CURRENCY_MISMATCH', `expected GRAM, got ${gram.currency}`);
    }
    const gramUnitScale = 10n ** BigInt(currencyDecimals('GRAM'));
    const numerator = gram.atomic * this.scaledTomanPerGram;
    return Money.of(
      divRound(numerator, gramUnitScale * 10n ** BigInt(this.scale), mode),
      'TOMAN',
    );
  }

  /** Exact decimal string for persistence in NUMERIC(40,18). */
  toDbString(): string {
    const s = this.scaledTomanPerGram.toString().padStart(this.scale + 1, '0');
    const whole = s.slice(0, s.length - this.scale);
    const frac = s.slice(s.length - this.scale);
    return `${whole}.${frac}`;
  }

  static fromDbString(value: string, source: string, scale = 18): Rate {
    return Rate.of(value, source, scale);
  }
}

export function sumMoney(items: readonly Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
}
