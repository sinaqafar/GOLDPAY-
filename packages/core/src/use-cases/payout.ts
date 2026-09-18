/**
 * The payout pipeline — SPEC 117.51 to 117.55.
 *
 *   QueuePayoutUseCase            AVAILABLE -> SETTLING, payout row created
 *   LockPayoutRateUseCase         immutable rate snapshot + GRAM amount
 *   ReservePayoutLiquidityUseCase full-amount reservation or WAITING_LIQUIDITY
 *   BroadcastPayoutUseCase        send on TON, persist tx hash
 *   ReconcilePayoutUseCase        resolve UNKNOWN from the chain, never blindly
 *
 * SPEC 124.168/124.169:
 *   NO FULL LIQUIDITY   -> NO PAYOUT (wait, never auto-buy)
 *   NO CHAIN CONFIRMATION -> NO SETTLED
 * SPEC 124.170: UNKNOWN -> RECONCILE, never blind retry.
 */

import { randomUUID } from 'node:crypto';
import type { Database, TransactionContext } from '../../../database/src/client.ts';
import { Money, Rate } from '../../../money/src/index.ts';
import { post } from '../../../ledger/src/ledger-service.ts';
import { getOrCreateMerchantAccount, getSystemAccountId } from '../../../ledger/src/accounts.ts';
import { enqueue } from '../outbox.ts';
import { recordTransition, transitionState } from '../transitions.ts';
import { sha256Hex } from '../../../crypto/src/index.ts';
import type { Config } from '../../../config/src/index.ts';
import type { RateProvider } from '../ports/rate-provider.ts';
import type { BlockchainPayoutPort, BroadcastResult } from '../ports/blockchain.ts';
import type { SignerPort } from '../ports/signer.ts';
import { assertGramWithinBounds, assertTomanWithinBounds } from '../limits.ts';
import {
  PayoutError,
  FinancialError,
  NotFoundError,
  ErrorCodes,
  ValidationError,
} from '../../../errors/src/index.ts';

// ---------------------------------------------------------------------------
// 1. Queue a payout
// ---------------------------------------------------------------------------

export interface QueuePayoutResult {
  payoutId: string | null;
  amountToman: string | null;
  reason?: string;
}

/**
 * Move a merchant's AVAILABLE liability into SETTLING and create the payout.
 *
 * The partial unique index `ux_payouts_merchant_in_flight` guarantees a merchant
 * can only have one in-flight payout, which is what closes the double-spend
 * race described in SPEC 117.89.
 */
export async function queuePayoutForMerchant(
  db: Database,
  config: Config,
  merchantId: string,
): Promise<QueuePayoutResult> {
  return db.transaction(
    async (tx) => {
      const merchantRes = await tx.query<{ id: string; status: string; auto_payout: boolean }>(
        'SELECT id, status, auto_payout FROM core.merchants WHERE id = $1 FOR UPDATE',
        [merchantId],
      );
      const merchant = merchantRes.rows[0];
      if (!merchant) throw new NotFoundError('merchant', merchantId);
      if (merchant.status !== 'ACTIVE') {
        return { payoutId: null, amountToman: null, reason: 'MERCHANT_NOT_ACTIVE' };
      }
      if (!merchant.auto_payout || !config.settlement.autoPayoutEnabled) {
        return { payoutId: null, amountToman: null, reason: 'AUTO_PAYOUT_DISABLED' };
      }

      // Already has a payout in flight — nothing to do.
      const inFlight = await tx.query(
        `SELECT 1 FROM finance.payouts
          WHERE merchant_id = $1
            AND status IN ('CREATED','QUEUED','RATE_LOCKED','WAITING_LIQUIDITY','RESERVED','BROADCASTED','UNKNOWN')
          LIMIT 1`,
        [merchantId],
      );
      if (inFlight.rowCount > 0) {
        return { payoutId: null, amountToman: null, reason: 'PAYOUT_ALREADY_IN_FLIGHT' };
      }

      // SPEC 1256 — wallet must be verified and ACTIVE before any payout.
      const walletRes = await tx.query<{
        id: string;
        address: string;
        network: string;
        status: string;
        hold_until: string | null;
      }>(
        `SELECT id, address, network, status, hold_until
           FROM core.wallets
          WHERE merchant_id = $1 AND status = 'ACTIVE'
          FOR UPDATE`,
        [merchantId],
      );
      const wallet = walletRes.rows[0];
      if (!wallet) {
        return { payoutId: null, amountToman: null, reason: ErrorCodes.WALLET_NOT_ACTIVE };
      }
      if (wallet.hold_until && new Date(wallet.hold_until) > new Date()) {
        return { payoutId: null, amountToman: null, reason: 'WALLET_SECURITY_HOLD' };
      }

      const merchantAccount = await getOrCreateMerchantAccount(tx, merchantId);
      const balanceRes = await tx.query<{ available: string }>(
        `SELECT COALESCE(available,0)::text AS available
           FROM finance.balances WHERE account_id = $1 FOR UPDATE`,
        [merchantAccount],
      );
      const available = Money.toman(balanceRes.rows[0]?.available ?? '0');

      if (available.atomic < config.settlement.minPayoutToman) {
        return { payoutId: null, amountToman: null, reason: 'BELOW_MINIMUM' };
      }
      // Cap a single payout so one huge settlement cannot drain the treasury.
      const amount =
        available.atomic > config.settlement.maxPayoutToman
          ? Money.toman(config.settlement.maxPayoutToman)
          : available;
      assertTomanWithinBounds(amount.atomic, 'payout amount');

      const payoutId = randomUUID();
      await tx.query(
        `INSERT INTO finance.payouts
            (id, merchant_id, wallet_id, amount_toman, status,
             destination_address, destination_network)
         VALUES ($1,$2,$3,$4,'CREATED',$5,$6)`,
        [payoutId, merchantId, wallet.id, amount.toAtomicString(), wallet.address, wallet.network],
      );

      // Which released payments this payout settles, oldest first.
      //
      // The per-payment figure must be scoped to the MERCHANT'S OWN liability
      // account: a payment journal also touches the provider clearing asset and
      // platform revenue, and summing those in would net to zero.
      // Allocate payments up to EXACTLY the payout amount, oldest first.
      //
      // Two bugs live here if this is done carelessly:
      //
      //  1. Without the running-total cap, every unallocated payment is
      //     attached regardless of the payout's size, so the items can sum to
      //     more than the payout itself and the audit trail contradicts the
      //     ledger.
      //
      //  2. Excluding any payment that has EVER appeared in payout_items
      //     strands money permanently: a failed payout returns the funds to
      //     AVAILABLE but leaves its rows behind, so the payment is spendable
      //     in the ledger yet invisible to every future selection. Only items
      //     belonging to a LIVE payout may exclude a payment.
      //
      // A payment larger than the remaining room is left for the next payout
      // rather than partially attached, so an item always means "this payment
      // was settled by this payout".
      await tx.query(
        `INSERT INTO finance.payout_items(payout_id, payment_id, amount_toman)
         SELECT $1, payment_id, amount
           FROM (
             SELECT src.payment_id,
                    src.amount,
                    SUM(src.amount) OVER (ORDER BY src.released_at, src.payment_id
                                          ROWS UNBOUNDED PRECEDING) AS running_total
               FROM (
                 SELECT p.id AS payment_id,
                        p.released_at,
                        COALESCE((SELECT SUM(e.credit - e.debit)
                                    FROM finance.journal_entries e
                                    JOIN finance.journals j ON j.id = e.journal_id
                                   WHERE j.reference_type = 'PAYMENT'
                                     AND j.reference_id = p.id
                                     AND e.account_id = $3
                                     AND e.bucket = 'AVAILABLE'), 0) AS amount
                   FROM core.payments p
                  WHERE p.merchant_id = $2
                    AND p.status = 'RELEASED'
                    AND NOT EXISTS (
                          SELECT 1 FROM finance.payout_items pi
                           WHERE pi.payment_id = p.id AND pi.is_live)
               ) src
              WHERE src.amount > 0
           ) ranked
          WHERE running_total <= $4::numeric
          ORDER BY running_total
         ON CONFLICT DO NOTHING`,
        [payoutId, merchantId, merchantAccount, amount.toAtomicString()],
      );

      // AVAILABLE -> SETTLING on the merchant's liability account.
      const posting = await post(tx, {
        referenceType: 'PAYOUT',
        referenceId: payoutId,
        operationId: `payout:queued:${payoutId}`,
        description: 'available liability moved to settling',
        lines: [
          { accountId: merchantAccount, debit: amount, bucket: 'AVAILABLE' },
          { accountId: merchantAccount, credit: amount, bucket: 'SETTLING' },
        ],
      });
      if (!posting.created) {
        throw new FinancialError(ErrorCodes.DUPLICATE_OPERATION, 'payout queue posting already exists');
      }

      await transitionState(tx, {
        table: 'finance.payouts',
        entityType: 'PAYOUT',
        entityId: payoutId,
        fromState: 'CREATED',
        toState: 'QUEUED',
        event: 'QUEUE',
        actorType: 'WORKER',
      });

      await enqueue(tx, {
        eventType: 'payout.queued',
        aggregateType: 'PAYOUT',
        aggregateId: payoutId,
        payload: {
          payout_id: payoutId,
          merchant_id: merchantId,
          amount_toman: amount.toAtomicString(),
        },
      });

      return { payoutId, amountToman: amount.toAtomicString() };
    },
    { isolation: 'SERIALIZABLE', retries: 3 },
  );
}

