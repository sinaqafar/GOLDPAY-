/**
 * Seed the chart of accounts and the treasury account.
 *
 * The ledger refuses to post against a missing system account, so this must run
 * once after migration. It is idempotent.
 */

import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '../packages/database/src/client.ts';
import { migrate } from '../packages/database/src/migrator.ts';
import { SYSTEM_ACCOUNTS } from '../packages/ledger/src/accounts.ts';
import { loadConfig, type Config } from '../packages/config/src/index.ts';

export async function seedSystemAccounts(db: Database): Promise<number> {
  let created = 0;
  for (const account of Object.values(SYSTEM_ACCOUNTS)) {
    const r = await db.query(
      `INSERT INTO finance.ledger_accounts
          (id, account_code, account_type, owner_type, owner_id, currency, status)
       VALUES ($1, $2, $3, NULL, NULL, $4, 'ACTIVE')
       ON CONFLICT DO NOTHING`,
      [randomUUID(), account.code, account.type, account.currency],
    );
    created += r.rowCount;
  }
  return created;
}

export async function seedTreasury(db: Database, config: Config): Promise<boolean> {
  const address = config.treasury.address ?? 'TREASURY_PLACEHOLDER_ADDRESS';
  const r = await db.query(
    `INSERT INTO finance.treasury_accounts
        (id, name, network, asset, address, status, confirmed_balance_atomic, safety_reserve_atomic)
     VALUES ($1, 'Primary GRAM Treasury', $2, 'GRAM', $3, 'ACTIVE', 0, $4)
     ON CONFLICT (address) DO NOTHING`,
    [
      randomUUID(),
      config.treasury.network,
      address,
      config.treasury.safetyReserveGramAtomic.toString(),
    ],
  );
  return r.rowCount > 0;
}

export async function seed(db: Database, config: Config): Promise<void> {
  const accounts = await seedSystemAccounts(db);
  const treasury = await seedTreasury(db, config);
  console.log(`seed: ${accounts} system account(s) created, treasury ${treasury ? 'created' : 'present'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const db = await createDatabase({ url: config.database.url });
  try {
    await migrate(db);
    await seed(db, config);
  } finally {
    await db.close();
  }
}
