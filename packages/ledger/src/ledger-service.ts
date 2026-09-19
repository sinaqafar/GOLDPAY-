/**
 * The ledger service — the ONLY permitted way to post financial entries.
 *
 * SPEC 103786: `post()` is the single legal posting path.
 * SPEC 118.20: every journal must satisfy SUM(debit) = SUM(credit) per currency.
 * SPEC 118.73: state change + ledger + outbox commit together, in one transaction.
 * SPEC 103941/103942: `balances` is a projection; the ledger is the truth.
 */

import { randomUUID } from 'node:crypto';
import type { TransactionContext } from '../../database/src/client.ts';
import { Money, type CurrencyCode } from '../../money/src/index.ts';
import { FinancialError, ConflictError, ErrorCodes } from '../../errors/src/index.ts';
import type { Bucket } from './accounts.ts';

export interface JournalLine {
  accountId: string;
  /** Exactly one of debit/credit must be positive. */
  debit?: Money;
  credit?: Money;
  /** Which balance bucket this line moves. Defaults to AVAILABLE. */
  bucket?: Bucket;
}

export interface JournalDraft {
  /** What this posting is about, e.g. 'PAYMENT' | 'PAYOUT' | 'REFUND'. */
  referenceType: string;
  referenceId: string;
  /**
   * Globally unique business operation id. Re-posting the same operation is a
   * no-op rather than a second economic effect (SPEC 119.41).
   */
  operationId: string;
  description?: string;
  lines: JournalLine[];
}

export interface PostResult {
  journalId: string;
  /** False when this operation had already been posted (idempotent replay). */
  created: boolean;
}

export interface BalanceSnapshot {
  accountId: string;
  currency: CurrencyCode;
  available: Money;
  pending: Money;
  settling: Money;
  reviewHold: Money;
}

/** Sum of everything the merchant is owed, in any state. */
export function totalBalance(b: BalanceSnapshot): Money {
  return b.available.add(b.pending).add(b.settling).add(b.reviewHold);
}

/**
 * Post a balanced journal inside an existing transaction.
 *
 * Idempotency: `operation_id` carries a UNIQUE constraint, so two concurrent
 * attempts to post the same operation cannot both succeed — the loser observes
 * the winner's journal and returns `created: false`.
 */
export async function post(
  tx: TransactionContext,
  draft: JournalDraft,
): Promise<PostResult> {
  if (draft.lines.length === 0) {
    throw new FinancialError('LEDGER_EMPTY_JOURNAL', 'a journal must have at least one entry');
  }
  if (!draft.operationId) {
    throw new FinancialError('LEDGER_MISSING_OPERATION_ID', 'operationId is required for idempotency');
  }

  // Validate shape and balance in application code first, so we return a clean
  // domain error rather than relying on the database trigger for normal bugs.
  const perCurrency = new Map<string, { debit: bigint; credit: bigint }>();
  for (const line of draft.lines) {
    const hasDebit = line.debit !== undefined && !line.debit.isZero();
    const hasCredit = line.credit !== undefined && !line.credit.isZero();
    if (hasDebit === hasCredit) {
      throw new FinancialError(
        'LEDGER_INVALID_ENTRY',
        'each journal line must be exactly one of debit or credit',
        { accountId: line.accountId },
      );
    }
    const amount = (hasDebit ? line.debit : line.credit) as Money;
    if (amount.isNegative()) {
      throw new FinancialError('LEDGER_NEGATIVE_AMOUNT', 'journal amounts must be positive', {
        accountId: line.accountId,
      });
    }
    const agg = perCurrency.get(amount.currency) ?? { debit: 0n, credit: 0n };
    if (hasDebit) agg.debit += amount.atomic;
    else agg.credit += amount.atomic;
    perCurrency.set(amount.currency, agg);
  }

  for (const [currency, { debit, credit }] of perCurrency) {
    if (debit !== credit) {
      throw new FinancialError(
        ErrorCodes.LEDGER_UNBALANCED,
        `journal is unbalanced in ${currency}: debit=${debit} credit=${credit}`,
        { currency, debit: debit.toString(), credit: credit.toString() },
      );
    }
  }

  const journalId = randomUUID();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO finance.journals(id, reference_type, reference_id, operation_id, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (operation_id) DO NOTHING
     RETURNING id`,
    [journalId, draft.referenceType, draft.referenceId, draft.operationId, draft.description ?? null],
  );

  if (inserted.rows.length === 0) {
    // Already posted — idempotent replay, no second economic effect.
    const existing = await tx.query<{ id: string }>(
      'SELECT id FROM finance.journals WHERE operation_id = $1',
      [draft.operationId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new ConflictError('LEDGER_OPERATION_RACE', 'operation id conflict could not be resolved');
    }
    return { journalId: row.id, created: false };
  }

  for (const line of draft.lines) {
    const isDebit = line.debit !== undefined && !line.debit.isZero();
    const amount = (isDebit ? line.debit : line.credit) as Money;
    await tx.query(
      `INSERT INTO finance.journal_entries
          (id, journal_id, account_id, debit, credit, currency, bucket)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        journalId,
        line.accountId,
        isDebit ? amount.toAtomicString() : '0',
        isDebit ? '0' : amount.toAtomicString(),
        amount.currency,
        line.bucket ?? 'AVAILABLE',
      ],
    );
  }

  await applyToProjection(tx, draft.lines);

  return { journalId, created: true };
}

