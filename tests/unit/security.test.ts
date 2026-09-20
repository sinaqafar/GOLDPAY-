/**
 * Security tests — SPEC 117.86: signature verification, replay, treasury
 * manual-only guard, and SSRF protection on outbound webhooks.
 */

import { describe, it, expect } from 'vitest';
import {
  signRequest,
  verifySignedRequest,
  verifyWebhookSignature,
  signOutboundWebhook,
  generateApiKey,
  hashApiSecret,
  verifyApiSecret,
  parseApiToken,
  verifyTelegramInitData,
  sha256Hex,
} from '../../packages/crypto/src/index.ts';
import { createHmac } from 'node:crypto';
import { loadConfig, assertTreasuryManualOnly } from '../../packages/config/src/index.ts';
import { SecurityError, ConfigError } from '../../packages/errors/src/index.ts';
import { isPrivateAddress, assertSafeWebhookUrl } from '../../packages/core/src/webhooks.ts';
import { TEST_ENV } from '../helpers/harness.ts';
import { StubSigner, AwsKmsEd25519Signer } from '../../packages/ton/src/signer.ts';
import {
  buildCanonicalTonSigningPayload,
  assembleSignedTonExternalMessage,
} from '../../packages/ton/src/ton-wallet-message.ts';
import { TonSeqnoManager } from '../../packages/ton/src/seqno-manager.ts';
import { keyPairFromSeed, sign, signVerify } from '@ton/crypto';
import {
  RateAggregator,
  StaticCryptoMarketProvider,
  StaticFxProvider,
} from '../../packages/core/src/adapters/rate-aggregator.ts';
import {
  TokenBucketRateLimiter,
  RedisRateLimiter,
  ruleFor,
} from '../../packages/core/src/rate-limit.ts';

const SECRET = 'test-secret-value';

describe('request signing', () => {
  const base = {
    method: 'POST',
    path: '/v1/invoices',
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: 'nonce-1234',
    rawBody: '{"amount":"1000"}',
  };

  function signed(overrides: Partial<typeof base> = {}) {
    const parts = { ...base, ...overrides };
    return {
      ...parts,
      secret: SECRET,
      windowSeconds: 300,
      signature: signRequest(SECRET, {
        method: parts.method,
        path: parts.path,
        timestamp: parts.timestamp,
        nonce: parts.nonce,
        bodySha256: sha256Hex(parts.rawBody),
      }),
    };
  }

  it('accepts a correctly signed request', () => {
    expect(() => verifySignedRequest(signed())).not.toThrow();
  });

  it('rejects a tampered body even when the signature is otherwise valid', () => {
    const req = signed();
    req.rawBody = '{"amount":"999999999"}';
    expect(() => verifySignedRequest(req)).toThrow(SecurityError);
  });

  it('rejects a tampered path — a signature is not transferable between routes', () => {
    const req = signed();
    req.path = '/v1/payouts';
    expect(() => verifySignedRequest(req)).toThrow(SecurityError);
  });

  it('rejects a signature made with the wrong secret', () => {
    const req = signed();
    req.secret = 'a-different-secret';
    expect(() => verifySignedRequest(req)).toThrow(SecurityError);
  });

  it('rejects a stale timestamp outside the window', () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(() => verifySignedRequest(signed({ timestamp: old }))).toThrow(SecurityError);
  });

  it('rejects a timestamp from the future beyond the window', () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    expect(() => verifySignedRequest(signed({ timestamp: future }))).toThrow(SecurityError);
  });

  it('rejects a missing or too-short nonce', () => {
    expect(() => verifySignedRequest(signed({ nonce: 'x' }))).toThrow(SecurityError);
  });
});

