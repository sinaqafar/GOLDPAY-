/**
 * Explicit state machines.
 *
 * SPEC 118.47/118.52/118.53: transitions are validated, are written with a
 * conditional UPDATE guarded by the expected current state, and a 0-row result
 * means the transition did not happen.
 * SPEC 124.166: every real-world event must have a defined system response.
 */

import { StateTransitionError } from '../../errors/src/index.ts';

export type MerchantStatus =
  | 'PENDING'
  | 'REVIEW'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'BLOCKED'
  | 'CLOSED';

export type WalletStatus = 'PENDING' | 'SECURITY_HOLD' | 'ACTIVE' | 'DISABLED' | 'REVOKED';

export type InvoiceStatus = 'CREATED' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';

export type PaymentStatus =
  | 'INITIATED'
  | 'PENDING_PROVIDER'
  | 'VERIFIED'
  | 'RELEASED'
  | 'MISMATCH'
  | 'FAILED'
  | 'REFUNDED'
  | 'UNKNOWN';

export type PayoutStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'RATE_LOCKED'
  | 'WAITING_LIQUIDITY'
  | 'RESERVED'
  | 'SIGNED'
  | 'BROADCASTED'
  | 'CONFIRMING'
  | 'SETTLED'
  | 'FAILED'
  | 'UNKNOWN';

export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'RETRY' | 'DEAD';

type Transitions<S extends string> = Readonly<Record<S, readonly S[]>>;

export const MERCHANT_TRANSITIONS: Transitions<MerchantStatus> = {
  PENDING: ['REVIEW', 'ACTIVE', 'BLOCKED', 'CLOSED'],
  REVIEW: ['ACTIVE', 'SUSPENDED', 'BLOCKED'],
  ACTIVE: ['SUSPENDED', 'BLOCKED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'BLOCKED', 'CLOSED'],
  BLOCKED: ['CLOSED'],
  CLOSED: [],
};

export const WALLET_TRANSITIONS: Transitions<WalletStatus> = {
  PENDING: ['SECURITY_HOLD', 'REVOKED'],
  SECURITY_HOLD: ['ACTIVE', 'REVOKED'],
  ACTIVE: ['DISABLED', 'REVOKED'],
  DISABLED: ['ACTIVE', 'REVOKED'],
  REVOKED: [],
};

export const INVOICE_TRANSITIONS: Transitions<InvoiceStatus> = {
  CREATED: ['PAID', 'EXPIRED', 'CANCELLED'],
  PAID: ['REFUNDED'],
  EXPIRED: [],
  CANCELLED: [],
  REFUNDED: [],
};

export const PAYMENT_TRANSITIONS: Transitions<PaymentStatus> = {
  INITIATED: ['PENDING_PROVIDER', 'FAILED', 'UNKNOWN'],
  PENDING_PROVIDER: ['VERIFIED', 'MISMATCH', 'FAILED', 'UNKNOWN'],
  // A verified payment waits out the 48h hold, then becomes RELEASED.
  VERIFIED: ['RELEASED', 'REFUNDED', 'MISMATCH'],
  RELEASED: ['REFUNDED'],
  MISMATCH: ['VERIFIED', 'FAILED', 'REFUNDED'],
  FAILED: [],
  REFUNDED: [],
  // SPEC 124.170: UNKNOWN is resolved by reconciliation, never by a blind retry.
  UNKNOWN: ['VERIFIED', 'FAILED', 'MISMATCH'],
};

export const PAYOUT_TRANSITIONS: Transitions<PayoutStatus> = {
  CREATED: ['QUEUED', 'FAILED'],
  QUEUED: ['RATE_LOCKED', 'FAILED'],
  RATE_LOCKED: ['RESERVED', 'WAITING_LIQUIDITY', 'FAILED'],
  WAITING_LIQUIDITY: ['RATE_LOCKED', 'RESERVED', 'FAILED'],
  // SPEC 90.10 — signing is its own step; a signed payload must exist before
  // anything is put on the wire.
  RESERVED: ['SIGNED', 'FAILED', 'UNKNOWN'],
  // SPEC 5496-5501 — "signed but not broadcast". A signing failure can still be
  // definitive (FAILED), but once signed we must never build a second
  // transaction; the only ways forward are broadcast or reconciliation.
  SIGNED: ['BROADCASTED', 'FAILED', 'UNKNOWN'],
  // Accepted by the network, not yet final.
  BROADCASTED: ['CONFIRMING', 'SETTLED', 'FAILED', 'UNKNOWN'],
  // Seen on chain but short of the required confirmations. Distinguishing this
  // from BROADCASTED is what lets an operator see a transaction that is stuck
  // rather than merely new.
  CONFIRMING: ['SETTLED', 'FAILED', 'UNKNOWN'],
  SETTLED: [],
  FAILED: [],
  // Only reconciliation may move a payout out of UNKNOWN.
  UNKNOWN: ['SETTLED', 'FAILED'],
};

export const RESERVATION_TRANSITIONS: Transitions<ReservationStatus> = {
  ACTIVE: ['CONSUMED', 'RELEASED', 'EXPIRED'],
  CONSUMED: [],
  RELEASED: [],
  EXPIRED: [],
};

export const OUTBOX_TRANSITIONS: Transitions<OutboxStatus> = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['SENT', 'RETRY', 'DEAD'],
  RETRY: ['PROCESSING', 'DEAD'],
  SENT: [],
  DEAD: [],
};

export function canTransition<S extends string>(
  table: Transitions<S>,
  from: S,
  to: S,
): boolean {
  const allowed = table[from];
  return allowed !== undefined && allowed.includes(to);
}

export function assertTransition<S extends string>(
  entity: string,
  table: Transitions<S>,
  from: S,
  to: S,
): void {
  if (!canTransition(table, from, to)) {
    throw new StateTransitionError(entity, from, to);
  }
}

/** Terminal states never change again and must never be re-processed. */
export function isTerminal<S extends string>(table: Transitions<S>, state: S): boolean {
  return (table[state]?.length ?? 0) === 0;
}

/**
 * States in which money is committed to an in-flight on-chain transaction.
 * SPEC 124.170: while in these states the amount must NOT be made spendable again.
 */
export const PAYOUT_IN_FLIGHT: readonly PayoutStatus[] = [
  'RESERVED',
  'SIGNED',
  'BROADCASTED',
  'CONFIRMING',
  'UNKNOWN',
];

export function isPayoutInFlight(status: PayoutStatus): boolean {
  return PAYOUT_IN_FLIGHT.includes(status);
}
