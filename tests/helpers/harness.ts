/**
 * Test harness: a fresh in-memory PGlite database, migrated and seeded,
 * with the full set of adapters wired up in deterministic mode.
 */

import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, type ConcreteDatabase } from '../../packages/database/src/client.ts';
import { migrate } from '../../packages/database/src/migrator.ts';
import { loadConfig, type Config } from '../../packages/config/src/index.ts';
import { seed } from '../../scripts/seed.ts';
import { CubePayAdapter } from '../../packages/cubepay/src/adapter.ts';
import { InMemoryTonAdapter } from '../../packages/ton/src/adapter.ts';
import { StaticRateProvider } from '../../packages/core/src/adapters/rate-provider.ts';
import { StubSigner } from '../../packages/ton/src/signer.ts';

export const TEST_ENV: Record<string, string> = {
  APP_ENV: 'test',
  DATABASE_URL: 'pglite:memory',
  APP_URL: 'http://localhost:3000',
  PLATFORM_FEE_PERCENT: '15',
  PAYOUT_HOLD_HOURS: '48',
  GRAM_NETWORK: 'TON_TESTNET',
  TON_NETWORK: 'TON_TESTNET',
  TREASURY_ADDRESS: 'EQD__________________________________________0vo',
  PAYOUT_WALLET_ADDRESS: 'EQD__________________________________________0vo',
  GRAM_ASSET: 'GRAM',
  TON_SIGNER_REFERENCE: 'kms://test/key-1',
  MIN_PAYOUT_TOMAN: '1000',
  CUBEPAY_SANDBOX: 'true',
  // Set so webhook signature verification is genuinely exercised in tests
  // rather than short-circuiting on "no secret configured".
  CUBEPAY_WEBHOOK_SECRET: 'test-cubepay-webhook-secret',
  TON_MOCK: 'true',
};

export interface Harness {
  db: ConcreteDatabase;
  config: Config;
  cubepay: CubePayAdapter;
  chain: InMemoryTonAdapter;
  rates: StaticRateProvider;
  signer: StubSigner;
  close(): Promise<void>;
}

export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({ ...TEST_ENV, ...overrides });
  const db = (await createDatabase({ url: config.database.url })) as ConcreteDatabase;
  await migrate(db);
  await seed(db, config);

  return {
    db,
    config,
    cubepay: new CubePayAdapter(config.cubepay),
    chain: new InMemoryTonAdapter({ autoConfirm: true }),
    // 1 GRAM = 100,000 Toman.
    rates: new StaticRateProvider('100000', { ttlSeconds: 300, source: 'TEST' }),
    signer: new StubSigner(config.ton),
    close: () => db.close(),
  };
}

/** Create an ACTIVE merchant with an ACTIVE TON wallet. */
export async function createMerchant(
  db: Database,
  options: { name?: string; feeMode?: string; autoPayout?: boolean; wallet?: string } = {},
): Promise<{ merchantId: string; userId: string; walletId: string; address: string }> {
  const userId = randomUUID();
  const merchantId = randomUUID();
  const walletId = randomUUID();
  const address = options.wallet ?? `EQ${randomUUID().replace(/-/g, '')}${'A'.repeat(14)}`.slice(0, 48);

  await db.query(
    `INSERT INTO core.users (id, telegram_user_id, username, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [userId, Math.floor(Math.random() * 1e12), `u_${userId.slice(0, 8)}`],
  );
  await db.query(
    `INSERT INTO core.merchants (id, user_id, name, status, default_fee_mode, auto_payout)
     VALUES ($1, $2, $3, 'ACTIVE', $4, $5)`,
    [merchantId, userId, options.name ?? 'Test Shop', options.feeMode ?? 'CUSTOMER', options.autoPayout ?? true],
  );
  await db.query(
    `INSERT INTO core.wallets (id, merchant_id, network, asset, address, status, verified_at)
     VALUES ($1, $2, 'TON_TESTNET', 'GRAM', $3, 'ACTIVE', NOW())`,
    [walletId, merchantId, address],
  );

  return { merchantId, userId, walletId, address };
}

/** Fund the treasury the only way the system allows: manually. */
export async function fundTreasury(db: Database, gramAtomic: bigint): Promise<string> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM finance.treasury_accounts WHERE asset = 'GRAM' LIMIT 1`,
  );
  const id = r.rows[0]?.id as string;
  const { recordManualTreasuryFunding } = await import('../../packages/core/src/use-cases/payout.ts');
  await recordManualTreasuryFunding(db, {
    treasuryAccountId: id,
    amountAtomic: gramAtomic,
    txHash: `fund_${randomUUID()}`,
  });
  return id;
}

/**
 * Simulate the 48h hold elapsing.
 *
 * Both timestamps move back together: the schema enforces
 * `release_at >= verified_paid_at`, and shifting only one would be an
 * impossible state that production could never reach.
 */
export async function fastForwardRelease(
  db: Database,
  paymentId: string,
  hours = 49,
): Promise<void> {
  const r = await db.query(
    `UPDATE core.payments
        SET verified_paid_at = verified_paid_at - ($2 || ' hours')::interval,
            release_at       = release_at       - ($2 || ' hours')::interval
      WHERE id = $1 AND verified_paid_at IS NOT NULL`,
    [paymentId, String(hours)],
  );
  if (r.rowCount !== 1) {
    throw new Error(`fastForwardRelease: payment ${paymentId} is not in a verified state`);
  }
}