describe('webhook signatures', () => {
  it('verifies an inbound provider webhook', () => {
    const rawBody = '{"event":"payment.paid"}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
    expect(() =>
      verifyWebhookSignature({ secret: SECRET, rawBody, timestamp, signature, windowSeconds: 300 }),
    ).not.toThrow();
  });

  it('rejects a replayed body carrying an old timestamp', () => {
    const rawBody = '{"event":"payment.paid"}';
    const timestamp = String(Math.floor(Date.now() / 1000) - 7200);
    const signature = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
    expect(() =>
      verifyWebhookSignature({ secret: SECRET, rawBody, timestamp, signature, windowSeconds: 300 }),
    ).toThrow(SecurityError);
  });

  it('binds the outbound signature to the timestamp, so it cannot be reused later', () => {
    const body = '{"id":"evt_1"}';
    const a = signOutboundWebhook(SECRET, body, 1_700_000_000);
    const b = signOutboundWebhook(SECRET, body, 1_700_000_001);
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('API keys', () => {
  it('never stores the plaintext secret and verifies correctly', () => {
    const key = generateApiKey();
    const { prefix, secret } = parseApiToken(key.token);
    expect(prefix).toBe(key.prefix);
    expect(key.secretHash).not.toContain(secret);
    expect(verifyApiSecret(secret, key.secretHash)).toBe(true);
    expect(verifyApiSecret('wrong-secret', key.secretHash)).toBe(false);
  });

  it('produces a different hash for the same secret each time (salted)', () => {
    const { token } = generateApiKey();
    const { secret } = parseApiToken(token);
    expect(hashApiSecret(secret)).not.toBe(hashApiSecret(secret));
  });
});

describe('Telegram initData', () => {
  const botToken = '123456:TEST-BOT-TOKEN';

  function buildInitData(authDate: number, userId = 42): string {
    const user = JSON.stringify({ id: userId, username: 'tester' });
    const pairs = [`auth_date=${authDate}`, `user=${user}`];
    const checkString = pairs.slice().sort().join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');
    const params = new URLSearchParams({ auth_date: String(authDate), user, hash });
    return params.toString();
  }

  it('accepts valid initData and extracts the user', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = verifyTelegramInitData(buildInitData(now), botToken);
    expect(result.userId).toBe(42);
  });

  it('rejects initData signed with a different bot token', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => verifyTelegramInitData(buildInitData(now), 'other-token')).toThrow(SecurityError);
  });

  it('rejects expired initData', () => {
    const old = Math.floor(Date.now() / 1000) - 200_000;
    expect(() => verifyTelegramInitData(buildInitData(old), botToken)).toThrow(SecurityError);
  });
});

describe('treasury manual-only guard (SPEC 4340)', () => {
  const flags = ['AUTO_FUNDING', 'AUTO_BUY', 'AUTO_SWAP', 'AUTO_EXCHANGE', 'AUTO_BRIDGE'];

  it.each(flags)('refuses to start when %s is enabled', (flag) => {
    expect(() => loadConfig({ ...TEST_ENV, [flag]: 'true' })).toThrow(ConfigError);
    try {
      loadConfig({ ...TEST_ENV, [flag]: 'true' });
    } catch (e) {
      expect((e as ConfigError).code).toBe('FORBIDDEN_TREASURY_AUTOMATION');
    }
  });

  it('starts cleanly when every automation flag is false', () => {
    expect(() => loadConfig(TEST_ENV)).not.toThrow();
  });

  it('the standalone guard also rejects a hand-built config', () => {
    expect(() =>
      assertTreasuryManualOnly({
        network: 'TON_MAINNET',
        asset: 'GRAM',
        gramDecimals: 9,
        address: null,
        autoFunding: false,
        autoBuy: true,
        autoSwap: false,
        autoExchange: false,
        autoBridge: false,
        safetyReserveGramAtomic: 0n,
      }),
    ).toThrow(ConfigError);
  });
});

describe('outbound webhook SSRF protection', () => {
  it('classifies private and loopback addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('rejects the cloud metadata endpoint', async () => {
    await expect(assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data', ['https'])).rejects.toThrow();
  });

  it('rejects http when only https is allowed', async () => {
    await expect(assertSafeWebhookUrl('http://example.com/hook', ['https'])).rejects.toThrow();
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(
      assertSafeWebhookUrl('https://user:pass@example.com/hook', ['https']),
    ).rejects.toThrow();
  });
});

describe('SignerPort (SPEC 5485-5487 / 5569)', () => {
  const tonConfig = {
    network: 'TON_TESTNET',
    endpoint: 'https://example.invalid',
    apiKey: null,
    minConfirmations: 1,
    timeoutMs: 1000,
    gramAsset: 'GRAM',
    gramDecimals: 9,
    payoutWalletAddress: 'EQD__________________________________________0vo',
    signerReference: 'kms://test/key-1',
    mock: true,
  } as const;

  const request = {
    signRequestId: 'payout:abc',
    payoutId: 'abc',
    asset: 'GRAM',
    network: 'TON_TESTNET',
    destinationAddress: 'UQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAZAm',
    amountAtomic: '10000000000',
    fromAddress: 'EQD__________________________________________0vo',
  };

  it('signs a well-formed request', async () => {
    const signer = new StubSigner(tonConfig);
    const signed = await signer.sign(request);
    expect(signed.signingReference).toMatch(/^stub:/);
    expect(signed.signer).toBe('STUB_SIGNER');
  });

  it('never produces a second signature for the same request id', async () => {
    const signer = new StubSigner(tonConfig);
    await signer.sign(request);
    await expect(signer.sign(request)).rejects.toThrow(/already produced a signature/);
  });

  it('refuses the wrong asset even when the caller insists', async () => {
    const signer = new StubSigner(tonConfig);
    await expect(signer.sign({ ...request, asset: 'USDT' })).rejects.toThrow(
      /refusing to sign asset/,
    );
  });

  it('refuses the wrong network', async () => {
    const signer = new StubSigner(tonConfig);
    await expect(signer.sign({ ...request, network: 'TON_MAINNET' })).rejects.toThrow(
      /refusing to sign for network/,
    );
  });

  it('refuses to send from a wallet it does not control', async () => {
    const signer = new StubSigner(tonConfig);
    await expect(signer.sign({ ...request, fromAddress: 'EQsomeoneElse' })).rejects.toThrow(
      /does not control/,
    );
  });

  it('refuses a non-positive amount', async () => {
    const signer = new StubSigner(tonConfig);
    await expect(signer.sign({ ...request, amountAtomic: '0' })).rejects.toThrow(
      /non-positive amount/,
    );
  });

  it('cannot be constructed in production at all', async () => {
    expect(() => new StubSigner(tonConfig, { isProduction: true })).toThrow(
      /never be used in production/,
    );
  });

  describe('Canonical TON Wallet Message Construction', () => {
    it('builds canonical 32-byte representation hash and packages valid Ed25519 signature', () => {
      const canonical = buildCanonicalTonSigningPayload({
        walletAddress: 'EQD__________________________________________0vo',
        destinationAddress: 'UQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAZAm',
        amountNanograms: 10_000_000_000n,
        seqno: 5,
        validUntil: 1800000000,
      });

      expect(canonical.digest).toHaveLength(32);
      expect(canonical.digestHex).toHaveLength(64);

      // Verify Ed25519 signature verification against the representation hash
      const seed = Buffer.alloc(32, 0x55);
      const keyPair = keyPairFromSeed(seed);
      const realSig = sign(Buffer.from(canonical.digest), keyPair.secretKey);
      expect(realSig).toHaveLength(64);

      const isValid = signVerify(Buffer.from(canonical.digest), realSig, keyPair.publicKey);
      expect(isValid).toBe(true);

      const assembled = assembleSignedTonExternalMessage(canonical, realSig);
      expect(assembled.signatureHex).toHaveLength(128);
      expect(assembled.bocBase64.length).toBeGreaterThan(50);
      expect(assembled.signingReference).toMatch(/^ton-boc:/);
    });
  });

  describe('TonSeqnoManager sequence reservation', () => {
    it('allocates strictly monotonic sequence numbers starting from current on-chain seqno N', async () => {
      const dbSequences = new Map<string, any>();
      const dbAllocations = new Map<string, any>();

      const mockDb: any = {
        transaction: async (fn: any) => {
          const tx = {
            query: async (sql: string, params?: any[]) => {
              if (sql.includes('FROM finance.payout_seqno_allocations')) {
                const row = dbAllocations.get(params?.[0]);
                return { rows: row ? [row] : [] };
              }
              if (sql.includes('FROM finance.treasury_wallet_sequences')) {
                const addr = params?.[0];
                const row = dbSequences.get(addr);
                return { rows: row ? [row] : [] };
              }
              if (sql.includes('INSERT INTO finance.treasury_wallet_sequences')) {
                const addr = params?.[0];
                if (!dbSequences.has(addr)) {
                  dbSequences.set(addr, {
                    current_onchain_seqno: params?.[1],
                    next_allocated_seqno: params?.[1],
                    confirmed_seqno: params?.[1],
                  });
                }
                return { rowCount: 1 };
              }
              if (sql.includes('UPDATE finance.treasury_wallet_sequences')) {
                const addr = params?.[0];
                const allocated = params?.[1];
                const row = dbSequences.get(addr);
                if (row) row.next_allocated_seqno = allocated + 1;
                return { rowCount: 1 };
              }
              if (sql.includes('INSERT INTO finance.payout_seqno_allocations')) {
                const payoutId = params?.[1];
                dbAllocations.set(payoutId, {
                  allocated_seqno: params?.[3],
                  status: params?.[4],
                });
                return { rowCount: 1 };
              }
              return { rows: [] };
            },
          };
          return fn(tx);
        },
        query: async () => {
          return { rows: [] };
        },
      };

      const wallet = 'EQD__________________________________________0vo';
      // First allocation starts at on-chain seqno N = 10
      const seq1 = await TonSeqnoManager.allocate(mockDb, wallet, 'payout-1', 10);
      const seq2 = await TonSeqnoManager.allocate(mockDb, wallet, 'payout-2', 10);
      const seq3 = await TonSeqnoManager.allocate(mockDb, wallet, 'payout-3', 10);

      expect(seq1).toBe(10);
      expect(seq2).toBe(11);
      expect(seq3).toBe(12);

      // Repeated call for payout-1 returns identical allocated seqno (10)
      const seq1Repeat = await TonSeqnoManager.allocate(mockDb, wallet, 'payout-1', 10);
      expect(seq1Repeat).toBe(10);
    });
  });

  describe('AwsKmsEd25519Signer', () => {
    const mockKmsClient = {
      sign: async (params: { KeyId: string; Message: Uint8Array; SigningAlgorithm: string }) => {
        if (params.SigningAlgorithm !== 'ED25519_SHA_512') {
          throw new Error(`Invalid KMS algorithm: ${params.SigningAlgorithm}`);
        }
        return {
          Signature: new Uint8Array(64).fill(0xab),
          KeyId: params.KeyId,
          SigningAlgorithm: params.SigningAlgorithm,
        };
      },
    };

    it('signs canonical TON payload with official AWS algorithm ED25519_SHA_512', async () => {
      const signer = new AwsKmsEd25519Signer({
        config: tonConfig,
        keyId: 'arn:aws:kms:us-east-1:123456789012:key/test-ed25519',
        kmsClient: mockKmsClient,
        region: 'us-east-1',
      });

      const signed = await signer.sign(request);
      expect(signed.signer).toBe('AWS_KMS_ED25519');
      expect(signed.signingReference).toMatch(/^ton-boc:/);
      expect(signed.unsignedHash).toBeDefined();
    });

    it('persists and returns identical signature evidence on retry with DB idempotency', async () => {
      const mockDbRecords = new Map<string, any>();
      const mockDb: any = {
        transaction: async (fn: any) => {
          const tx = {
            query: async (sql: string, params?: any[]) => {
              if (sql.includes('SELECT') && sql.includes('finance.payout_seqno_allocations')) {
                return { rows: [{ allocated_seqno: 10, status: 'RESERVED' }] };
              }
              if (sql.includes('SELECT') && sql.includes('system.signing_requests')) {
                const row = mockDbRecords.get(params?.[0]);
                return { rows: row ? [row] : [] };
              }
              if (sql.includes('INSERT INTO system.signing_requests')) {
                const signReqId = params?.[1];
                mockDbRecords.set(signReqId, {
                  status: 'CLAIMED',
                  from_address: params?.[5],
                  destination_address: params?.[6],
                  amount_atomic: params?.[7],
                  seqno: params?.[8],
                  valid_until: params?.[9],
                  unsigned_hash: params?.[10],
                  created_at: new Date(),
                });
                return { rowCount: 1 };
              }
              return { rows: [] };
            },
          };
          return fn(tx);
        },
        query: async (sql: string, params?: any[]) => {
          if (sql.includes('UPDATE system.signing_requests')) {
            const signReqId = params?.[3];
            const row = mockDbRecords.get(signReqId);
            if (row) {
              row.status = 'COMPLETED';
              row.signing_reference = params?.[0];
              row.raw_signature = params?.[1];
              row.signed_at = params?.[2];
            }
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
      };

      const signer = new AwsKmsEd25519Signer({
        config: tonConfig,
        keyId: 'arn:aws:kms:us-east-1:123456789012:key/test-ed25519',
        kmsClient: mockKmsClient,
        db: mockDb,
      });

      const first = await signer.sign(request);
      const second = await signer.sign(request);

      expect(first.signingReference).toBe(second.signingReference);
      expect(first.unsignedHash).toBe(second.unsignedHash);
    });

    it('rejects duplicate signRequestId with mismatched payload', async () => {
      const mockDbRecords = new Map<string, any>();
      mockDbRecords.set(request.signRequestId, {
        status: 'COMPLETED',
        from_address: request.fromAddress,
        destination_address: 'UQ_DIFFERENT_DESTINATION',
        amount_atomic: request.amountAtomic,
        unsigned_hash: 'different_hash_from_another_transaction',
        signing_reference: 'ref-1',
        signed_at: new Date(),
      });

      const mockDb: any = {
        transaction: async (fn: any) => {
          const tx = {
            query: async (sql: string) => {
              if (sql.includes('system.signing_requests')) {
                return { rows: [mockDbRecords.get(request.signRequestId)] };
              }
              return { rows: [] };
            },
          };
          return fn(tx);
        },
        query: async () => {
          return { rows: [] };
        },
      };

      const signer = new AwsKmsEd25519Signer({
        config: tonConfig,
        keyId: 'test-key-id',
        kmsClient: mockKmsClient,
        db: mockDb,
      });

      await expect(signer.sign(request)).rejects.toThrow(/previously registered for a different transaction payload/);
    });

    it('handles KMS transient failures with retryable IntegrationError', async () => {
      const failingKms = {
        sign: async () => {
          throw new Error('KMS service throttled');
        },
      };

      const signer = new AwsKmsEd25519Signer({
        config: tonConfig,
        keyId: 'test-key-id',
        kmsClient: failingKms,
      });

      await expect(signer.sign(request)).rejects.toThrow(/Failed to sign payload via AWS KMS/);
    });
  });

  describe('RateAggregator multi-source consensus & outlier filtering', () => {
    it('calculates median when multiple crypto sources agree within threshold', async () => {
      const sourceA = new StaticCryptoMarketProvider('1.50', { name: 'COINGECKO' });
      const sourceB = new StaticCryptoMarketProvider('1.52', { name: 'COINPAPRIKA' });
      const fxSource = new StaticFxProvider('100000', { name: 'TINDEX' });

      const aggregator = new RateAggregator({
        cryptoSources: [sourceA, sourceB],
        fxSources: [fxSource],
        maxCrossSourceDeviationPercent: 10,
      });

      const quote = await aggregator.getQuote();
      expect(Number.parseFloat(quote.legs?.cryptoUsd.value ?? '0')).toBeCloseTo(1.52, 2);
      expect(quote.source).toContain('COINGECKO+COINPAPRIKA');
    });

    it('rejects quotes when two sources diverge beyond the consensus threshold', async () => {
      const sourceA = new StaticCryptoMarketProvider('1.00', { name: 'COINGECKO' });
      const sourceB = new StaticCryptoMarketProvider('2.00', { name: 'DIVERGENT_SOURCE' });
      const fxSource = new StaticFxProvider('100000', { name: 'TINDEX' });

      const aggregator = new RateAggregator({
        cryptoSources: [sourceA, sourceB],
        fxSources: [fxSource],
        maxCrossSourceDeviationPercent: 10,
      });

      await expect(aggregator.getQuote()).rejects.toThrow(/cross-source divergence/);
    });

    it('filters out an extreme outlier when 3+ sources are available and 2+ agree', async () => {
      const sourceA = new StaticCryptoMarketProvider('1.50', { name: 'SRC_A' });
      const sourceB = new StaticCryptoMarketProvider('1.51', { name: 'SRC_B' });
      const sourceOutlier = new StaticCryptoMarketProvider('5.00', { name: 'SRC_OUTLIER' });
      const fxSource = new StaticFxProvider('100000', { name: 'TINDEX' });

      const aggregator = new RateAggregator({
        cryptoSources: [sourceA, sourceB, sourceOutlier],
        fxSources: [fxSource],
        maxCrossSourceDeviationPercent: 10,
      });

      const quote = await aggregator.getQuote();
      expect(Number.parseFloat(quote.legs?.cryptoUsd.value ?? '0')).toBeLessThan(2.0);
      expect(quote.source).toContain('SRC_A+SRC_B');
      expect(quote.source).not.toContain('SRC_OUTLIER');
    });

    it('rejects when 3 sources are all mutually divergent and no quorum is reached', async () => {
      const sourceA = new StaticCryptoMarketProvider('1.00', { name: 'SRC_A' });
      const sourceB = new StaticCryptoMarketProvider('1.80', { name: 'SRC_B' });
      const sourceC = new StaticCryptoMarketProvider('3.00', { name: 'SRC_C' });
      const fxSource = new StaticFxProvider('100000', { name: 'TINDEX' });

      const aggregator = new RateAggregator({
        cryptoSources: [sourceA, sourceB, sourceC],
        fxSources: [fxSource],
        maxCrossSourceDeviationPercent: 10,
      });

      await expect(aggregator.getQuote()).rejects.toThrow(/fewer than 2 independent sources reached consensus/);
    });
  });
});

describe('rate limiting (SPEC 253)', () => {
  it('allows the sustained rate and refuses the excess', () => {
    let clock = 0;
    const limiter = new TokenBucketRateLimiter({ now: () => clock });
    const rule = { limit: 5, windowSeconds: 60 };

    for (let i = 0; i < 5; i++) {
      expect(limiter.check('caller', rule).allowed).toBe(true);
    }
    const blocked = limiter.check('caller', rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills continuously instead of resetting on a window edge', () => {
    let clock = 0;
    const limiter = new TokenBucketRateLimiter({ now: () => clock });
    const rule = { limit: 60, windowSeconds: 60 };

    for (let i = 0; i < 60; i++) limiter.check('caller', rule);
    expect(limiter.check('caller', rule).allowed).toBe(false);

    clock += 1000;
    expect(limiter.check('caller', rule).allowed).toBe(true);
    expect(limiter.check('caller', rule).allowed).toBe(false);
  });

  it('keeps callers independent of one another', () => {
    let clock = 0;
    const limiter = new TokenBucketRateLimiter({ now: () => clock });
    const rule = { limit: 2, windowSeconds: 60 };

    limiter.check('a', rule);
    limiter.check('a', rule);
    expect(limiter.check('a', rule).allowed).toBe(false);
    expect(limiter.check('b', rule).allowed).toBe(true);
  });

  it('gives credential issuance the tightest budget', () => {
    expect(ruleFor('POST', '/v1/api-keys').name).toBe('SENSITIVE');
    expect(ruleFor('POST', '/v1/wallets').name).toBe('SENSITIVE');
    expect(ruleFor('GET', '/v1/wallets').name).toBe('MERCHANT');
  });

  it('separates writes from reads, and provider callbacks from both', () => {
    expect(ruleFor('POST', '/v1/invoices').name).toBe('MERCHANT_WRITE');
    expect(ruleFor('GET', '/v1/invoices').name).toBe('MERCHANT');
    expect(ruleFor('POST', '/v1/webhooks/cubepay').name).toBe('WEBHOOK');
    expect(ruleFor('GET', '/health/live').name).toBe('PUBLIC');
  });
});

describe('distributed rate limiting', () => {
  function fakeRedis() {
    const store = new Map<string, { tokens: number; ts: number }>();
    let failing = false;
    return {
      setFailing(v: boolean) {
        failing = v;
      },
      async eval(_script: string, keys: string[], args: string[]): Promise<unknown> {
        if (failing) throw new Error('redis unreachable');
        const key = keys[0] as string;
        const [capacity, refillPerMs, now] = args.map(Number) as [number, number, number];

        const state = store.get(key) ?? { tokens: capacity, ts: now };
        const elapsed = Math.max(0, now - state.ts);
        let tokens = Math.min(capacity, state.tokens + elapsed * refillPerMs);

        let allowed = 0;
        if (tokens >= 1) {
          tokens -= 1;
          allowed = 1;
        }
        store.set(key, { tokens, ts: now });
        return [allowed, Math.floor(tokens)];
      },
    };
  }

  it('shares one budget across instances instead of multiplying it', async () => {
    const redis = fakeRedis();
    let clock = 0;
    const rule = { limit: 5, windowSeconds: 60 };
    const a = new RedisRateLimiter({ redis, now: () => clock });
    const b = new RedisRateLimiter({ redis, now: () => clock });

    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const limiter = i % 2 === 0 ? a : b;
      results.push((await limiter.check('merchant-1', rule)).allowed);
    }

    expect(results.filter(Boolean)).toHaveLength(5);
    expect(results[5]).toBe(false);
  });

  it('refills over time, not on a window edge', async () => {
    const redis = fakeRedis();
    let clock = 0;
    const limiter = new RedisRateLimiter({ redis, now: () => clock });
    const rule = { limit: 60, windowSeconds: 60 };

    for (let i = 0; i < 60; i++) await limiter.check('caller', rule);
    expect((await limiter.check('caller', rule)).allowed).toBe(false);

    clock += 1000;
    expect((await limiter.check('caller', rule)).allowed).toBe(true);
    expect((await limiter.check('caller', rule)).allowed).toBe(false);
  });

  it('keeps serving traffic when Redis is down', async () => {
    const redis = fakeRedis();
    const limiter = new RedisRateLimiter({ redis, now: () => 0 });
    redis.setFailing(true);

    const decision = await limiter.check('caller', { limit: 1, windowSeconds: 60 });
    expect(decision.allowed).toBe(true);
  });

  it('can be configured to fail closed instead', async () => {
    const redis = fakeRedis();
    const limiter = new RedisRateLimiter({ redis, now: () => 0, failOpen: false });
    redis.setFailing(true);

    const decision = await limiter.check('caller', { limit: 1, windowSeconds: 60 });
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });
});
