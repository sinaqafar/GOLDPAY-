/**
 * TON Sequence Number (seqno) Manager & Ordered Dispatcher Gate.
 *
 * Enforces two fundamental invariants required by TON Wallet V4 contracts:
 * 1. Strict Atomic Reservation: Monotonic, collision-free seqnos N, N+1, N+2...
 * 2. Per-Wallet Ordered Broadcast Gate: Transaction with seqno N+1 MUST NEVER be
 *    broadcast to the network before transaction with seqno N is CONFIRMED on-chain.
 *
 * Prevents TON Exit Code 33 (msg_seqno != stored_seqno) failures under high concurrency.
 */

import { randomUUID } from 'node:crypto';
import type { Database, TransactionContext } from '../../database/src/client.ts';

export type DatabaseOrTx = Database | TransactionContext;

export interface SeqnoAllocation {
  id: string;
  payoutId: string;
  treasuryAddress: string;
  allocatedSeqno: number;
  status: 'RESERVED' | 'BROADCASTED' | 'CONFIRMED' | 'EXPIRED' | 'FAILED';
}

export interface BroadcastGateResult {
  allowed: boolean;
  seqno: number | null;
  reason?: 'ALLOWED' | 'NO_ALLOCATION' | 'PREDECESSOR_IN_FLIGHT' | 'PREDECESSOR_FAILED' | 'PREDECESSOR_UNCONFIRMED' | 'ALREADY_CONFIRMED';
  predecessorSeqno?: number;
}

export class TonSeqnoManager {
  /**
   * Atomically allocate the next sequential seqno for a payout inside a DB transaction.
   * If on-chain seqno is N, first payout gets N, next gets N+1, N+2, etc.
   * If the payout already has an active allocation, returns the existing seqno.
   */
  static async allocate(
    db: DatabaseOrTx,
    treasuryAddress: string,
    payoutId: string,
    initialOnChainSeqno = 0,
  ): Promise<number> {
    const run = async (tx: TransactionContext | Database) => {
      // 1. Check if payout already has an allocation
      const existing = await tx.query<{ allocated_seqno: number; status: string }>(
        `SELECT allocated_seqno, status
           FROM finance.payout_seqno_allocations
          WHERE payout_id = $1`,
        [payoutId],
      );

      if (existing.rows[0]) {
        return existing.rows[0].allocated_seqno;
      }

      // 2. Lock and retrieve or initialize the wallet sequence row
      let seqRow = await tx.query<{
        current_onchain_seqno: number;
        next_allocated_seqno: number;
      }>(
        `SELECT current_onchain_seqno, next_allocated_seqno
           FROM finance.treasury_wallet_sequences
          WHERE address = $1
            FOR UPDATE`,
        [treasuryAddress],
      );

      if (!seqRow.rows[0]) {
        // First allocation must use exact on-chain seqno N.
        await tx.query(
          `INSERT INTO finance.treasury_wallet_sequences
              (address, current_onchain_seqno, next_allocated_seqno, confirmed_seqno)
           VALUES ($1, $2, $2, $2)
           ON CONFLICT (address) DO NOTHING`,
          [treasuryAddress, initialOnChainSeqno],
        );

        seqRow = await tx.query(
          `SELECT current_onchain_seqno, next_allocated_seqno
             FROM finance.treasury_wallet_sequences
            WHERE address = $1
              FOR UPDATE`,
          [treasuryAddress],
        );
      }

      const allocated = seqRow.rows[0]?.next_allocated_seqno !== undefined
        ? Number(seqRow.rows[0].next_allocated_seqno)
        : initialOnChainSeqno;

      // 3. Increment sequence counter to allocated + 1
      await tx.query(
        `UPDATE finance.treasury_wallet_sequences
            SET next_allocated_seqno = $2 + 1,
                updated_at = NOW()
          WHERE address = $1`,
        [treasuryAddress, allocated],
      );

      // 4. Record allocation against payout
      await tx.query(
        `INSERT INTO finance.payout_seqno_allocations
            (id, payout_id, treasury_address, allocated_seqno, status)
         VALUES ($1, $2, $3, $4, 'RESERVED')`,
        [randomUUID(), payoutId, treasuryAddress, allocated],
      );

      return allocated;
    };

    if ('transaction' in db && typeof (db as Database).transaction === 'function') {
      return (db as Database).transaction(run);
    }
    return run(db);
  }