/**
 * Update the `balances` projection.
 *
 * For a LIABILITY account (merchant money) a CREDIT increases what we owe and a
 * DEBIT decreases it. The CHECK constraints on `finance.balances` make a
 * negative bucket impossible, so an over-spend fails the transaction instead of
 * corrupting the merchant's balance (SPEC REQ-FIN-003).
 */
async function applyToProjection(tx: TransactionContext, lines: JournalLine[]): Promise<void> {
  for (const line of lines) {
    const isDebit = line.debit !== undefined && !line.debit.isZero();
    const amount = (isDebit ? line.debit : line.credit) as Money;
    const bucket = line.bucket ?? 'AVAILABLE';

    const accountRes = await tx.query<{ account_type: string }>(
      'SELECT account_type FROM finance.ledger_accounts WHERE id = $1',
      [line.accountId],
    );
    const account = accountRes.rows[0];
    if (!account) {
      throw new FinancialError('LEDGER_UNKNOWN_ACCOUNT', 'journal references an unknown account', {
        accountId: line.accountId,
      });
    }

    // Only balance-bearing accounts get a projection; revenue/expense are
    // reported by aggregating the journal itself.
    if (account.account_type !== 'LIABILITY' && account.account_type !== 'ASSET') {
      continue;
    }

    // Natural balance: liabilities grow on credit, assets grow on debit.
    const increases = account.account_type === 'LIABILITY' ? !isDebit : isDebit;
    const delta = increases ? amount.atomic : -amount.atomic;
    const column = bucketColumn(bucket);

    // Two statements, deliberately.
    //
    // `INSERT ... ON CONFLICT DO UPDATE` cannot be used here: PostgreSQL
    // evaluates CHECK constraints against the *proposed* insert tuple before
    // conflict arbitration, so a negative delta (a debit against a liability)
    // would trip the non-negative check even when the resulting balance is
    // perfectly valid. Ensuring a zero row first, then applying the delta with
    // a plain UPDATE, keeps the constraint meaningful: it now fires only when
    // the FINAL balance would go negative, which is the invariant we want.
    await tx.query(
      `INSERT INTO finance.balances(account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING`,
      [line.accountId],
    );

    const updated = await tx.query(
      `UPDATE finance.balances
          SET ${column} = ${column} + $2, updated_at = NOW()
        WHERE account_id = $1`,
      [line.accountId, delta.toString()],
    );
    if (updated.rowCount !== 1) {
      throw new FinancialError('BALANCE_PROJECTION_FAILED', 'could not update the balance projection', {
        accountId: line.accountId,
      });
    }
  }
}

function bucketColumn(bucket: Bucket): 'available' | 'pending' | 'settling' | 'review_hold' {
  switch (bucket) {
    case 'AVAILABLE':
      return 'available';
    case 'PENDING':
      return 'pending';
    case 'SETTLING':
      return 'settling';
    case 'REVIEW_HOLD':
      return 'review_hold';
  }
}

