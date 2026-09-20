import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDatabase, type ConcreteDatabase } from '../../packages/database/src/client.ts';
import { migrate } from '../../packages/database/src/migrator.ts';
import { TonSeqnoManager } from '../../packages/ton/src/seqno-manager.ts';
import { AwsKmsEd25519Signer } from '../../packages/ton/src/aws-kms-signer.ts';
import { SecurityError } from '../../packages/errors/src/index.ts';

describe('Real PostgreSQL: TON Seqno & Immutable Signing Intent Invariants', () => {
  let db: ConcreteDatabase;

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

  const mockKms = {
    sign: async (params: { KeyId: string; Message: Uint8Array; SigningAlgorithm: string }) => {
      return {
        Signature: new Uint8Array(64).fill(0xee),
        KeyId: params.KeyId,
        SigningAlgorithm: params.SigningAlgorithm,
      };
    },
  };

  async function createTestPayout(payoutId: string = randomUUID()): Promise<string> {
    const uId = randomUUID();
    const mId = randomUUID();
    const wId = randomUUID();
    const randAddr = `UQ${randomBytes(34).toString('base64url').slice(0, 46)}`;

    await db.query(
      `INSERT INTO core.users (id, status)
       VALUES ($1, 'ACTIVE')`,
      [uId],
    );

    await db.query(
      `INSERT INTO core.merchants (id, user_id, name, status, default_fee_mode)
       VALUES ($1, $2, 'Test Merchant', 'ACTIVE', 'CUSTOMER')`,
      [mId, uId],
    );

    await db.query(
      `INSERT INTO core.wallets (id, merchant_id, address, network, asset, status)
       VALUES ($1, $2, $3, 'TON_TESTNET', 'GRAM', 'ACTIVE')`,
      [wId, mId, randAddr],
    );

    await db.query(
      `INSERT INTO finance.payouts
          (id, merchant_id, wallet_id, amount_toman, rate, rate_source, gram_amount_atomic, status, destination_address, destination_network)
       VALUES ($1, $2, $3, '1000000', '100000', 'TEST_SOURCE', '10000000000', 'RESERVED', $4, 'TON_TESTNET')`,
      [payoutId, mId, wId, randAddr],
    );
    return payoutId;
  }

  beforeAll(async () => {
    db = (await createDatabase({ url: 'pglite:memory' })) as ConcreteDatabase;
    await migrate(db);
  });

  afterAll(async () => {
    await db.close();
  });

  describe('TonSeqnoManager on Real PostgreSQL Engine', () => {
    const wallet = 'EQD_REAL_WALLET_TEST_ADDRESS_________________0vo';

    it('allocates strictly N, N+1, N+2 starting from exact on-chain seqno N', async () => {
      const payout1 = await createTestPayout();
      const payout2 = await createTestPayout();
      const payout3 = await createTestPayout();
      const payout4 = await createTestPayout();

      // On-chain seqno is 10
      const seq1 = await TonSeqnoManager.allocate(db, wallet, payout1, 10);
      const seq2 = await TonSeqnoManager.allocate(db, wallet, payout2, 10);
      const seq3 = await TonSeqnoManager.allocate(db, wallet, payout3, 10);

      expect(seq1).toBe(10);
      expect(seq2).toBe(11);
      expect(seq3).toBe(12);

      // Idempotent re-query for payout1 returns 10
      const repeatSeq1 = await TonSeqnoManager.allocate(db, wallet, payout1, 10);
      expect(repeatSeq1).toBe(10);

      // Next distinct payout receives 13
      const seq4 = await TonSeqnoManager.allocate(db, wallet, payout4, 10);
      expect(seq4).toBe(13);
    });

    it('guarantees unique, monotonic seqno sequence across concurrent worker allocations', async () => {
      const concurrentWallet = 'EQD_CONCURRENT_WALLET_SEQUENCE_TEST__________0vo';
      const initialOnChain = 100;

      const workerPayouts = await Promise.all(
        Array.from({ length: 15 }, () => createTestPayout()),
      );

      const allocations = await Promise.all(
        workerPayouts.map((payoutId) =>
          TonSeqnoManager.allocate(db, concurrentWallet, payoutId, initialOnChain),
        ),
      );

      // Verify no duplicates
      const uniqueSet = new Set(allocations);
      expect(uniqueSet.size).toBe(15);

      // Verify exact range [100 .. 114]
      const sorted = [...allocations].sort((a, b) => a - b);
      expect(sorted[0]).toBe(100);
      expect(sorted[14]).toBe(114);
    });
  });

  describe('Immutable Signing Intent & DB-level Immutability Trigger', () => {
    it('persists immutable intent and produces valid external message BoC with Ed25519 signature', async () => {
      const signer = new AwsKmsEd25519Signer({
        config: tonConfig,
        keyId: 'arn:aws:kms:us-east-1:123456789012:key/test-ed25519',
        kmsClient: mockKms,
        db,
        initialSeqno: 50,
      });

      const payoutId = await createTestPayout();
      const signRequest = {
        signRequestId: `payout:${payoutId}`,
        payoutId,
        asset: 'GRAM',
        network: 'TON_TESTNET',
        destinationAddress: 'UQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAZAm',
        amountAtomic: '5000000000',
        fromAddress: tonConfig.payoutWalletAddress,
      };

      const result1 = await signer.sign(signRequest);
      expect(result1.signingReference).toMatch(/^ton-boc:/);
      expect(result1.unsignedHash).toBeDefined();
      expect(result1.bocBase64).toBeDefined();

      // Idempotent retry returns identical signing reference and hashes
      const result2 = await signer.sign(signRequest);
      expect(result2.signingReference).toBe(result1.signingReference);
      expect(result2.unsignedHash).toBe(result1.unsignedHash);
      expect(result2.bocBase64).toBe(result1.bocBase64);
    });

    it('rejects duplicate signRequestId if destination or amount is altered (intent mismatch)', async () => {
      const signer = new AwsKmsEd25519Signer({
        config: tonConfig,
        keyId: 'arn:aws:kms:us-east-1:123456789012:key/test-ed25519',
        kmsClient: mockKms,
        db,
        initialSeqno: 50,
      });

      const payoutId = await createTestPayout();
      const originalRequest = {
        signRequestId: `payout:${payoutId}`,
        payoutId,
        asset: 'GRAM',
        network: 'TON_TESTNET',
        destinationAddress: 'UQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAZAm',
        amountAtomic: '1000000000',
        fromAddress: tonConfig.payoutWalletAddress,
      };

      await signer.sign(originalRequest);

      // Attempt to sign with different amount
      await expect(
        signer.sign({
          ...originalRequest,
          amountAtomic: '9999999999',
        }),
      ).rejects.toThrow(SecurityError);

      // Attempt to sign with different valid destination
      await expect(
        signer.sign({
          ...originalRequest,
          destinationAddress: 'EQD__________________________________________0vo',
        }),
      ).rejects.toThrow(SecurityError);
    });

    it('database trigger prevents direct SQL mutation of immutable signing intent columns', async () => {
      const payoutId = await createTestPayout();
      const signReqId = `payout:${payoutId}`;
      const signer = new AwsKmsEd25519Signer({
        config: tonConfig,
        keyId: 'arn:aws:kms:us-east-1:123456789012:key/test-ed25519',
        kmsClient: mockKms,
        db,
        initialSeqno: 70,
      });

      await signer.sign({
        signRequestId: signReqId,
        payoutId,
        asset: 'GRAM',
        network: 'TON_TESTNET',
        destinationAddress: 'UQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAZAm',
        amountAtomic: '3000000000',
        fromAddress: tonConfig.payoutWalletAddress,
      });

      // Attempt manual SQL UPDATE to mutate destination address
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET destination_address = 'UQ_TAMPERED_ADDRESS'
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);

      // Attempt manual SQL UPDATE to mutate amount_atomic
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET amount_atomic = '9999999999'
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);
    });
  });
});