// ---------------------------------------------------------------------------
// 2. Lock the rate
// ---------------------------------------------------------------------------

export async function lockPayoutRate(
  db: Database,
  config: Config,
  rateProvider: RateProvider,
  payoutId: string,
): Promise<{ gramAmount: string; rate: string }> {
  // The quote is fetched OUTSIDE the transaction: no HTTP inside a financial
  // transaction (SPEC 4347).
  const quote = await rateProvider.getQuote('TOMAN', 'GRAM');

  return db.transaction(async (tx) => {
    const r = await tx.query<{ id: string; status: string; amount_toman: string }>(
      `SELECT id, status, amount_toman::text FROM finance.payouts WHERE id = $1 FOR UPDATE`,
      [payoutId],
    );
    const payout = r.rows[0];
    if (!payout) throw new NotFoundError('payout', payoutId);
    if (payout.status !== 'QUEUED' && payout.status !== 'WAITING_LIQUIDITY') {
      throw new PayoutError('PAYOUT_NOT_LOCKABLE', `payout is ${payout.status}`);
    }

    if (quote.expiresAt <= new Date()) {
      throw new PayoutError(ErrorCodes.RATE_QUOTE_EXPIRED, 'rate quote expired before it could be locked', {
        retryable: true,
      });
    }

    const rate = Rate.of(quote.tomanPerGram, quote.source);
    const amountToman = Money.toman(payout.amount_toman);
    // FLOOR: never pay out more GRAM than the Toman liability covers.
    const gramAmount = rate.tomanToGram(amountToman, 'FLOOR');

    if (!gramAmount.isPositive()) {
      throw new PayoutError('PAYOUT_AMOUNT_TOO_SMALL', 'payout converts to zero GRAM');
    }
    // A corrupt or hostile quote could otherwise blow past NUMERIC(40,0).
    assertGramWithinBounds(gramAmount.atomic, 'converted GRAM amount');

    // Persist the quote so the snapshot is auditable.
    await tx.query(
      `INSERT INTO finance.rate_quotes(id, base_currency, quote_asset, rate, source, expires_at)
       VALUES ($1,'TOMAN','GRAM',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [quote.id, rate.toDbString(), quote.source, quote.expiresAt.toISOString()],
    );

    await transitionState(tx, {
      table: 'finance.payouts',
      entityType: 'PAYOUT',
      entityId: payoutId,
      fromState: ['QUEUED', 'WAITING_LIQUIDITY'],
      toState: 'RATE_LOCKED',
      event: 'LOCK_RATE',
      extraSet: {
        rate: rate.toDbString(),
        rate_source: quote.source,
        quote_id: quote.id,
        gram_amount_atomic: gramAmount.toAtomicString(),
        rate_locked_at: new Date().toISOString(),
        quote_expires_at: quote.expiresAt.toISOString(),
      },
      actorType: 'WORKER',
    });

    return { gramAmount: gramAmount.toAtomicString(), rate: rate.toDbString() };
  });
}

// ---------------------------------------------------------------------------
// 3. Reserve liquidity
// ---------------------------------------------------------------------------

export interface ReserveResult {
  reserved: boolean;
  reservationId?: string;
  required?: string;
  spendable?: string;
}

/**
 * Reserve the full GRAM amount, or park the payout in WAITING_LIQUIDITY.
 *
 * SPEC 118.59: Spendable = confirmed balance - active reservations - safety reserve.
 * SPEC 119.25 / 124.169: a shortage means WAIT, never auto-buy.
 * Partial reservation is not permitted — either the whole amount is available or
 * the payout waits.
 */
export async function reservePayoutLiquidity(
  db: Database,
  config: Config,
  payoutId: string,
): Promise<ReserveResult> {
  return db.transaction(
    async (tx) => {
      const r = await tx.query<{
        id: string;
        status: string;
        gram_amount_atomic: string | null;
        merchant_id: string;
      }>(
        `SELECT id, status, gram_amount_atomic::text, merchant_id
           FROM finance.payouts WHERE id = $1 FOR UPDATE`,
        [payoutId],
      );
      const payout = r.rows[0];
      if (!payout) throw new NotFoundError('payout', payoutId);
      if (payout.status !== 'RATE_LOCKED') {
        throw new PayoutError('PAYOUT_NOT_RESERVABLE', `payout is ${payout.status}`);
      }
      if (!payout.gram_amount_atomic) {
        throw new PayoutError('PAYOUT_RATE_NOT_LOCKED', 'payout has no locked GRAM amount');
      }

      const required = Money.gram(payout.gram_amount_atomic);

      // Lock the treasury row so a concurrent reservation cannot double-spend it.
      const treasuryRes = await tx.query<{
        id: string;
        confirmed_balance_atomic: string;
        safety_reserve_atomic: string;
        status: string;
      }>(
        `SELECT id, confirmed_balance_atomic::text, safety_reserve_atomic::text, status
           FROM finance.treasury_accounts
          WHERE asset = 'GRAM' AND network = $1 AND status = 'ACTIVE'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE`,
        [config.treasury.network],
      );
      const treasury = treasuryRes.rows[0];
      if (!treasury) {
        throw new PayoutError('TREASURY_UNAVAILABLE', 'no active GRAM treasury account is configured');
      }

      const activeRes = await tx.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_atomic),0)::text AS total
           FROM finance.liquidity_reservations
          WHERE treasury_account_id = $1 AND status = 'ACTIVE'`,
        [treasury.id],
      );

      const confirmed = Money.gram(treasury.confirmed_balance_atomic);
      const reservedAlready = Money.gram(activeRes.rows[0]?.total ?? '0');
      const safety = Money.gram(treasury.safety_reserve_atomic);
      const spendable = confirmed.subtract(reservedAlready).subtract(safety);

      if (spendable.lt(required)) {
        // SPEC 124.169 — wait, do not buy.
        await transitionState(tx, {
          table: 'finance.payouts',
          entityType: 'PAYOUT',
          entityId: payoutId,
          fromState: 'RATE_LOCKED',
          toState: 'WAITING_LIQUIDITY',
          event: 'INSUFFICIENT_LIQUIDITY',
          actorType: 'WORKER',
          metadata: {
            required: required.toAtomicString(),
            spendable: spendable.toAtomicString(),
          },
        });
        await enqueue(tx, {
          eventType: 'payout.waiting_liquidity',
          aggregateType: 'PAYOUT',
          aggregateId: payoutId,
          payload: {
            payout_id: payoutId,
            merchant_id: payout.merchant_id,
            required_gram: required.toAtomicString(),
            spendable_gram: spendable.toAtomicString(),
          },
        });
        return {
          reserved: false,
          required: required.toAtomicString(),
          spendable: spendable.toAtomicString(),
        };
      }

      const reservationId = randomUUID();
      const expiresAt = new Date(Date.now() + config.settlement.reservationTtlSeconds * 1000);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO finance.liquidity_reservations
            (id, payout_id, treasury_account_id, amount_atomic, status, expires_at)
         VALUES ($1,$2,$3,$4,'ACTIVE',$5)
         ON CONFLICT (payout_id) WHERE status = 'ACTIVE' DO NOTHING
         RETURNING id`,
        [reservationId, payoutId, treasury.id, required.toAtomicString(), expiresAt.toISOString()],
      );
      if (inserted.rows.length === 0) {
        throw new PayoutError('RESERVATION_EXISTS', 'an active reservation already exists for this payout');
      }

      await transitionState(tx, {
        table: 'finance.payouts',
        entityType: 'PAYOUT',
        entityId: payoutId,
        fromState: 'RATE_LOCKED',
        toState: 'RESERVED',
        event: 'RESERVE_LIQUIDITY',
        extraSet: { reserved_at: new Date().toISOString() },
        actorType: 'WORKER',
      });

      return { reserved: true, reservationId, required: required.toAtomicString() };
    },
    { isolation: 'SERIALIZABLE', retries: 3 },
  );
}

// ---------------------------------------------------------------------------
// 4. Sign
// ---------------------------------------------------------------------------

/**
 * Sign the payout transaction — SPEC 90.10.
 *
 * Signing is deliberately a separate state from broadcasting. Once a payload is
 * signed it must never be rebuilt: a second signature over the same payout is
 * a second spendable transaction. SPEC 5498 is explicit that a worker may not
 * construct a new transaction while the previous one's fate is undecided.
 *
 * Every guard from SPEC 90.10 is re-checked here rather than trusted from the
 * reservation step, because time has passed and the world may have moved.
 */
export async function signPayout(
  db: Database,
  chain: BlockchainPayoutPort,
  config: Config,
  payoutId: string,
  signer?: SignerPort,
): Promise<{ status: 'SIGNED'; signingReference: string }> {
  // --- phase 1: validate, inside a short transaction ------------------------
  //
  // The signer is an external service (KMS/HSM over the network). Calling it
  // while holding FOR UPDATE would pin a row lock and a database connection for
  // the whole round trip, and a slow or hanging signer would stall every other
  // payout behind it. SPEC 56.36 forbids an external call inside a financial
  // transaction, so validation commits first and the signer is called with no
  // transaction open.
  const prepared = await db.transaction(async (tx) => {
    const r = await tx.query<{
      id: string;
      status: string;
      gram_amount_atomic: string | null;
      destination_address: string;
      destination_network: string;
      merchant_id: string;
      signing_reference: string | null;
    }>(
      `SELECT id, status, gram_amount_atomic::text, destination_address,
              destination_network, merchant_id, signing_reference
         FROM finance.payouts WHERE id = $1 FOR UPDATE`,
      [payoutId],
    );
    const payout = r.rows[0];
    if (!payout) throw new NotFoundError('payout', payoutId);

    // Already signed: return the existing reference instead of signing again.
    if (payout.status === 'SIGNED' && payout.signing_reference) {
      return { alreadySigned: true as const, signingReference: payout.signing_reference };
    }
    if (payout.status !== 'RESERVED') {
      throw new PayoutError('PAYOUT_NOT_SIGNABLE', `payout is ${payout.status}`);
    }

    // SPEC 90.10 — check rate lock, asset, network, wallet before signing.
    if (!payout.gram_amount_atomic) {
      throw new PayoutError('RATE_NOT_LOCKED', 'cannot sign before the rate is locked');
    }
    if (config.ton.gramAsset !== 'GRAM') {
      throw new PayoutError('INVALID_SETTLEMENT_ASSET', 'settlement asset must be GRAM');
    }
    if (payout.destination_network !== config.ton.network) {
      throw new PayoutError('NETWORK_MISMATCH', 'payout network does not match configuration');
    }
    if (!chain.isValidAddress(payout.destination_address, payout.destination_network)) {
      throw new PayoutError('WALLET_INVALID', 'destination address is not valid for this network');
    }

    const reservation = await tx.query<{ amount_atomic: string }>(
      `SELECT amount_atomic::text FROM finance.liquidity_reservations
        WHERE payout_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()`,
      [payoutId],
    );
    const active = reservation.rows[0];
    if (!active) {
      throw new PayoutError('RESERVATION_MISSING_OR_EXPIRED', 'no valid liquidity reservation');
    }
    if (active.amount_atomic !== payout.gram_amount_atomic) {
      throw new PayoutError(
        'PAYOUT_AMOUNT_MISMATCH',
        'reserved liquidity does not match the locked payout amount',
      );
    }

    return {
      alreadySigned: false as const,
      amountAtomic: payout.gram_amount_atomic,
      destinationAddress: payout.destination_address,
      destinationNetwork: payout.destination_network,
    };
  });

  if (prepared.alreadySigned) {
    return { status: 'SIGNED' as const, signingReference: prepared.signingReference };
  }

  // --- phase 2: sign, with no transaction held ------------------------------
  //
  // The sign request id is derived from the payout, so a retry after a crash
  // presents the SAME id and the signer refuses to produce a second signature
  // for money that may already be committed (SPEC 5569/5570). That idempotency
  // is what makes it safe to do this outside the transaction.
  let signingReference: string;
  if (signer) {
    const signed = await signer.sign({
      signRequestId: `payout:${payoutId}`,
      payoutId,
      asset: config.ton.gramAsset,
      network: prepared.destinationNetwork,
      destinationAddress: prepared.destinationAddress,
      amountAtomic: prepared.amountAtomic,
      fromAddress: config.ton.payoutWalletAddress ?? '',
    });
    signingReference = signed.signingReference;
  } else {
    // No signer wired up (development). The state machine still records that
    // signing happened, so the SIGNED stage cannot be skipped by accident.
    signingReference = `unsigned:${payoutId}`;
  }

  // --- phase 3: record the signature ----------------------------------------
  //
  // If the process dies between phase 2 and here the payout stays RESERVED and
  // is retried; the signer returns the same reference for the same request id
  // rather than signing twice.
  return db.transaction(async (tx) => {
    const current = await tx.query<{ status: string; signing_reference: string | null }>(
      'SELECT status, signing_reference FROM finance.payouts WHERE id = $1 FOR UPDATE',
      [payoutId],
    );
    const row = current.rows[0];
    if (!row) throw new NotFoundError('payout', payoutId);

    // Another worker got there first while we were signing.
    if (row.status === 'SIGNED' && row.signing_reference) {
      return { status: 'SIGNED' as const, signingReference: row.signing_reference };
    }
    if (row.status !== 'RESERVED') {
      throw new PayoutError('PAYOUT_NOT_SIGNABLE', `payout is ${row.status}`);
    }

    await transitionState(tx, {
      table: 'finance.payouts',
      entityType: 'PAYOUT',
      entityId: payoutId,
      fromState: 'RESERVED',
      toState: 'SIGNED',
      event: 'SIGN',
      extraSet: {
        signed_at: new Date().toISOString(),
        signing_reference: signingReference,
      },
      actorType: 'WORKER',
    });

    return { status: 'SIGNED' as const, signingReference };
  });
}

// ---------------------------------------------------------------------------
// 5. Broadcast
// ---------------------------------------------------------------------------

/**
 * Broadcast the payout on TON.
 *
 * The chain call happens outside the transaction. If the RPC result is
 * ambiguous the payout goes to UNKNOWN and is left for reconciliation — it is
 * never re-broadcast blindly (SPEC 124.154 / 124.170).
 */
export async function broadcastPayout(
  db: Database,
  chain: BlockchainPayoutPort,
  payoutId: string,
): Promise<{ status: 'BROADCASTED' | 'UNKNOWN' | 'FAILED'; txHash?: string }> {
  const prepared = await db.transaction(async (tx) => {
    const r = await tx.query<{
      id: string;
      status: string;
      gram_amount_atomic: string | null;
      destination_address: string;
      destination_network: string;
      merchant_id: string;
      attempt_count: number;
    }>(
      `SELECT id, status, gram_amount_atomic::text, destination_address,
              destination_network, merchant_id, attempt_count
         FROM finance.payouts WHERE id = $1 FOR UPDATE`,
      [payoutId],
    );
    const payout = r.rows[0];
    if (!payout) throw new NotFoundError('payout', payoutId);
    // SPEC 5502 — only a SIGNED payout may be broadcast.
    if (payout.status !== 'SIGNED') {
      throw new PayoutError('PAYOUT_NOT_BROADCASTABLE', `payout is ${payout.status}`);
    }

    const reservation = await tx.query<{ id: string; amount_atomic: string }>(
      `SELECT id, amount_atomic::text FROM finance.liquidity_reservations
        WHERE payout_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()`,
      [payoutId],
    );
    const activeReservation = reservation.rows[0];
    if (!activeReservation) {
      throw new PayoutError('RESERVATION_MISSING_OR_EXPIRED', 'no valid liquidity reservation');
    }

    // SPEC 97.115 — destination guard. The address we are about to pay must
    // still be the merchant's active wallet. A wallet change mid-flight must
    // never silently redirect funds.
    const wallet = await tx.query<{ address: string; network: string }>(
      `SELECT address, network FROM core.wallets
        WHERE merchant_id = $1 AND status = 'ACTIVE'`,
      [payout.merchant_id],
    );
    const activeWallet = wallet.rows[0];
    if (
      !activeWallet ||
      activeWallet.address !== payout.destination_address ||
      activeWallet.network !== payout.destination_network
    ) {
      throw new PayoutError(
        'DESTINATION_MISMATCH',
        'payout destination no longer matches the active wallet snapshot',
      );
    }

    // SPEC 97.116 — amount guard. The GRAM figure must be exactly what the
    // rate lock produced and exactly what liquidity was reserved for.
    if (activeReservation.amount_atomic !== payout.gram_amount_atomic) {
      throw new PayoutError(
        'PAYOUT_AMOUNT_MISMATCH',
        'reserved liquidity does not match the locked payout amount',
      );
    }

    await tx.query(
      'UPDATE finance.payouts SET attempt_count = attempt_count + 1, updated_at = NOW() WHERE id = $1',
      [payoutId],
    );

    return {
      amount: Money.gram(payout.gram_amount_atomic as string),
      destination: payout.destination_address,
      network: payout.destination_network,
      merchantId: payout.merchant_id,
    };
  });

  let result: BroadcastResult;
  try {
    result = await chain.send({
      // A deterministic idempotency key so a retry at the adapter level cannot
      // produce a second on-chain transfer.
      idempotencyKey: `payout:${payoutId}`,
      to: prepared.destination,
      amountAtomic: prepared.amount.atomic,
      network: prepared.network,
    });
  } catch (e) {
    // The send may or may not have reached the network: treat as UNKNOWN.
    await markUnknown(db, payoutId, e instanceof Error ? e.message : String(e));
    return { status: 'UNKNOWN' };
  }

  if (result.status === 'UNKNOWN') {
    await markUnknown(db, payoutId, result.error ?? 'adapter reported UNKNOWN');
    return { status: 'UNKNOWN' };
  }

  if (result.status === 'REJECTED') {
    // Definitively not sent: release the reservation and return the money.
    await failPayout(db, payoutId, result.error ?? 'REJECTED_BY_NETWORK');
    return { status: 'FAILED' };
  }

  await db.transaction(async (tx) => {
    await transitionState(tx, {
      table: 'finance.payouts',
      entityType: 'PAYOUT',
      entityId: payoutId,
      fromState: 'SIGNED',
      toState: 'BROADCASTED',
      event: 'BROADCAST',
      extraSet: {
        transaction_hash: result.txHash ?? null,
        broadcasted_at: new Date().toISOString(),
      },
      actorType: 'WORKER',
    });
    const raw = JSON.stringify(result.raw ?? {});
    await tx.query(
      `INSERT INTO integration.provider_evidence
          (id, payout_id, provider, kind, raw_payload, payload_hash)
       VALUES ($1,$2,'TON','BROADCAST',$3::jsonb,$4)`,
      [randomUUID(), payoutId, raw, sha256Hex(raw)],
    );
    await enqueue(tx, {
      eventType: 'payout.broadcasted',
      aggregateType: 'PAYOUT',
      aggregateId: payoutId,
      payload: {
        payout_id: payoutId,
        merchant_id: prepared.merchantId,
        tx_hash: result.txHash,
        gram_amount: prepared.amount.toAtomicString(),
      },
    });
  });

  return { status: 'BROADCASTED', txHash: result.txHash };
}

async function markUnknown(db: Database, payoutId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await transitionState(tx, {
      table: 'finance.payouts',
      entityType: 'PAYOUT',
      entityId: payoutId,
      fromState: ['RESERVED', 'SIGNED', 'BROADCASTED'],
      toState: 'UNKNOWN',
      event: 'BROADCAST_UNKNOWN',
      extraSet: { failure_code: reason.slice(0, 200) },
      actorType: 'WORKER',
    });
    await tx.query(
      `INSERT INTO system.reconciliation_exceptions
         (id, kind, severity, entity_type, entity_id, details)
       VALUES ($1,'UNKNOWN','HIGH','PAYOUT',$2,$3::jsonb)`,
      [randomUUID(), payoutId, JSON.stringify({ reason })],
    );
    await enqueue(tx, {
      eventType: 'payout.unknown',
      aggregateType: 'PAYOUT',
      aggregateId: payoutId,
      payload: { payout_id: payoutId, reason },
    });
  });
}

// ---------------------------------------------------------------------------
// 5. Settle / fail
// ---------------------------------------------------------------------------

/**
 * Evidence that a payout actually landed on chain.
 *
 * Every field is required because settlement is irreversible: once the merchant
 * liability is closed there is nothing to undo. A caller cannot assert
 * settlement from a transaction hash alone — the amount, destination, asset and
 * network must all have been read back from the chain and must all match the
 * snapshot taken when the payout was locked (SPEC 124.168, 97.115, 97.116).
 */
export interface ChainSettlementEvidence {
  txHash: string;
  /** Amount observed ON CHAIN, in nanogram. Not the amount we intended. */
  onChainAmountAtomic: bigint;
  /** Destination observed on chain. */
  onChainDestination: string;
  asset: string;
  network: string;
  confirmations: number;
  /** Network fee actually charged, in nanogram, when the chain reports it. */
  networkFeeAtomic?: bigint;
}

/**
 * Finalise a confirmed payout.
 *
 * SPEC 119.47: close the merchant liability and reduce the treasury.
 * SPEC 119.42: a second confirmation is idempotent and creates no new settlement.
 * SPEC 124.168: NO CHAIN CONFIRMATION -> NO SETTLED.
 *
 * This function is the only place a payout becomes SETTLED, so it re-verifies
 * the evidence itself rather than trusting whoever called it.
 */
export async function settlePayout(
  db: Database,
  payoutId: string,
  confirmation: ChainSettlementEvidence,
  options: { minConfirmations?: number } = {},
): Promise<{ settled: boolean }> {
  return db.transaction(
    async (tx) => {
      const r = await tx.query<{
        id: string;
        status: string;
        merchant_id: string;
        amount_toman: string;
        gram_amount_atomic: string | null;
        destination_address: string;
        destination_network: string;
      }>(
        `SELECT id, status, merchant_id, amount_toman::text, gram_amount_atomic::text,
                destination_address, destination_network
           FROM finance.payouts WHERE id = $1 FOR UPDATE`,
        [payoutId],
      );
      const payout = r.rows[0];
      if (!payout) throw new NotFoundError('payout', payoutId);

      if (payout.status === 'SETTLED') return { settled: false }; // idempotent replay
      if (payout.status !== 'BROADCASTED' && payout.status !== 'UNKNOWN') {
        throw new PayoutError('PAYOUT_NOT_SETTLEABLE', `payout is ${payout.status}`);
      }

      const amountToman = Money.toman(payout.amount_toman);
      const gramAmount = Money.gram(payout.gram_amount_atomic ?? '0');

      // --- verify the chain evidence before anything is posted ---------------
      //
      // These are the same guards the broadcast path applies, re-applied here
      // because settlement is irreversible and this is the last gate.

      if (confirmation.asset !== 'GRAM') {
        throw new PayoutError('SETTLEMENT_ASSET_MISMATCH', `chain reports asset ${confirmation.asset}`);
      }
      if (confirmation.network !== payout.destination_network) {
        throw new PayoutError(
          'SETTLEMENT_NETWORK_MISMATCH',
          `chain reports network ${confirmation.network}, expected ${payout.destination_network}`,
        );
      }
      if (confirmation.onChainDestination !== payout.destination_address) {
        // Money reached an address that is not the one we locked. Never close
        // the liability on that basis.
        throw new PayoutError(
          'SETTLEMENT_DESTINATION_MISMATCH',
          'the on-chain destination does not match the payout snapshot',
        );
      }
      if (confirmation.onChainAmountAtomic !== gramAmount.atomic) {
        throw new PayoutError(
          'SETTLEMENT_AMOUNT_MISMATCH',
          'the on-chain amount does not match the locked payout amount',
        );
      }
      const required = options.minConfirmations ?? 1;
      if (confirmation.confirmations < required) {
        throw new PayoutError(
          'SETTLEMENT_NOT_CONFIRMED',
          `only ${confirmation.confirmations} confirmations, ${required} required`,
        );
      }

      const merchantAccount = await getOrCreateMerchantAccount(tx, payout.merchant_id);
      const treasuryAccount = await getSystemAccountId(tx, 'TREASURY_GRAM');
      const settlementAccount = await getSystemAccountId(tx, 'SETTLEMENT_CLEARING_TOMAN');
      const feeExpenseAccount = await getSystemAccountId(tx, 'NETWORK_FEE_EXPENSE_GRAM');

      // The network fee is a SEPARATE cost from the merchant's principal.
      //
      // Booking the whole payout as a network fee — as this once did — made the
      // ledger claim the platform spent the entire settlement on gas, so
      // treasury, ledger and chain could never be reconciled against one
      // another. The principal leaves the treasury on the merchant's behalf;
      // the fee leaves it as a platform expense (SPEC 104008).
      const networkFee = Money.gram(confirmation.networkFeeAtomic ?? 0n);
      const totalGramOut = gramAmount.add(networkFee);

      // Two balanced currency legs in one journal:
      //   TOMAN: DR merchant liability (SETTLING)   CR settlement clearing
      //   GRAM : DR settlement clearing (principal) + DR network fee expense
      //          CR treasury asset (principal + fee)
      const settlementGramAccount = await getSystemAccountId(tx, 'SETTLEMENT_CLEARING_GRAM');

      const lines = [
        { accountId: merchantAccount, debit: amountToman, bucket: 'SETTLING' as const },
        { accountId: settlementAccount, credit: amountToman, bucket: 'AVAILABLE' as const },
        // The principal: GRAM sent on the merchant's behalf.
        { accountId: settlementGramAccount, debit: gramAmount, bucket: 'AVAILABLE' as const },
        ...(networkFee.isPositive()
          ? [{ accountId: feeExpenseAccount, debit: networkFee, bucket: 'AVAILABLE' as const }]
          : []),
        { accountId: treasuryAccount, credit: totalGramOut, bucket: 'AVAILABLE' as const },
      ];

      const posting = await post(tx, {
        referenceType: 'PAYOUT',
        referenceId: payoutId,
        operationId: `payout:settled:${payoutId}`,
        description: `payout settled via ${confirmation.txHash}`,
        lines,
      });
      if (!posting.created) return { settled: false };

      // Consume the reservation and reduce the treasury's confirmed balance.
      await tx.query(
        `UPDATE finance.liquidity_reservations
            SET status = 'CONSUMED', released_at = NOW()
          WHERE payout_id = $1 AND status = 'ACTIVE'`,
        [payoutId],
      );
      // The wallet really lost principal + fee, so that is what leaves the
      // recorded balance. Subtracting only the principal would drift the
      // treasury above its true on-chain value by the gas of every payout.
      await tx.query(
        `UPDATE finance.treasury_accounts t
            SET confirmed_balance_atomic = confirmed_balance_atomic - $2,
                updated_at = NOW()
           FROM finance.liquidity_reservations r
          WHERE r.payout_id = $1 AND r.treasury_account_id = t.id`,
        [payoutId, totalGramOut.toAtomicString()],
      );
      await tx.query(
        `INSERT INTO finance.treasury_transactions
            (id, treasury_account_id, direction, asset, amount_atomic,
             external_tx_hash, status, source, payout_id, confirmed_at)
         SELECT $1, r.treasury_account_id, 'OUT', 'GRAM', $2, $3, 'CONFIRMED', 'PAYOUT', $4, NOW()
           FROM finance.liquidity_reservations r
          WHERE r.payout_id = $4
          LIMIT 1
         ON CONFLICT DO NOTHING`,
        [randomUUID(), totalGramOut.toAtomicString(), confirmation.txHash, payoutId],
      );

      // The network fee is booked separately so it is auditable on its own.
      if (networkFee.isPositive()) {
        await tx.query(
          `INSERT INTO finance.treasury_transactions
              (id, treasury_account_id, direction, asset, amount_atomic,
               external_tx_hash, status, source, payout_id, confirmed_at)
           SELECT $1, r.treasury_account_id, 'OUT', 'GRAM', $2, $3, 'CONFIRMED', 'NETWORK_FEE', $4, NOW()
             FROM finance.liquidity_reservations r
            WHERE r.payout_id = $4
            LIMIT 1
           ON CONFLICT DO NOTHING`,
          [randomUUID(), networkFee.toAtomicString(), `${confirmation.txHash}:fee`, payoutId],
        );
      }

      await transitionState(tx, {
        table: 'finance.payouts',
        entityType: 'PAYOUT',
        entityId: payoutId,
        fromState: ['BROADCASTED', 'UNKNOWN'],
        toState: 'SETTLED',
        event: 'CONFIRM',
        extraSet: {
          confirmed_at: new Date().toISOString(),
          transaction_hash: confirmation.txHash,
          failure_code: null,
        },
        actorType: 'WORKER',
      });

      await enqueue(tx, {
        eventType: 'payout.confirmed',
        aggregateType: 'PAYOUT',
        aggregateId: payoutId,
        payload: {
          payout_id: payoutId,
          merchant_id: payout.merchant_id,
          amount_toman: amountToman.toAtomicString(),
          gram_amount: gramAmount.toAtomicString(),
          tx_hash: confirmation.txHash,
        },
      });

      return { settled: true };
    },
    { isolation: 'SERIALIZABLE', retries: 3 },
  );
}

/**
 * Fail a payout and return the money to AVAILABLE.
 * SPEC 119.48: SETTLING -> AVAILABLE, reservation ACTIVE -> RELEASED.
 * Only legal when we know the transfer definitively did NOT happen.
 */
export async function failPayout(
  db: Database,
  payoutId: string,
  reason: string,
): Promise<{ failed: boolean }> {
  return db.transaction(
    async (tx) => {
      const r = await tx.query<{
        id: string;
        status: string;
        merchant_id: string;
        amount_toman: string;
      }>(
        `SELECT id, status, merchant_id, amount_toman::text
           FROM finance.payouts WHERE id = $1 FOR UPDATE`,
        [payoutId],
      );
      const payout = r.rows[0];
      if (!payout) throw new NotFoundError('payout', payoutId);
      if (payout.status === 'FAILED') return { failed: false };
      if (payout.status === 'SETTLED') {
        throw new PayoutError('PAYOUT_ALREADY_SETTLED', 'a settled payout cannot be failed');
      }
      if (payout.status === 'UNKNOWN') {
        // SPEC 124.170: an UNKNOWN payout must be resolved by reconciliation.
        throw new PayoutError(
          ErrorCodes.PAYOUT_UNKNOWN_NO_BLIND_RETRY,
          'an UNKNOWN payout must be resolved by chain reconciliation, not failed blindly',
        );
      }

      const amount = Money.toman(payout.amount_toman);
      const merchantAccount = await getOrCreateMerchantAccount(tx, payout.merchant_id);

      const posting = await post(tx, {
        referenceType: 'PAYOUT',
        referenceId: payoutId,
        operationId: `payout:failed:${payoutId}`,
        description: `payout failed: ${reason}`,
        lines: [
          { accountId: merchantAccount, debit: amount, bucket: 'SETTLING' },
          { accountId: merchantAccount, credit: amount, bucket: 'AVAILABLE' },
        ],
      });
      if (!posting.created) return { failed: false };

      await tx.query(
        `UPDATE finance.liquidity_reservations
            SET status = 'RELEASED', released_at = NOW()
          WHERE payout_id = $1 AND status = 'ACTIVE'`,
        [payoutId],
      );

      await transitionState(tx, {
        table: 'finance.payouts',
        entityType: 'PAYOUT',
        entityId: payoutId,
        fromState: [
          'CREATED',
          'QUEUED',
          'RATE_LOCKED',
          'WAITING_LIQUIDITY',
          'RESERVED',
          'SIGNED',
          'BROADCASTED',
        ],
        toState: 'FAILED',
        event: 'FAIL',
        extraSet: { failure_code: reason.slice(0, 200) },
        actorType: 'WORKER',
      });

      await enqueue(tx, {
        eventType: 'payout.failed',
        aggregateType: 'PAYOUT',
        aggregateId: payoutId,
        payload: { payout_id: payoutId, merchant_id: payout.merchant_id, reason },
      });

      return { failed: true };
    },
    { isolation: 'SERIALIZABLE', retries: 3 },
  );
}

// ---------------------------------------------------------------------------
// 6. Reconcile
// ---------------------------------------------------------------------------

/**
 * ReconcilePayoutUseCase — SPEC 117.55 / 124.154.
 * Query the chain for the real outcome of an UNKNOWN or BROADCASTED payout and
 * resolve it. This is the ONLY path out of UNKNOWN.
 */
export async function reconcilePayout(
  db: Database,
  chain: BlockchainPayoutPort,
  payoutId: string,
  config: Config,
): Promise<{ resolution: 'SETTLED' | 'FAILED' | 'STILL_UNKNOWN' }> {
  const r = await db.query<{
    id: string;
    status: string;
    transaction_hash: string | null;
    destination_address: string;
    destination_network: string;
    gram_amount_atomic: string | null;
    updated_at: string;
  }>(
    `SELECT id, status, transaction_hash, destination_address, destination_network,
            gram_amount_atomic::text, updated_at
       FROM finance.payouts WHERE id = $1`,
    [payoutId],
  );
  const payout = r.rows[0];
  if (!payout) throw new NotFoundError('payout', payoutId);
  if (payout.status !== 'UNKNOWN' && payout.status !== 'BROADCASTED') {
    return { resolution: 'STILL_UNKNOWN' };
  }

  const status = await chain.getTransferStatus({
    idempotencyKey: `payout:${payoutId}`,
    txHash: payout.transaction_hash,
    to: payout.destination_address,
    amountAtomic: BigInt(payout.gram_amount_atomic ?? '0'),
  });

  if (
    status.state === 'CONFIRMED' &&
    status.txHash &&
    status.onChainAmountAtomic !== undefined &&
    status.onChainDestination !== undefined
  ) {
    await settlePayout(db, payoutId, {
      txHash: status.txHash,
      onChainAmountAtomic: status.onChainAmountAtomic,
      onChainDestination: status.onChainDestination,
      asset: config.ton.gramAsset,
      network: payout.destination_network,
      confirmations: status.confirmations ?? 0,
      ...(status.networkFeeAtomic !== undefined
        ? { networkFeeAtomic: status.networkFeeAtomic }
        : {}),
    });
    await resolveExceptions(db, payoutId);
    return { resolution: 'SETTLED' };
  }

  if (status.state === 'NOT_FOUND') {
    // "The RPC cannot see it" is not "it does not exist". An indexer lagging,
    // a node still syncing, or a transaction sitting in the mempool all look
    // identical to a genuine absence, and returning the funds while the
    // transfer is actually in flight would pay the merchant twice.
    //
    // So NOT_FOUND only becomes definitive after the payout has been
    // unresolved for longer than any plausible propagation delay.
    const ageMs = Date.now() - new Date(payout.updated_at).getTime();
    const windowMs = (config.settlement.notFoundObservationSeconds ?? 900) * 1000;

    if (ageMs < windowMs) {
      return { resolution: 'STILL_UNKNOWN' };
    }

    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE finance.payouts SET status = 'RESERVED', updated_at = NOW()
          WHERE id = $1 AND status = 'UNKNOWN'`,
        [payoutId],
      );
    });
    await failPayout(db, payoutId, 'RECONCILED_NOT_FOUND_ON_CHAIN');
    await resolveExceptions(db, payoutId);
    return { resolution: 'FAILED' };
  }

  return { resolution: 'STILL_UNKNOWN' };
}

