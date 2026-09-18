/**
 * Composition root.
 *
 * SPEC 103718: the domain depends on ports; only here are concrete adapters
 * chosen. This is also where the treasury manual-only guard is re-asserted at
 * runtime, so no process can boot with automation enabled.
 */

import { createDatabase, type ConcreteDatabase } from '../../database/src/client.ts';
import { migrate } from '../../database/src/migrator.ts';
import { loadConfig, assertTreasuryManualOnly, type Config } from '../../config/src/index.ts';
import { CubePayAdapter } from '../../cubepay/src/adapter.ts';
import { TonAdapter, InMemoryTonAdapter } from '../../ton/src/adapter.ts';
import { StaticRateProvider, HttpRateProvider } from './adapters/rate-provider.ts';
import { createLogger, type Logger } from './logger.ts';
import type { PaymentProviderPort } from './ports/payment-provider.ts';
import type { BlockchainPayoutPort } from './ports/blockchain.ts';
import type { RateProvider } from './ports/rate-provider.ts';

export interface Container {
  config: Config;
  logger: Logger;
  db: ConcreteDatabase;
  provider: PaymentProviderPort;
  chain: BlockchainPayoutPort;
  rates: RateProvider;
  shutdown(): Promise<void>;
}

export async function createContainer(
  options: { service: string; env?: Record<string, string | undefined>; runMigrations?: boolean } = {
    service: 'gateway',
  },
): Promise<Container> {
  const config = loadConfig(options.env ?? process.env);

  // Belt and braces: loadConfig already checks this, but a container must never
  // hand out adapters for a process whose treasury policy is unsafe.
  assertTreasuryManualOnly(config.treasury);

  const logger = createLogger({ level: config.app.logLevel, service: options.service });
  const db = (await createDatabase({
    url: config.database.url,
    poolMax: config.database.poolMax,
    ssl: config.database.ssl,
  })) as ConcreteDatabase;

  if (options.runMigrations ?? !config.app.isProduction) {
    const result = await migrate(db);
    if (result.applied.length > 0) {
      logger.info('db.migrated', { applied: result.applied });
    }
  }

  const provider = new CubePayAdapter(config.cubepay, config.security.hmacWindowSeconds);

  const chain: BlockchainPayoutPort = config.ton.mock
    ? new InMemoryTonAdapter({ autoConfirm: true })
    : new TonAdapter(config.ton);

  const rateUrl = (options.env ?? process.env)['RATE_SOURCE_URL'];
  const rates: RateProvider = rateUrl
    ? new HttpRateProvider({ url: rateUrl, ttlSeconds: config.settlement.quoteTtlSeconds })
    : new StaticRateProvider((options.env ?? process.env)['STATIC_TOMAN_PER_GRAM'] ?? '100000', {
        ttlSeconds: config.settlement.quoteTtlSeconds,
        source: 'STATIC',
      });

  logger.info('container.ready', {
    env: config.app.env,
    driver: db.driver,
    provider: provider.name,
    chain: config.ton.mock ? 'in-memory' : config.ton.network,
    treasury: 'MANUAL_ONLY',
  });

  return {
    config,
    logger,
    db,
    provider,
    chain,
    rates,
    async shutdown() {
      await db.close();
    },
  };
}