export async function getBalance(
  tx: TransactionContext,
  accountId: string,
): Promise<BalanceSnapshot> {
  const r = await tx.query<{
    available: string;
    pending: string;
    settling: string;
    review_hold: string;
    currency: CurrencyCode;
  }>(
    `SELECT COALESCE(b.available,0)::text   AS available,
            COALESCE(b.pending,0)::text     AS pending,
            COALESCE(b.settling,0)::text    AS settling,
            COALESCE(b.review_hold,0)::text AS review_hold,
            a.currency
       FROM finance.ledger_accounts a
       LEFT JOIN finance.balances b ON b.account_id = a.id
      WHERE a.id = $1`,
    [accountId],
  );
  const row = r.rows[0];
  if (!row) throw new FinancialError('LEDGER_UNKNOWN_ACCOUNT', 'account not found', { accountId });

  return {
    accountId,
    currency: row.currency,
    available: Money.of(row.available, row.currency),
    pending: Money.of(row.pending, row.currency),
    settling: Money.of(row.settling, row.currency),
    reviewHold: Money.of(row.review_hold, row.currency),
  };
}

/**
 * Recompute a balance from the journal and compare it with the projection.
 * SPEC 119.51: reconciliation compares ledger totals against the projection and
 * the ledger always wins.
 */
export async function verifyProjection(
  tx: TransactionContext,
  accountId: string,
): Promise<{ consistent: boolean; ledger: Record<string, string>; projection: Record<string, string> }> {
  const account = await tx.query<{ account_type: string }>(
    'SELECT account_type FROM finance.ledger_accounts WHERE id = $1',
    [accountId],
  );
  const type = account.rows[0]?.account_type;
  if (!type) throw new FinancialError('LEDGER_UNKNOWN_ACCOUNT', 'account not found', { accountId });

  // Sign the sum according to the account's natural balance direction.
  const sign = type === 'LIABILITY' ? '(e.credit - e.debit)' : '(e.debit - e.credit)';
  const computed = await tx.query<{ bucket: string; total: string }>(
    `SELECT e.bucket, COALESCE(SUM(${sign}),0)::text AS total
       FROM finance.journal_entries e
      WHERE e.account_id = $1
      GROUP BY e.bucket`,
    [accountId],
  );

  const ledger: Record<string, string> = {
    AVAILABLE: '0',
    PENDING: '0',
    SETTLING: '0',
    REVIEW_HOLD: '0',
  };
  for (const row of computed.rows) ledger[row.bucket] = row.total;

  const snapshot = await getBalance(tx, accountId);
  const projection: Record<string, string> = {
    AVAILABLE: snapshot.available.toAtomicString(),
    PENDING: snapshot.pending.toAtomicString(),
    SETTLING: snapshot.settling.toAtomicString(),
    REVIEW_HOLD: snapshot.reviewHold.toAtomicString(),
  };

  const consistent = (['AVAILABLE', 'PENDING', 'SETTLING', 'REVIEW_HOLD'] as const).every(
    (b) => BigInt(ledger[b] ?? '0') === BigInt(projection[b] ?? '0'),
  );

  return { consistent, ledger, projection };
}

/**
 * Global integrity check: total debits must equal total credits per currency
 * across the entire ledger. SPEC 104032: an imbalance is a CRITICAL exception.
 */
export async function verifyGlobalBalance(
  tx: TransactionContext,
): Promise<{ balanced: boolean; byCurrency: Array<{ currency: string; debit: string; credit: string }> }> {
  const r = await tx.query<{ currency: string; debit: string; credit: string }>(
    `SELECT currency,
            COALESCE(SUM(debit),0)::text  AS debit,
            COALESCE(SUM(credit),0)::text AS credit
       FROM finance.journal_entries
      GROUP BY currency`,
  );
  const balanced = r.rows.every((row) => BigInt(row.debit) === BigInt(row.credit));
  return { balanced, byCurrency: r.rows };
}
