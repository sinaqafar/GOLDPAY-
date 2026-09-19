/**
 * TON Sequence Number (seqno) Manager.
 *
 * Implements atomic persistent seqno reservation in PostgreSQL.
 * Guarantees that concurrent payout workers receive strictly monotonic,
 * unique seqnos (N, N+1, N+2, ...) preventing TON contract exit code 33 replay errors.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../database/src/client.ts';
import { IntegrationError } from '../../errors/src/index.ts';

export interface SeqnoAllocation {
  payoutId: string;
  treasuryAddress: string;
  seqno: number;
  status: 'RESERVED' | 'BROADCASTED' | 'CONFIRMED' | 'EXPIRED' | 'FAILED';
}

export class TonSeqnoManager {
  /**
   * Atomically allocate the next sequential seqno for a payout.
   * If the payout already has an active allocation, returns the existing seqno.
   */
  static async allocate(
    db: Database,
    treasuryAddress: string,
    payoutId: string,
    initialOnChainSeqno = 0,
  ): Promise<number> {
    // 1. Check if payout already has an allocation
    const existing = await db.query<{ allocated_seqno: number; status: string }>(
      `SELECT allocated_seqno, status
         FROM finance.payout_seqno_allocations
        WHERE payout_id = $1`,
      [payoutId],
    );

    if (existing.rows[0]) {
      return existing.rows[0].allocated_seqno;
    }

    // 2. Lock the wallet sequence row
    let seqRow = await db.query<{
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
      // Initialize sequence entry for this wallet
      const nextSeq = initialOnChainSeqno + 1;
      await db.query(
        `INSERT INTO finance.treasury_wallet_sequences
            (address, current_onchain_seqno, next_allocated_seqno, confirmed_seqno)
         VALUES ($1, $2, $3, $2)
         ON CONFLICT (address) DO NOTHING`,
        [treasuryAddress, initialOnChainSeqno, nextSeq],
      );

      seqRow = await db.query(
        `SELECT current_onchain_seqno, next_allocated_seqno
           FROM finance.treasury_wallet_sequences
          WHERE address = $1
            FOR UPDATE`,
        [treasuryAddress],
      );
    }

    const currentNext = seqRow.rows[0]?.next_allocated_seqno ?? (initialOnChainSeqno + 1);
    const allocated = currentNext;

    // 3. Increment sequence counter
    await db.query(
      `UPDATE finance.treasury_wallet_sequences
          SET next_allocated_seqno = $2 + 1,
              updated_at = NOW()
        WHERE address = $1`,
      [treasuryAddress, allocated],
    );

    // 4. Record allocation against payout
    await db.query(
      `INSERT INTO finance.payout_seqno_allocations
          (id, payout_id, treasury_address, allocated_seqno, status)
       VALUES ($1, $2, $3, $4, 'RESERVED')`,
      [randomUUID(), payoutId, treasuryAddress, allocated],
    );

    return allocated;
  }

  /**
   * Mark allocated seqno as confirmed on chain.
   */
  static async confirm(
    db: Database,
    treasuryAddress: string,
    payoutId: string,
    seqno: number,
  ): Promise<void> {
    await db.query(
      `UPDATE finance.payout_seqno_allocations
          SET status = 'CONFIRMED',
              confirmed_at = NOW()
        WHERE payout_id = $1`,
      [payoutId],
    );

    await db.query(
      `UPDATE finance.treasury_wallet_sequences
          SET confirmed_seqno = GREATEST(confirmed_seqno, $2),
              current_onchain_seqno = GREATEST(current_onchain_seqno, $2),
              updated_at = NOW()
        WHERE address = $1`,
      [treasuryAddress, seqno],
    );
  }

  /**
   * Sync wallet sequence with on-chain seqno reported by RPC.
   */
  static async syncOnChain(
    db: Database,
    treasuryAddress: string,
    onChainSeqno: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO finance.treasury_wallet_sequences
          (address, current_onchain_seqno, next_allocated_seqno, confirmed_seqno)
       VALUES ($1, $2, $2 + 1, $2)
       ON CONFLICT (address) DO UPDATE
          SET current_onchain_seqno = GREATEST(finance.treasury_wallet_sequences.current_onchain_seqno, $2),
              next_allocated_seqno = GREATEST(finance.treasury_wallet_sequences.next_allocated_seqno, $2 + 1),
              confirmed_seqno = GREATEST(finance.treasury_wallet_sequences.confirmed_seqno, $2),
              updated_at = NOW()`,
      [treasuryAddress, onChainSeqno],
    );
  }
}