  /**
   * Per-Wallet Ordered Broadcast Gate.
   *
   * Verifies if payoutId is permitted to broadcast on the TON network right now.
   * Payout with seqno S is allowed to broadcast ONLY IF:
   * 1. All predecessor seqnos (< S) for this treasury address are CONFIRMED.
   * 2. No predecessor seqno has FAILED (which would create a sequence gap and freeze the chain).
   * 3. No other payout is currently in-flight in BROADCASTED status.
   */
  static async canBroadcast(
    db: DatabaseOrTx,
    treasuryAddress: string,
    payoutId: string,
  ): Promise<BroadcastGateResult> {
    const run = async (tx: TransactionContext | Database): Promise<BroadcastGateResult> => {
      // 1. Get allocated seqno for this payout
      const allocRes = await tx.query<{ allocated_seqno: number; status: string }>(
        `SELECT allocated_seqno, status
           FROM finance.payout_seqno_allocations
          WHERE payout_id = $1`,
        [payoutId],
      );

      const alloc = allocRes.rows[0];
      if (!alloc) {
        return { allowed: false, seqno: null, reason: 'NO_ALLOCATION' };
      }

      if (alloc.status === 'CONFIRMED') {
        return { allowed: false, seqno: alloc.allocated_seqno, reason: 'ALREADY_CONFIRMED' };
      }

      const mySeqno = alloc.allocated_seqno;

      // 2. Lock the wallet sequence state to inspect predecessor allocations
      const seqRow = await tx.query<{
        current_onchain_seqno: number;
        confirmed_seqno: number;
      }>(
        `SELECT current_onchain_seqno, confirmed_seqno
           FROM finance.treasury_wallet_sequences
          WHERE address = $1
            FOR UPDATE`,
        [treasuryAddress],
      );

      // 3. Inspect all allocations for this wallet with allocated_seqno < mySeqno
      const predecessors = await tx.query<{
        allocated_seqno: number;
        status: string;
      }>(
        `SELECT allocated_seqno, status
           FROM finance.payout_seqno_allocations
          WHERE treasury_address = $1
            AND allocated_seqno < $2
          ORDER BY allocated_seqno ASC`,
        [treasuryAddress, mySeqno],
      );

      for (const pred of predecessors.rows) {
        if (pred.status === 'FAILED') {
          return {
            allowed: false,
            seqno: mySeqno,
            reason: 'PREDECESSOR_FAILED',
            predecessorSeqno: pred.allocated_seqno,
          };
        }
        if (pred.status === 'BROADCASTED') {
          return {
            allowed: false,
            seqno: mySeqno,
            reason: 'PREDECESSOR_IN_FLIGHT',
            predecessorSeqno: pred.allocated_seqno,
          };
        }
        if (pred.status !== 'CONFIRMED') {
          return {
            allowed: false,
            seqno: mySeqno,
            reason: 'PREDECESSOR_UNCONFIRMED',
            predecessorSeqno: pred.allocated_seqno,
          };
        }
      }

      // Check if any other payout is currently BROADCASTED (in flight)
      const inFlight = await tx.query<{ allocated_seqno: number }>(
        `SELECT allocated_seqno
           FROM finance.payout_seqno_allocations
          WHERE treasury_address = $1
            AND status = 'BROADCASTED'
            AND allocated_seqno != $2
          LIMIT 1`,
        [treasuryAddress, mySeqno],
      );

      if (inFlight.rows[0]) {
        return {
          allowed: false,
          seqno: mySeqno,
          reason: 'PREDECESSOR_IN_FLIGHT',
          predecessorSeqno: inFlight.rows[0].allocated_seqno,
        };
      }

      return { allowed: true, seqno: mySeqno, reason: 'ALLOWED' };
    };

    if ('transaction' in db && typeof (db as Database).transaction === 'function') {
      return (db as Database).transaction(run);
    }
    return run(db);
  }

