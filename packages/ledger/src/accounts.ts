/**
 * Chart of accounts.
 * SPEC 119.43 (Accounting Event Matrix) and 118.16/118.17.
 *
 * Merchant money lives in LIABILITY accounts: the platform owes it to them.
 * The bucket (PENDING / AVAILABLE / SETTLING) is a property of the entry, so a
 * 48h release is a bucket move inside one account rather than a value change
 * (SPEC 104028: the economic owner does not change, only the liability state).
 */

import type { TransactionContext } from '../../database/src/client.ts';
import { randomUUID } from 'node:crypto';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE' | 'MEMO';
export type Bucket = 'AVAILABLE' | 'PENDING' | 'SETTLING' | 'REVIEW_HOLD';

/** System-wide (non-merchant) accounts, created once by the seed. */
export const SYSTEM_ACCOUNTS = {
  /** Funds held at the payment provider before settlement to us. */
  PROVIDER_CLEARING_TOMAN: { code: 'PROVIDER_CLEARING_TOMAN', type: 'ASSET', currency: 'TOMAN' },
  /** Platform fee income. */
  PLATFORM_REVENUE_TOMAN: { code: 'PLATFORM_REVENUE_TOMAN', type: 'REVENUE', currency: 'TOMAN' },
  /** Provider costs and other platform expenses. */
  PLATFORM_EXPENSE_TOMAN: { code: 'PLATFORM_EXPENSE_TOMAN', type: 'EXPENSE', currency: 'TOMAN' },
  /** GRAM held in the treasury wallet. */
  TREASURY_GRAM: { code: 'TREASURY_GRAM', type: 'ASSET', currency: 'GRAM' },
  /** Equity counterpart for owner-funded treasury top-ups (SPEC 104009). */
  TREASURY_FUNDING_EQUITY: { code: 'TREASURY_FUNDING_EQUITY', type: 'EQUITY', currency: 'GRAM' },
  /** On-chain network fees paid by the platform (SPEC 104008). */
  NETWORK_FEE_EXPENSE_GRAM: { code: 'NETWORK_FEE_EXPENSE_GRAM', type: 'EXPENSE', currency: 'GRAM' },
  /** Settlement clearing: TOMAN liability discharged against GRAM sent. */
  SETTLEMENT_CLEARING_TOMAN: { code: 'SETTLEMENT_CLEARING_TOMAN', type: 'EXPENSE', currency: 'TOMAN' },
  /** SPEC 119.36 — genuinely unresolved items, never a dumping ground. */
  SUSPENSE_TOMAN: { code: 'SUSPENSE_TOMAN', type: 'ASSET', currency: 'TOMAN' },
} as const;

export type SystemAccountCode = keyof typeof SYSTEM_ACCOUNTS;

/** Per-merchant liability account code. */
export function merchantLiabilityCode(): string {
  return 'MERCHANT_LIABILITY_TOMAN';
}

export interface AccountRow {
  id: string;
  account_code: string;
  account_type: AccountType;
  owner_type: string | null;
  owner_id: string | null;
  currency: string;
  status: string;
}

/** Look up a system account id, failing loudly if the seed never ran. */
export async function getSystemAccountId(
  tx: TransactionContext,
  code: SystemAccountCode,
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM finance.ledger_accounts
      WHERE account_code = $1 AND owner_id IS NULL AND status = 'ACTIVE'`,
    [code],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(`system ledger account ${code} is missing; run the seed`);
  }
  return row.id;
}

/**
 * Get (or lazily create) a merchant's TOMAN liability account.
 * Safe under concurrency via ON CONFLICT on the unique (owner, code) index.
 */
export async function getOrCreateMerchantAccount(
  tx: TransactionContext,
  merchantId: string,
): Promise<string> {
  const code = merchantLiabilityCode();
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM finance.ledger_accounts
      WHERE owner_type = 'MERCHANT' AND owner_id = $1 AND account_code = $2`,
    [merchantId, code],
  );
  const found = existing.rows[0];
  if (found) return found.id;

  const id = randomUUID();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO finance.ledger_accounts
        (id, account_code, account_type, owner_type, owner_id, currency, status)
     VALUES ($1, $2, 'LIABILITY', 'MERCHANT', $3, 'TOMAN', 'ACTIVE')
     ON CONFLICT (owner_type, owner_id, account_code) WHERE owner_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [id, code, merchantId],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    await tx.query(
      `INSERT INTO finance.balances(account_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [insertedRow.id],
    );
    return insertedRow.id;
  }

  // Lost the race: another transaction created it first.
  const retry = await tx.query<{ id: string }>(
    `SELECT id FROM finance.ledger_accounts
      WHERE owner_type = 'MERCHANT' AND owner_id = $1 AND account_code = $2`,
    [merchantId, code],
  );
  const retryRow = retry.rows[0];
  if (!retryRow) throw new Error(`failed to create ledger account for merchant ${merchantId}`);
  return retryRow.id;
}
