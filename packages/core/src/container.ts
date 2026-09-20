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
import { StubSigner, KmsSigner } from '../../ton/src/signer.ts';
import { TestOnlyStaticRateProvider, HttpRateProvider } from './adapters/rate-provider.ts';
import { RateAggregator } from './adapters/rate-aggregator.ts';
import {
  CoinGeckoCryptoProvider,
  CoinPaprikaCryptoProvider,
  TindexFxProvider,
  GenericFxProvider,
} from './adapters/market-sources.ts';
import { createLogger, type Logger } from './logger.ts';
import type { PaymentProviderPort } from './ports/payment-provider.ts';
import type { BlockchainPayoutPort } from './ports/blockchain.ts';
import type { RateProvider } from './ports/rate-provider.ts';
import type { SignerPort } from './ports/signer.ts';
import type { QueuePort } from './ports/queue.ts';
import { TelegramClient, NullTelegramClient } from '../../telegram/src/client.ts';
import type { TelegramSender } from './notifications.ts';
import { InMemoryQueue } from '../../queue/src/in-memory-queue.ts';
import { BullMqQueue } from '../../queue/src/bullmq-queue.ts';

export interface Container {
  config: Config;
  logger: Logger;
  db: ConcreteDatabase;
  provider: PaymentProviderPort;
  chain: BlockchainPayoutPort;
  rates: RateProvider;
  signer: SignerPort;
  queue: QueuePort;
  telegram: TelegramSender;
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

  const rates = buildRateProvider(config, options.env ?? process.env, db);
  const signer = buildSigner(config, options.env ?? process.env);
  const queue = buildQueue(config, options.env ?? process.env);
  // A missing bot token degrades to a no-op sender rather than failing: the
  // gateway must keep settling money even when Telegram is not configured.
  const telegram: TelegramSender = config.telegram.botToken
    ? new TelegramClient(config.telegram.botToken)
    : new NullTelegramClient();

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
    signer,
    queue,
    telegram,
    async shutdown() {
      await queue.close();
      await db.close();
    },
  };
}

/**
 * Choose how TOMAN/GRAM is priced.
 *
 * Preference order:
 *   1. RateAggregator — GRAM/USD × USD/TOMAN from real market sources. This is
 *      the production path: two independent legs, each with quorum and failover.
 *   2. HttpRateProvider — a single pre-computed TOMAN/GRAM endpoint.
 *   3. TestOnlyStaticRateProvider — a fixed number, for tests and local development.
 *
 * Production refuses the static provider outright: settling real GRAM against
 * a hardcoded rate would send the wrong amount the moment the market moved.
 */