async function resolveExceptions(db: Database, payoutId: string): Promise<void> {
  await db.query(
    `UPDATE system.reconciliation_exceptions
        SET status = 'RESOLVED', resolved_at = NOW()
      WHERE entity_type = 'PAYOUT' AND entity_id = $1 AND status <> 'RESOLVED'`,
    [payoutId],
  );
}

/** SPEC 118.60 — expire stale reservations so liquidity is not locked forever. */
export async function expireStaleReservations(db: Database): Promise<number> {
  return db.transaction(async (tx) => {
    const expired = await tx.query<{ payout_id: string }>(
      `UPDATE finance.liquidity_reservations
          SET status = 'EXPIRED', released_at = NOW()
        WHERE status = 'ACTIVE' AND expires_at < NOW()
        RETURNING payout_id`,
    );
    for (const row of expired.rows) {
      // A payout whose reservation lapsed before broadcast goes back to the queue.
      await tx.query(
        `UPDATE finance.payouts
            SET status = 'RATE_LOCKED', reserved_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'RESERVED'`,
        [row.payout_id],
      );
    }
    return expired.rowCount;
  });
}

/** Manual, owner-only treasury funding (SPEC 119.22 / 104009). */
export async function recordManualTreasuryFunding(
  db: Database,
  params: { treasuryAccountId: string; amountAtomic: bigint; txHash: string; actorId?: string },
): Promise<{ recorded: boolean }> {
  if (params.amountAtomic <= 0n) {
    throw new ValidationError('INVALID_FUNDING_AMOUNT', 'funding amount must be positive');
  }
  // Without this an oversized figure reaches NUMERIC(40,0) and comes back as an
  // opaque 500 instead of a clean rejection.
  assertGramWithinBounds(params.amountAtomic, 'funding amount');
  return db.transaction(async (tx) => {
    const amount = Money.gram(params.amountAtomic);

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO finance.treasury_transactions
          (id, treasury_account_id, direction, asset, amount_atomic,
           external_tx_hash, status, source, detected_at, confirmed_at)
       VALUES ($1,$2,'IN','GRAM',$3,$4,'CONFIRMED','MANUAL',NOW(),NOW())
       ON CONFLICT (external_tx_hash) WHERE external_tx_hash IS NOT NULL DO NOTHING
       RETURNING id`,
      [randomUUID(), params.treasuryAccountId, amount.toAtomicString(), params.txHash],
    );
    if (inserted.rows.length === 0) return { recorded: false };

    await tx.query(
      `UPDATE finance.treasury_accounts
          SET confirmed_balance_atomic = confirmed_balance_atomic + $2, updated_at = NOW()
        WHERE id = $1`,
      [params.treasuryAccountId, amount.toAtomicString()],
    );

    const treasuryAccount = await getSystemAccountId(tx, 'TREASURY_GRAM');
    const equityAccount = await getSystemAccountId(tx, 'TREASURY_FUNDING_EQUITY');
    await post(tx, {
      referenceType: 'TREASURY',
      referenceId: params.treasuryAccountId,
      operationId: `treasury:funded:${params.txHash}`,
      description: 'manual owner treasury funding',
      lines: [
        { accountId: treasuryAccount, debit: amount },
        { accountId: equityAccount, credit: amount },
      ],
    });

    await tx.query(
      `INSERT INTO audit.audit_logs(id, actor_type, actor_id, action, resource_type, resource_id, reason, metadata)
       VALUES ($1,'ADMIN',$2,'TREASURY_FUNDED','TREASURY',$3,'manual funding',$4::jsonb)`,
      [
        randomUUID(),
        params.actorId ?? null,
        params.treasuryAccountId,
        JSON.stringify({ amount: amount.toAtomicString(), tx_hash: params.txHash }),
      ],
    );

    await enqueue(tx, {
      eventType: 'treasury.funded',
      aggregateType: 'TREASURY',
      aggregateId: params.treasuryAccountId,
      payload: { amount: amount.toAtomicString(), tx_hash: params.txHash },
    });

    return { recorded: true };
  });
}
