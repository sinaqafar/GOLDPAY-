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
import { ConfigError } from '../../errors/src/index.ts';
import { CubePayAdapter } from '../../cubepay/src/adapter.ts';
import { TonAdapter, InMemoryTonAdapter } from '../../ton/src/adapter.ts';
import { StaticRateProvider, HttpRateProvider } from './adapters/rate-provider.ts';
import { RateAggregator } from './adapters/rate-aggregator.ts';
import { CoinGeckoCryptoProvider, TindexFxProvider } from './adapters/market-sources.ts';
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

  const rates = buildRateProvider(config, options.env ?? process.env);

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

/**
 * Choose how TOMAN/GRAM is priced.
 *
 * Preference order:
 *   1. RateAggregator — GRAM/USD × USD/TOMAN from real market sources. This is
 *      the production path: two independent legs, each with failover.
 *   2. HttpRateProvider — a single pre-computed TOMAN/GRAM endpoint.
 *   3. StaticRateProvider — a fixed number, for tests and local development.
 *
 * Production refuses the static provider outright: settling real GRAM against
 * a hardcoded rate would send the wrong amount the moment the market moved.
 */
function buildRateProvider(config: Config, env: NodeJS.ProcessEnv): RateProvider {
  const fxUrl = env['FX_USD_TOMAN_URL'];
  const ttlSeconds = config.settlement.quoteTtlSeconds;

  if (fxUrl) {
    const cryptoSources = [
      new CoinGeckoCryptoProvider({
        baseUrl: env['COINGECKO_BASE_URL'],
        coinId: env['GRAM_COIN_ID'] ?? 'the-open-network',
        apiKey: env['COINGECKO_API_KEY'] ?? null,
      }),
    ];
    const fxSources = [new TindexFxProvider({ url: fxUrl, apiKey: env['FX_API_KEY'] ?? null })];

    return new RateAggregator({
      cryptoSources,
      fxSources,
      ttlSeconds,
      maxObservationAgeSeconds: Number(env['RATE_MAX_AGE_SECONDS'] ?? 900),
      minTomanPerGram: env['RATE_MIN_TOMAN_PER_GRAM'] ?? '1',
      maxTomanPerGram: env['RATE_MAX_TOMAN_PER_GRAM'] ?? '1000000000',
      maxDeviationPercent: Number(env['RATE_MAX_DEVIATION_PERCENT'] ?? 25),
    });
  }

  const rateUrl = env['RATE_SOURCE_URL'];
  if (rateUrl) {
    return new HttpRateProvider({ url: rateUrl, ttlSeconds });
  }

  if (config.app.isProduction) {
    throw new ConfigError(
      'RATE_SOURCE_REQUIRED',
      'production needs FX_USD_TOMAN_URL (aggregator) or RATE_SOURCE_URL; a static rate is not acceptable',
    );
  }

  return new StaticRateProvider(env['STATIC_TOMAN_PER_GRAM'] ?? '100000', {
    ttlSeconds,
    source: 'STATIC',
  });
}
