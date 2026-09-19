/**
 * Numeric ceilings that keep application values inside their storage columns.
 *
 * The database is the last line of defence, but a NUMERIC overflow surfaces as
 * an opaque driver error (a 500) rather than a clean domain rejection. These
 * limits let every entry point fail as a 400/422 with a precise code, while the
 * column constraints stay as the backstop (SPEC 89.76/89.77 — application AND
 * database both defend the invariant).
 *
 * Ceilings are deliberately well below the raw column width so derived figures
 * — a 115% customer total, a summed payout, a Toman→GRAM conversion — cannot
 * overflow either.
 */

import { ValidationError } from '../../errors/src/index.ts';

/**
 * Toman columns are NUMERIC(30,0). A CUSTOMER-mode invoice stores up to 1.15x
 * the base, so a 28-digit ceiling leaves two decimal orders of headroom.
 */
export const MAX_TOMAN_ATOMIC = 10n ** 28n;

/**
 * GRAM columns are NUMERIC(40,0) in nanogram. A 38-digit ceiling leaves room
 * for reservation sums and fee additions on top of any single amount.
 *
 * For scale: 10^38 nanogram is 10^29 GRAM, which exceeds the total supply by
 * an absurd margin — this only ever catches corrupt or hostile input.
 */
export const MAX_GRAM_ATOMIC = 10n ** 38n;

/**
 * Reject a Toman amount that could not be stored safely.
 * `field` names the offending input so the error is actionable.
 */
export function assertTomanWithinBounds(value: bigint, field: string): void {
  if (value < 0n) {
    throw new ValidationError('AMOUNT_NEGATIVE', `${field} cannot be negative`, { field });
  }
  if (value > MAX_TOMAN_ATOMIC) {
    throw new ValidationError('AMOUNT_TOO_LARGE', `${field} exceeds the maximum storable amount`, {
      field,
      maximum: MAX_TOMAN_ATOMIC.toString(),
      received: value.toString(),
    });
  }
}

/** Reject a GRAM (nanogram) amount that could not be stored safely. */
export function assertGramWithinBounds(value: bigint, field: string): void {
  if (value < 0n) {
    throw new ValidationError('AMOUNT_NEGATIVE', `${field} cannot be negative`, { field });
  }
  if (value > MAX_GRAM_ATOMIC) {
    throw new ValidationError('AMOUNT_TOO_LARGE', `${field} exceeds the maximum storable amount`, {
      field,
      maximum: MAX_GRAM_ATOMIC.toString(),
      received: value.toString(),
    });
  }
}