function buildRateProvider(
  config: Config,
  env: NodeJS.ProcessEnv,
  db?: ConcreteDatabase,
): RateProvider {
  const fxUrl = env['FX_USD_TOMAN_URL'];
  const ttlSeconds = config.settlement.quoteTtlSeconds;

  if (fxUrl) {
    const cryptoSources = [
      new CoinGeckoCryptoProvider({
        baseUrl: env['COINGECKO_BASE_URL'],
        coinId: env['GRAM_COIN_ID'] ?? 'the-open-network',
        apiKey: env['COINGECKO_API_KEY'] ?? null,
      }),
      new CoinPaprikaCryptoProvider({
        baseUrl: env['COINPAPRIKA_BASE_URL'],
        coinId: env['COINPAPRIKA_COIN_ID'] ?? 'ton-the-open-network',
      }),
    ];

    const fallbackFxUrl = env['FX_FALLBACK_URL'];
    if (config.app.isProduction && !fallbackFxUrl) {
      throw new ConfigError(
        'MANDATORY_FX_QUORUM_MISSING',
        'Production requires at least 2 independent FX sources for USD/TOMAN (FX_USD_TOMAN_URL and FX_FALLBACK_URL)',
      );
    }

    const fxSources = [
      new TindexFxProvider({ url: fxUrl, apiKey: env['FX_API_KEY'] ?? null }),
      ...(fallbackFxUrl
        ? [new GenericFxProvider({ url: fallbackFxUrl, name: 'FX_FALLBACK' })]
        : []),
    ];

    return new RateAggregator({
      cryptoSources,
      fxSources,
      ttlSeconds,
      maxObservationAgeSeconds: Number(env['RATE_MAX_AGE_SECONDS'] ?? 900),
      minTomanPerGram: env['RATE_MIN_TOMAN_PER_GRAM'] ?? '1',
      maxTomanPerGram: env['RATE_MAX_TOMAN_PER_GRAM'] ?? '1000000000',
      maxDeviationPercent: Number(env['RATE_MAX_DEVIATION_PERCENT'] ?? 25),
      maxCrossSourceDeviationPercent: Number(env['RATE_MAX_CROSS_SOURCE_DEVIATION_PERCENT'] ?? 10),
      // Survives a restart: without a persisted baseline the first quote after
      // a deploy is compared to nothing and any move is accepted.
      ...(db
        ? {
            loadBaseline: async () => {
              const r = await db.query<{ rate: string }>(
                `SELECT rate::text FROM finance.rate_quotes
                  WHERE base_currency = 'TOMAN' AND quote_asset = 'GRAM'
                  ORDER BY created_at DESC LIMIT 1`,
              );
              return r.rows[0]?.rate ?? null;
            },
          }
        : {}),
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

  return new TestOnlyStaticRateProvider(env['STATIC_TOMAN_PER_GRAM'] ?? '100000', {
    ttlSeconds,
    source: 'STATIC',
  });
}

/**
 * Choose the signer.
 *
 * The port is a permanent boundary (see ports/signer.ts): production must put a
 * KMS or HSM behind it. The stub exists only so development and tests can drive
 * the full RESERVED -> SIGNED -> BROADCASTED pipeline, and it refuses to
 * construct in production.
 */
function buildSigner(config: Config, env: NodeJS.ProcessEnv): SignerPort {
  const endpoint = env['SIGNER_ENDPOINT'];
  const keyReference = config.ton.signerReference;

  if (endpoint && keyReference) {
    return new KmsSigner({
      config: config.ton,
      endpoint,
      keyReference,
      apiKey: env['SIGNER_API_KEY'] ?? null,
      timeoutMs: Number(env['SIGNER_TIMEOUT_MS'] ?? 10_000),
    });
  }

  if (config.app.isProduction) {
    throw new ConfigError(
      'SIGNER_REQUIRED',
      'production requires SIGNER_ENDPOINT and TON_SIGNER_REFERENCE; a local or stub signer is not acceptable',
    );
  }

  return new StubSigner(config.ton, { isProduction: false });
}

/**
 * Choose the queue.
 *
 * BullMQ over Redis is the production implementation; the in-memory queue is
 * for tests and single-process development and cannot survive a restart, so
 * production refuses it.
 *
 * Either way the queue only ever carries identifiers. PostgreSQL remains the
 * financial source of truth, so a lost or replayed job cannot corrupt state
 * (SPEC 121.67).
 */
function buildQueue(config: Config, env: NodeJS.ProcessEnv): QueuePort {
  const redisUrl = env['REDIS_URL'];

  if (redisUrl) {
    return new BullMqQueue({
      redisUrl,
      prefix: env['QUEUE_PREFIX'] ?? `gram:${config.app.env}`,
      defaultAttempts: Number(env['QUEUE_MAX_ATTEMPTS'] ?? 5),
      defaultBackoffMs: Number(env['QUEUE_BACKOFF_MS'] ?? 10_000),
    });
  }

  if (config.app.isProduction) {
    throw new ConfigError(
      'REDIS_REQUIRED',
      'production requires REDIS_URL; an in-memory queue does not survive a restart',
    );
  }

  return new InMemoryQueue();
}
