/**
 * Cryptographic Ledger Blocks & Merkle Tree Verification.
 *
 * SPEC 118.x / v3.3:
 * - Deterministic SHA-256 block hashing
 * - Merkle root computation over entry hashes
 * - Strict monotonic sequence continuity verification (no gaps, no duplicates)
 * - Chain linkage validation: block[N].previous_block_hash == block[N-1].current_block_hash
 */

import { createHash } from 'node:crypto';
import type { Database, TransactionContext } from '../../database/src/client.ts';
import { FinancialError } from '../../errors/src/index.ts';

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Compute entry canonical hash.
 */
export function hashJournalEntry(entry: {
  id: string;
  journal_id: string;
  account_id: string;
  debit: string;
  credit: string;
  currency: string;
  bucket: string;
  entry_sequence?: string | number;
}): string {
  const canonical = [
    entry.id,
    entry.journal_id,
    entry.account_id,
    entry.debit,
    entry.credit,
    entry.currency,
    entry.bucket,
    String(entry.entry_sequence ?? ''),
  ].join('|');
  return sha256Hex(canonical);
}

/**
 * Compute Merkle root from a list of entry hashes.
 */
export function computeMerkleRoot(hashes: readonly string[]): string {
  if (hashes.length === 0) {
    return '0000000000000000000000000000000000000000000000000000000000000000';
  }

  let currentLevel = [...hashes];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]!;
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1]! : left;
      nextLevel.push(sha256Hex(left + right));
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0]!;
}

/**
 * Compute block hash from header fields.
 */
export function computeBlockHash(params: {
  previousBlockHash: string;
  merkleRootHash: string;
  startJournalSequence: string | number;
  endJournalSequence: string | number;
  entryCount: number;
}): string {
  const payload = [
    params.previousBlockHash,
    params.merkleRootHash,
    String(params.startJournalSequence),
    String(params.endJournalSequence),
    String(params.entryCount),
  ].join('|');
  return sha256Hex(payload);
}

export interface SequenceCheckResult {
  valid: boolean;
  journalCount: number;
  entryCount: number;
  errors: string[];
}

/**
 * Verify journal sequence and entry sequence continuity (no gaps, no duplicates, 1..N).
 */
export async function verifySequenceContinuity(
  dbOrTx: Database | TransactionContext,
): Promise<SequenceCheckResult> {
  const errors: string[] = [];

  // 1. Verify Journals Sequence
  const journals = await dbOrTx.query<{
    id: string;
    journal_sequence: string;
  }>(
    `SELECT id, journal_sequence::text
       FROM finance.journals
      ORDER BY journal_sequence::bigint ASC`,
  );

  const jCount = journals.rows.length;
  for (let i = 0; i < jCount; i++) {
    const expected = BigInt(i + 1);
    const actual = BigInt(journals.rows[i]?.journal_sequence ?? '0');
    if (actual !== expected) {
      errors.push(`Journal sequence mismatch at index ${i}: expected ${expected}, got ${actual} (id: ${journals.rows[i]?.id})`);
      break;
    }
  }

  // 2. Verify Entries Sequence
  const entries = await dbOrTx.query<{
    id: string;
    entry_sequence: string;
  }>(
    `SELECT id, entry_sequence::text
       FROM finance.journal_entries
      ORDER BY entry_sequence::bigint ASC`,
  );

  const eCount = entries.rows.length;
  for (let i = 0; i < eCount; i++) {
    const expected = BigInt(i + 1);
    const actual = BigInt(entries.rows[i]?.entry_sequence ?? '0');
    if (actual !== expected) {
      errors.push(`Journal entry sequence mismatch at index ${i}: expected ${expected}, got ${actual} (id: ${entries.rows[i]?.id})`);
      break;
    }
  }

  return {
    valid: errors.length === 0,
    journalCount: jCount,
    entryCount: eCount,
    errors,
  };
}

export interface BlockCheckResult {
  valid: boolean;
  blockCount: number;
  errors: string[];
}

/**
 * Recompute and verify all ledger blocks, Merkle roots, and chain linkage.
 */