  /**
   * Mark allocated seqno as broadcasted.
   */
  static async markBroadcasted(
    db: DatabaseOrTx,
    treasuryAddress: string,
    payoutId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE finance.payout_seqno_allocations
          SET status = 'BROADCASTED'
        WHERE payout_id = $1`,
      [payoutId],
    );
  }

  /**
   * Mark allocated seqno as confirmed on chain and advance wallet on-chain sequence state.
   */
  static async confirm(
    db: DatabaseOrTx,
    treasuryAddress: string,
    payoutId: string,
    seqno: number,
  ): Promise<void> {
    const run = async (tx: TransactionContext | Database) => {
      await tx.query(
        `UPDATE finance.payout_seqno_allocations
            SET status = 'CONFIRMED',
                confirmed_at = NOW()
          WHERE payout_id = $1`,
        [payoutId],
      );

      await tx.query(
        `UPDATE finance.treasury_wallet_sequences
            SET confirmed_seqno = GREATEST(confirmed_seqno, $2),
                current_onchain_seqno = GREATEST(current_onchain_seqno, $2 + 1),
                updated_at = NOW()
          WHERE address = $1`,
        [treasuryAddress, seqno],
      );
    };

    if ('transaction' in db && typeof (db as Database).transaction === 'function') {
      await (db as Database).transaction(run);
    } else {
      await run(db);
    }
  }

  /**
   * Mark allocated seqno as failed.
   */
  static async fail(
    db: DatabaseOrTx,
    treasuryAddress: string,
    payoutId: string,
    seqno?: number,
  ): Promise<void> {
    await db.query(
      `UPDATE finance.payout_seqno_allocations
          SET status = 'FAILED'
        WHERE payout_id = $1`,
      [payoutId],
    );
  }

  /**
   * Sync wallet sequence with live on-chain seqno reported by RPC.
   */
  static async syncOnChain(
    db: DatabaseOrTx,
    treasuryAddress: string,
    onChainSeqno: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance.treasury_wallet_sequences
          (address, current_onchain_seqno, next_allocated_seqno, confirmed_seqno)
       VALUES ($1, $2, $2, $2)
       ON CONFLICT (address) DO UPDATE
          SET current_onchain_seqno = GREATEST(finance.treasury_wallet_sequences.current_onchain_seqno, $2),
              next_allocated_seqno = GREATEST(finance.treasury_wallet_sequences.next_allocated_seqno, $2),
              confirmed_seqno = GREATEST(finance.treasury_wallet_sequences.confirmed_seqno, $2 - 1),
              updated_at = NOW()`,
      [treasuryAddress, onChainSeqno],
    );
  }

  /**
   * Reconcile sequence gap after a failed predecessor.
   * If an on-chain seqno N never landed, reset next_allocated_seqno to actual on-chain seqno
   * so new or retried payouts can be cleanly sequenced.
   */
  static async reconcileSequenceGap(
    db: DatabaseOrTx,
    treasuryAddress: string,
    actualOnChainSeqno: number,
  ): Promise<void> {
    const run = async (tx: TransactionContext | Database) => {
      await tx.query(
        `UPDATE finance.treasury_wallet_sequences
            SET current_onchain_seqno = $2,
                next_allocated_seqno = $2,
                confirmed_seqno = $2 - 1,
                updated_at = NOW()
          WHERE address = $1`,
        [treasuryAddress, actualOnChainSeqno],
      );

      // Invalidate any un-broadcast allocations that were allocated beyond the actual on-chain seqno
      await tx.query(
        `UPDATE finance.payout_seqno_allocations
            SET status = 'EXPIRED'
          WHERE treasury_address = $1
            AND allocated_seqno >= $2
            AND status IN ('RESERVED')`,
        [treasuryAddress, actualOnChainSeqno],
      );
    };

    if ('transaction' in db && typeof (db as Database).transaction === 'function') {
      await (db as Database).transaction(run);
    } else {
      await run(db);
    }
  }
}
