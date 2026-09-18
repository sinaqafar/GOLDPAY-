/**
 * packages/config — validated configuration with fail-fast startup guards.
 *
 * SPEC 117.34 / 103760-103761: if any treasury-automation flag is enabled the
 * application MUST refuse to start with FORBIDDEN_TREASURY_AUTOMATION.
 * SPEC 4325: DEBUG=true is forbidden in production.
 * SPEC 4326/4328: secrets never live in source; they arrive via the environment.
 */

import { ConfigError, ErrorCodes } from '../../errors/src/index.ts';
import { Percentage } from '../../money/src/index.ts';

export type AppEnv = 'local' | 'test' | 'staging' | 'production';

export interface AppConfig {
  readonly env: AppEnv;
  readonly isProduction: boolean;
  readonly appName: string;
  readonly port: number;
  readonly host: string;
  readonly appUrl: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly debug: boolean;
}

export interface DatabaseConfig {
  /** `pglite:<dir>` runs an embedded PostgreSQL; `postgres://...` uses a server. */
  readonly url: string;
  readonly poolMin: number;
  readonly poolMax: number;
  readonly ssl: boolean;
  readonly statementTimeoutMs: number;
}

export interface FeeConfig {
  readonly platformFeePercent: Percentage;
  readonly policyVersion: string;
  readonly defaultFeeMode: 'CUSTOMER' | 'MERCHANT' | 'SPLIT';
}

export interface SettlementConfig {
  readonly holdHours: number;
  readonly autoPayoutEnabled: boolean;
  readonly minPayoutToman: bigint;
  readonly maxPayoutToman: bigint;
  readonly reservationTtlSeconds: number;
  readonly quoteTtlSeconds: number;
}

export interface TreasuryConfig {
  readonly network: string;
  readonly asset: string;
  readonly gramDecimals: number;
  readonly address: string | null;
  /** All of these MUST be false; they exist only so the guard can prove it. */
  readonly autoFunding: boolean;
  readonly autoBuy: boolean;
  readonly autoSwap: boolean;
  readonly autoExchange: boolean;
  readonly autoBridge: boolean;
  readonly safetyReserveGramAtomic: bigint;
}

export interface SecurityConfig {
  readonly hmacWindowSeconds: number;
  readonly nonceTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly apiRateLimitPerMinute: number;
  readonly webhookTimeoutMs: number;
  readonly webhookMaxRetries: number;
  readonly allowedWebhookSchemes: readonly string[];
}

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly apiSecret: string | null;
  readonly webhookSecret: string | null;
  readonly timeoutMs: number;
  /** When true the adapter is a deterministic in-memory sandbox. */
  readonly sandbox: boolean;
}

export interface TonConfig {
  readonly network: string;
  readonly endpoint: string;
  readonly apiKey: string | null;
  readonly minConfirmations: number;
  readonly timeoutMs: number;
  /** Jetton master contract of the GRAM asset. */
  readonly gramJettonMaster: string;
  readonly gramDecimals: number;
  /** Hot wallet that payouts are sent from. */
  readonly payoutWalletAddress: string | null;
  /**
   * Opaque handle to the signing key held by a KMS/HSM.
   * SPEC 118.37: never the key material itself.
   */
  readonly signerReference: string | null;
  /** When true, no real chain call is ever made. */
  readonly mock: boolean;
}

export interface TelegramConfig {
  readonly botToken: string | null;
  readonly webhookSecret: string | null;
  readonly miniAppUrl: string | null;
}

export interface Config {
  readonly app: AppConfig;
  readonly database: DatabaseConfig;
  readonly fees: FeeConfig;
  readonly settlement: SettlementConfig;
  readonly treasury: TreasuryConfig;
  readonly security: SecurityConfig;
  readonly cubepay: ProviderConfig;
  readonly ton: TonConfig;
  readonly telegram: TelegramConfig;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback?: string): string {
  const v = env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new ConfigError('MISSING_CONFIG', `required environment variable ${key} is not set`);
  }
  return v;
}

function optional(env: Env, key: string): string | null {
  const v = env[key];
  return v === undefined || v === '' ? null : v;
}

function int(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  if (!/^-?\d+$/.test(v.trim())) {
    throw new ConfigError('INVALID_CONFIG', `${key} must be an integer, got "${v}"`);
  }
  return Number.parseInt(v, 10);
}

function big(env: Env, key: string, fallback: bigint): bigint {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v.trim())) {
    throw new ConfigError('INVALID_CONFIG', `${key} must be a non-negative integer, got "${v}"`);
  }
  return BigInt(v.trim());
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(n)) return true;
  if (['false', '0', 'no', 'off'].includes(n)) return false;
  throw new ConfigError('INVALID_CONFIG', `${key} must be a boolean, got "${v}"`);
}

function parseEnvName(raw: string): AppEnv {
  const v = raw.trim().toLowerCase();
  if (v === 'production' || v === 'prod') return 'production';
  if (v === 'staging') return 'staging';
  if (v === 'test') return 'test';
  if (v === 'local' || v === 'development' || v === 'dev') return 'local';
  throw new ConfigError('INVALID_CONFIG', `unknown APP_ENV: ${raw}`);
}