export async function verifyLedgerBlocks(
  dbOrTx: Database | TransactionContext,
): Promise<BlockCheckResult> {
  const errors: string[] = [];

  const blocks = await dbOrTx.query<{
    block_id: string;
    start_journal_sequence: string;
    end_journal_sequence: string;
    entry_count: number;
    previous_block_hash: string;
    merkle_root_hash: string;
    current_block_hash: string;
  }>(
    `SELECT block_id::text, start_journal_sequence::text, end_journal_sequence::text,
            entry_count, previous_block_hash, merkle_root_hash, current_block_hash
       FROM finance.ledger_blocks
      ORDER BY block_id ASC`,
  );

  let prevBlockHash = '0000000000000000000000000000000000000000000000000000000000000000';

  for (let b = 0; b < blocks.rows.length; b++) {
    const block = blocks.rows[b]!;

    // 1. Verify previous_block_hash chain link
    if (block.previous_block_hash !== prevBlockHash) {
      errors.push(
        `Block #${block.block_id} previous_block_hash broken: expected ${prevBlockHash}, got ${block.previous_block_hash}`,
      );
    }

    // 2. Fetch journal entries in this block's sequence range
    const entries = await dbOrTx.query<{
      id: string;
      journal_id: string;
      account_id: string;
      debit: string;
      credit: string;
      currency: string;
      bucket: string;
      entry_sequence: string;
    }>(
      `SELECT e.id, e.journal_id, e.account_id, e.debit::text, e.credit::text,
              e.currency, e.bucket, e.entry_sequence::text
         FROM finance.journal_entries e
         JOIN finance.journals j ON j.id = e.journal_id
        WHERE j.journal_sequence >= $1 AND j.journal_sequence <= $2
        ORDER BY e.entry_sequence ASC`,
      [block.start_journal_sequence, block.end_journal_sequence],
    );

    if (entries.rows.length !== block.entry_count) {
      errors.push(
        `Block #${block.block_id} entry_count mismatch: recorded ${block.entry_count}, found ${entries.rows.length}`,
      );
    }

    // 3. Recompute Merkle root from entries
    const hashes = entries.rows.map((e) => hashJournalEntry(e));
    const recomputedMerkle = computeMerkleRoot(hashes);

    if (recomputedMerkle !== block.merkle_root_hash) {
      errors.push(
        `Block #${block.block_id} Merkle root mismatch: recorded ${block.merkle_root_hash}, recomputed ${recomputedMerkle}`,
      );
    }

    // 4. Recompute current block hash
    const recomputedBlockHash = computeBlockHash({
      previousBlockHash: block.previous_block_hash,
      merkleRootHash: block.merkle_root_hash,
      startJournalSequence: block.start_journal_sequence,
      endJournalSequence: block.end_journal_sequence,
      entryCount: block.entry_count,
    });

    if (recomputedBlockHash !== block.current_block_hash) {
      errors.push(
        `Block #${block.block_id} current_block_hash mismatch: recorded ${block.current_block_hash}, recomputed ${recomputedBlockHash}`,
      );
    }

    prevBlockHash = block.current_block_hash;
  }

  return {
    valid: errors.length === 0,
    blockCount: blocks.rows.length,
    errors,
  };
}

/**
 * Seal a new ledger block covering unsealed journals.
 */
export async function sealLedgerBlock(
  tx: TransactionContext,
): Promise<{ blockId: string; entryCount: number; currentBlockHash: string } | null> {
  const lastBlock = await tx.query<{
    block_id: string;
    end_journal_sequence: string;
    current_block_hash: string;
  }>(
    `SELECT block_id::text, end_journal_sequence::text, current_block_hash
       FROM finance.ledger_blocks
      ORDER BY block_id DESC
      LIMIT 1 FOR UPDATE`,
  );

  const lastSeq = BigInt(lastBlock.rows[0]?.end_journal_sequence ?? '0');
  const prevHash = lastBlock.rows[0]?.current_block_hash ?? '0000000000000000000000000000000000000000000000000000000000000000';

  // Find journals not yet in any block
  const unsealed = await tx.query<{
    min_seq: string;
    max_seq: string;
    count: string;
  }>(
    `SELECT MIN(journal_sequence)::text AS min_seq,
            MAX(journal_sequence)::text AS max_seq,
            COUNT(*)::text AS count
       FROM finance.journals
      WHERE journal_sequence > $1`,
    [lastSeq.toString()],
  );

  const count = Number.parseInt(unsealed.rows[0]?.count ?? '0', 10);
  if (count === 0 || !unsealed.rows[0]?.min_seq) {
    return null;
  }

  const startSeq = unsealed.rows[0].min_seq;
  const endSeq = unsealed.rows[0].max_seq;

  // Fetch entries in this range
  const entries = await tx.query<{
    id: string;
    journal_id: string;
    account_id: string;
    debit: string;
    credit: string;
    currency: string;
    bucket: string;
    entry_sequence: string;
  }>(
    `SELECT e.id, e.journal_id, e.account_id, e.debit::text, e.credit::text,
            e.currency, e.bucket, e.entry_sequence::text
       FROM finance.journal_entries e
       JOIN finance.journals j ON j.id = e.journal_id
      WHERE j.journal_sequence >= $1 AND j.journal_sequence <= $2
      ORDER BY e.entry_sequence ASC`,
    [startSeq, endSeq],
  );

  const hashes = entries.rows.map((e) => hashJournalEntry(e));
  const merkleRoot = computeMerkleRoot(hashes);
  const currentBlockHash = computeBlockHash({
    previousBlockHash: prevHash,
    merkleRootHash: merkleRoot,
    startJournalSequence: startSeq,
    endJournalSequence: endSeq,
    entryCount: entries.rows.length,
  });

  const inserted = await tx.query<{ block_id: string }>(
    `INSERT INTO finance.ledger_blocks
        (start_journal_sequence, end_journal_sequence, entry_count,
         previous_block_hash, merkle_root_hash, current_block_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING block_id::text`,
    [startSeq, endSeq, entries.rows.length, prevHash, merkleRoot, currentBlockHash],
  );

  return {
    blockId: inserted.rows[0]?.block_id ?? '1',
    entryCount: entries.rows.length,
    currentBlockHash,
  };
}
