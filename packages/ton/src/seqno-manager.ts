/**
 * TON Sequence Number (seqno) Manager.
 *
 * Implements atomic persistent seqno reservation in PostgreSQL.
 * Guarantees that concurrent payout workers receive strictly monotonic,
 * unique seqnos (N, N+1, N+2, ...) starting exactly from the current on-chain seqno N.
 *
 * Complies with TON Wallet V4 contract semantics (msg_seqno == stored_seqno).
 */

import { randomUUID } from 'node:crypto';
import type { Database, TransactionContext } from '../../database/src/client.ts';

export type DatabaseOrTx = Database | TransactionContext;

export interface SeqnoAllocation {
  payoutId: string;
  treasuryAddress: string;
  seqno: number;
  status: 'RESERVED' | 'BROADCASTED' | 'CONFIRMED' | 'EXPIRED' | 'FAILED';
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
        // Initialize next_allocated_seqno to N so the first allocation reads N.
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
   * Mark allocated seqno as confirmed on chain.
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
                current_onchain_seqno = GREATEST(current_onchain_seqno, $2),
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
   * Sync wallet sequence with on-chain seqno reported by RPC.
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
              confirmed_seqno = GREATEST(finance.treasury_wallet_sequences.confirmed_seqno, $2),
              updated_at = NOW()`,
      [treasuryAddress, onChainSeqno],
    );
  }
}