/**
 * Independent runtime guard (SPEC 4340): even if configuration is wrong, the
 * financial core refuses to run with any automated treasury behaviour.
 */
export function assertTreasuryManualOnly(treasury: TreasuryConfig): void {
  const violations = (
    [
      ['AUTO_FUNDING', treasury.autoFunding],
      ['AUTO_BUY', treasury.autoBuy],
      ['AUTO_SWAP', treasury.autoSwap],
      ['AUTO_EXCHANGE', treasury.autoExchange],
      ['AUTO_BRIDGE', treasury.autoBridge],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([name]) => name);

  if (violations.length > 0) {
    throw new ConfigError(
      ErrorCodes.FORBIDDEN_TREASURY_AUTOMATION,
      `treasury funding is manual-only; these flags must be false: ${violations.join(', ')}`,
      { violations },
    );
  }
}

export function loadConfig(env: Env = process.env): Config {
  const appEnv = parseEnvName(str(env, 'APP_ENV', env['NODE_ENV'] ?? 'local'));
  const isProduction = appEnv === 'production';

  const debug = bool(env, 'DEBUG', false);
  if (isProduction && debug) {
    // SPEC 4325.
    throw new ConfigError('DEBUG_FORBIDDEN_IN_PRODUCTION', 'DEBUG=true is not allowed in production');
  }

  const treasury: TreasuryConfig = {
    network: str(env, 'GRAM_NETWORK', 'TON_TESTNET'),
    asset: str(env, 'GRAM_ASSET', 'GRAM'),
    gramDecimals: int(env, 'GRAM_DECIMALS', 9),
    address: optional(env, 'TREASURY_ADDRESS'),
    autoFunding: bool(env, 'AUTO_FUNDING', false),
    autoBuy: bool(env, 'AUTO_BUY', false),
    autoSwap: bool(env, 'AUTO_SWAP', false),
    autoExchange: bool(env, 'AUTO_EXCHANGE', false),
    autoBridge: bool(env, 'AUTO_BRIDGE', false),
    safetyReserveGramAtomic: big(env, 'GRAM_SAFETY_RESERVE', 0n),
  };
  // Fail fast, before anything else can touch money.
  assertTreasuryManualOnly(treasury);

  if (treasury.gramDecimals !== 9) {
    throw new ConfigError('INVALID_CONFIG', 'GRAM_DECIMALS must be 9');
  }

  const holdHours = int(env, 'PAYOUT_HOLD_HOURS', 48);
  if (holdHours < 0) {
    throw new ConfigError('INVALID_CONFIG', 'PAYOUT_HOLD_HOURS cannot be negative');
  }

  const feePercentRaw = Number.parseFloat(str(env, 'PLATFORM_FEE_PERCENT', '15'));
  const platformFeePercent = Percentage.fromPercent(feePercentRaw);
  if (platformFeePercent.bps > 10_000n) {
    throw new ConfigError('INVALID_CONFIG', 'PLATFORM_FEE_PERCENT cannot exceed 100');
  }

  const defaultFeeModeRaw = str(env, 'DEFAULT_FEE_MODE', 'CUSTOMER').toUpperCase();
  if (!['CUSTOMER', 'MERCHANT', 'SPLIT'].includes(defaultFeeModeRaw)) {
    throw new ConfigError('INVALID_CONFIG', `unknown DEFAULT_FEE_MODE: ${defaultFeeModeRaw}`);
  }

  const cubepaySandbox = bool(env, 'CUBEPAY_SANDBOX', !isProduction);
  const tonMock = bool(env, 'TON_MOCK', !isProduction);

  const config: Config = {
    app: {
      env: appEnv,
      isProduction,
      appName: str(env, 'APP_NAME', 'goldpay-gateway'),
      port: int(env, 'APP_PORT', 3000),
      // Bind on all interfaces so the sandbox preview proxy can reach it.
      host: str(env, 'APP_HOST', '0.0.0.0'),
      appUrl: str(env, 'APP_URL', 'http://localhost:3000'),
      logLevel: (str(env, 'LOG_LEVEL', isProduction ? 'info' : 'debug') as AppConfig['logLevel']),
      debug,
    },
    database: {
      url: str(env, 'DATABASE_URL', 'pglite:.pgdata'),
      poolMin: int(env, 'DATABASE_POOL_MIN', 1),
      poolMax: int(env, 'DATABASE_POOL_MAX', 10),
      ssl: bool(env, 'DATABASE_SSL', isProduction),
      statementTimeoutMs: int(env, 'DATABASE_STATEMENT_TIMEOUT_MS', 15_000),
    },
    fees: {
      platformFeePercent,
      policyVersion: str(env, 'FEE_POLICY_VERSION', 'v1'),
      defaultFeeMode: defaultFeeModeRaw as FeeConfig['defaultFeeMode'],
    },
    settlement: {
      holdHours,
      autoPayoutEnabled: bool(env, 'AUTO_PAYOUT_DEFAULT', true),
      minPayoutToman: big(env, 'MIN_PAYOUT_TOMAN', 10_000n),
      maxPayoutToman: big(env, 'MAX_PAYOUT_TOMAN', 1_000_000_000n),
      reservationTtlSeconds: int(env, 'RESERVATION_TTL_SECONDS', 900),
      quoteTtlSeconds: int(env, 'QUOTE_TTL_SECONDS', 300),
    },
    treasury,
    security: {
      hmacWindowSeconds: int(env, 'HMAC_WINDOW_SECONDS', 300),
      nonceTtlSeconds: int(env, 'NONCE_TTL_SECONDS', 900),
      sessionTtlSeconds: int(env, 'SESSION_TTL_SECONDS', 3600),
      apiRateLimitPerMinute: int(env, 'API_RATE_LIMIT', 120),
      webhookTimeoutMs: int(env, 'WEBHOOK_TIMEOUT_MS', 10_000),
      webhookMaxRetries: int(env, 'WEBHOOK_MAX_RETRIES', 8),
      allowedWebhookSchemes: (str(env, 'WEBHOOK_ALLOWED_SCHEMES', 'https') || 'https')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    },
    cubepay: {
      baseUrl: str(env, 'CUBEPAY_BASE_URL', 'https://api.cubepay.example'),
      apiKey: optional(env, 'CUBEPAY_API_KEY'),
      apiSecret: optional(env, 'CUBEPAY_API_SECRET'),
      webhookSecret: optional(env, 'CUBEPAY_WEBHOOK_SECRET'),
      timeoutMs: int(env, 'CUBEPAY_TIMEOUT_MS', 15_000),
      sandbox: cubepaySandbox,
    },
    ton: {
      network: str(env, 'TON_NETWORK', isProduction ? 'TON_MAINNET' : 'TON_TESTNET'),
      endpoint: str(
        env,
        'TON_API_URL',
        isProduction ? 'https://toncenter.com' : 'https://testnet.toncenter.com',
      ),
      apiKey: optional(env, 'TON_API_KEY'),
      minConfirmations: int(env, 'TON_REQUIRED_CONFIRMATIONS', 1),
      timeoutMs: int(env, 'TON_REQUEST_TIMEOUT_MS', 20_000),
      gramJettonMaster: str(env, 'GRAM_JETTON_MASTER', ''),
      gramDecimals: treasury.gramDecimals,
      payoutWalletAddress: optional(env, 'PAYOUT_WALLET_ADDRESS'),
      signerReference: optional(env, 'TON_SIGNER_REFERENCE'),
      mock: tonMock,
    },
    telegram: {
      botToken: optional(env, 'TELEGRAM_BOT_TOKEN'),
      webhookSecret: optional(env, 'TELEGRAM_WEBHOOK_SECRET'),
      miniAppUrl: optional(env, 'TELEGRAM_MINI_APP_URL'),
    },
  };

  validateProductionInvariants(config);
  return Object.freeze(config);
}

/**
 * SPEC 117.94/117.95 + 4331: production must have every secret present and must
 * never run against a sandbox/mock adapter or a testnet.
 */
function validateProductionInvariants(config: Config): void {
  if (!config.app.isProduction) return;

  const missing: string[] = [];
  if (!config.cubepay.apiKey) missing.push('CUBEPAY_API_KEY');
  if (!config.cubepay.webhookSecret) missing.push('CUBEPAY_WEBHOOK_SECRET');
  if (!config.telegram.botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.treasury.address) missing.push('TREASURY_ADDRESS');
  if (!config.ton.payoutWalletAddress) missing.push('PAYOUT_WALLET_ADDRESS');
  if (!config.ton.gramJettonMaster) missing.push('GRAM_JETTON_MASTER');
  if (!config.ton.signerReference) missing.push('TON_SIGNER_REFERENCE');
  if (missing.length > 0) {
    throw new ConfigError('MISSING_PRODUCTION_SECRETS', `missing in production: ${missing.join(', ')}`, {
      missing,
    });
  }

  if (config.cubepay.sandbox) {
    throw new ConfigError('SANDBOX_IN_PRODUCTION', 'CUBEPAY_SANDBOX must be false in production');
  }
  if (config.ton.mock) {
    throw new ConfigError('MOCK_IN_PRODUCTION', 'TON_MOCK must be false in production');
  }
  if (config.ton.network !== 'TON_MAINNET' || config.treasury.network !== 'TON_MAINNET') {
    throw new ConfigError('TESTNET_IN_PRODUCTION', 'production must use TON_MAINNET');
  }
  if (config.database.url.startsWith('pglite:')) {
    throw new ConfigError('EMBEDDED_DB_IN_PRODUCTION', 'production requires a PostgreSQL server URL');
  }
  if (!config.security.allowedWebhookSchemes.every((s) => s === 'https')) {
    throw new ConfigError('INSECURE_WEBHOOK_SCHEME', 'production webhooks must be https-only');
  }
}
