/**
 * Production Ledger Integrity Verification Script.
 *
 * Verifies:
 * 1. Global double-entry balance (Debits == Credits per currency).
 * 2. Balance projection agreement with immutable journal entries for all accounts.
 * 3. Monotonic sequence continuity in finance.journals and finance.journal_entries.
 * 4. Zero negative bucket violations across finance.balances.
 * 5. Ledger block hash and Merkle root integrity.
 */

import { createDatabase, type Database, type ConcreteDatabase } from '../packages/database/src/client.ts';
import { migrate } from '../packages/database/src/migrator.ts';
import { loadConfig } from '../packages/config/src/index.ts';
import { verifyGlobalBalance, verifyProjection } from '../packages/ledger/src/ledger-service.ts';
import { verifySequenceContinuity, verifyLedgerBlocks } from '../packages/ledger/src/ledger-blocks.ts';

export async function runLedgerVerification(customDb?: Database): Promise<boolean> {
  const shouldClose = !customDb;
  let db: Database;
  if (customDb) {
    db = customDb;
  } else {
    const config = loadConfig();
    const concreteDb = (await createDatabase({ url: config.database.url })) as ConcreteDatabase;
    await migrate(concreteDb);
    db = concreteDb;
  }

  console.log('================================================================');
  console.log('         GOLDPAY PRODUCTION LEDGER INTEGRITY VERIFIER           ');
  console.log('================================================================');

  let allChecksPassed = true;

  try {
    // 1. Global Debit/Credit Balance Check
    console.log('\n[1/5] Checking Global Multi-Currency Balance (Debits == Credits)...');
    const globalCheck = await db.transaction((tx) => verifyGlobalBalance(tx));
    for (const cur of globalCheck.byCurrency) {
      console.log(`  - Currency: ${cur.currency} | Debit: ${cur.debit} | Credit: ${cur.credit}`);
    }
    if (globalCheck.balanced) {
      console.log('  -> PASS: All currency journals are perfectly zero-sum balanced.');
    } else {
      console.error('  -> FAIL: Global ledger imbalance detected!');
      allChecksPassed = false;
    }

    // 2. All Account Balance Projections vs Journal Entries
    console.log('\n[2/5] Verifying Balance Projections against Journal Line Recomputations...');
    const accounts = await db.query<{ id: string; account_code: string; owner_type: string | null; owner_id: string | null }>(
      'SELECT id, account_code, owner_type, owner_id FROM finance.ledger_accounts ORDER BY created_at ASC',
    );
    let inconsistentAccounts = 0;
    for (const acc of accounts.rows) {
      const projCheck = await db.transaction((tx) => verifyProjection(tx, acc.id));
      if (!projCheck.consistent) {
        console.error(`  -> INCONSISTENCY on account ${acc.account_code} (${acc.id})`);
        console.error('     Ledger:    ', projCheck.ledger);
        console.error('     Projection:', projCheck.projection);
        inconsistentAccounts++;
        allChecksPassed = false;
      }
    }
    if (inconsistentAccounts === 0) {
      console.log(`  -> PASS: All ${accounts.rows.length} accounts have 100% projection-ledger agreement.`);
    } else {
      console.error(`  -> FAIL: ${inconsistentAccounts} account(s) have projection mismatches!`);
    }

    // 3. Negative Balance Checks
    console.log('\n[3/5] Checking for Negative Balance Violations...');
    const negativeRows = await db.query(
      `SELECT account_id, available, pending, settling, review_hold
         FROM finance.balances
        WHERE available < 0 OR pending < 0 OR settling < 0 OR review_hold < 0`,
    );
    if (negativeRows.rows.length === 0) {
      console.log('  -> PASS: Zero negative balances found across all buckets.');
    } else {
      console.error(`  -> FAIL: Found ${negativeRows.rows.length} account(s) with negative buckets!`);
      allChecksPassed = false;
    }

    // 4. Sequence Continuity & Monotonicity
    console.log('\n[4/5] Checking Sequence Monotonicity & Record Integrity...');
    const seqResult = await verifySequenceContinuity(db);
    console.log(`  - Total Journals: ${seqResult.journalCount} | Total Entries: ${seqResult.entryCount}`);
    if (seqResult.valid) {
      console.log('  -> PASS: Journal sequence monotonic integrity verified.');
    } else {
      console.error('  -> FAIL: Sequence continuity violations detected:');
      for (const err of seqResult.errors) {
        console.error(`     - ${err}`);
      }
      allChecksPassed = false;
    }

    // 5. Ledger Blocks Merkle Verification
    console.log('\n[5/5] Checking Ledger Blocks Merkle Consistency...');
    const blocksResult = await verifyLedgerBlocks(db);
    console.log(`  - Verified Blocks: ${blocksResult.blockCount}`);
    if (blocksResult.valid) {
      console.log('  -> PASS: Ledger blocks chain verified.');
    } else {
      console.error('  -> FAIL: Ledger block integrity violations detected:');
      for (const err of blocksResult.errors) {
        console.error(`     - ${err}`);
      }
      allChecksPassed = false;
    }

    console.log('\n================================================================');
    if (allChecksPassed) {
      console.log('              FINAL RESULT: LEDGER STATUS: HEALTHY              ');
      console.log('================================================================');
    } else {
      console.error('             FINAL RESULT: LEDGER STATUS: UNHEALTHY             ');
      console.error('================================================================');
    }

    return allChecksPassed;
  } finally {
    if (shouldClose) {
      await db.close();
    }
  }
}

// Run directly if invoked from CLI
if (process.argv[1]?.endsWith('ledger-verify.ts') || process.argv[1]?.endsWith('ledger-verify.js')) {
  runLedgerVerification()
    .then((healthy) => {
      process.exit(healthy ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal verifier error:', err);
      process.exit(1);
    });
}
