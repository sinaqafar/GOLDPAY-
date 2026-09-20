import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { createDatabase, type ConcreteDatabase } from '../../packages/database/src/client.ts';
import { migrate } from '../../packages/database/src/migrator.ts';
import { TonSeqnoManager } from '../../packages/ton/src/seqno-manager.ts';
import { AwsKmsEd25519Signer } from '../../packages/ton/src/aws-kms-signer.ts';
import { SecurityError } from '../../packages/errors/src/index.ts';

describe('Real PostgreSQL Engine: TON Seqno & Immutable Signing Intent Invariants', () => {
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
    signingLeaseSeconds: 30,
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

    it('validates supplied seqno inside confirm() and rejects mismatches with SecurityError', async () => {
      const confirmWallet = 'EQD_CONFIRM_VALIDATION_TEST__________________0vo';
      const payoutId = await createTestPayout();
      const allocated = await TonSeqnoManager.allocate(db, confirmWallet, payoutId, 50);

      expect(allocated).toBe(50);

      // Attempt confirm with mismatched seqno (999 instead of 50)
      await expect(
        TonSeqnoManager.confirm(db, confirmWallet, payoutId, 999),
      ).rejects.toThrow(SecurityError);

      // Attempt confirm with mismatched wallet address
      await expect(
        TonSeqnoManager.confirm(db, 'EQD_WRONG_WALLET_ADDRESS', payoutId, 50),
      ).rejects.toThrow(SecurityError);

      // Legitimate confirm succeeds
      await expect(
        TonSeqnoManager.confirm(db, confirmWallet, payoutId, 50),
      ).resolves.not.toThrow();
    });
  });

  describe('Per-Wallet Ordered Broadcast Gate & Crash Recovery (TON Wallet V4 Invariant)', () => {
    const treasuryWallet = 'EQD_ORDERED_BROADCAST_TREASURY_WALLET________0vo';
    const startSeqno = 200;

    it('enforces strictly ordered broadcast and prevents out-of-order broadcast for 20 concurrent payouts', async () => {
      // 1. Create 20 concurrent payouts
      const payouts = await Promise.all(
        Array.from({ length: 20 }, () => createTestPayout()),
      );

      // 2. Concurrently allocate sequence numbers
      const allocations = await Promise.all(
        payouts.map((payoutId) =>
          TonSeqnoManager.allocate(db, treasuryWallet, payoutId, startSeqno),
        ),
      );

      expect(allocations).toHaveLength(20);
      for (let i = 0; i < 20; i++) {
        expect(allocations[i]).toBe(startSeqno + i);
      }

      // 3. Payout 0 (seqno 200) is allowed to broadcast immediately
      const gate0 = await TonSeqnoManager.canBroadcast(db, treasuryWallet, payouts[0] as string);
      expect(gate0.allowed).toBe(true);
      expect(gate0.seqno).toBe(200);

      // 4. Payout 1 (seqno 201) CANNOT broadcast while Payout 0 is not confirmed
      const gate1Before = await TonSeqnoManager.canBroadcast(db, treasuryWallet, payouts[1] as string);
      expect(gate1Before.allowed).toBe(false);
      expect(gate1Before.reason).toBe('SEQUENCE_STATE_MISMATCH');

      // 5. Payout 0 broadcasts (status = BROADCASTED)
      await TonSeqnoManager.markBroadcasted(db, treasuryWallet, payouts[0] as string);

      // Payout 1 still cannot broadcast (predecessor in flight / unconfirmed)
      const gate1InFlight = await TonSeqnoManager.canBroadcast(db, treasuryWallet, payouts[1] as string);
      expect(gate1InFlight.allowed).toBe(false);

      // 6. Drive all 20 payouts through the sequence gate in strict order
      for (let i = 0; i < 20; i++) {
        const pId = payouts[i] as string;
        const expectedSeqno = startSeqno + i;

        // Current payout must now be allowed to broadcast
        const gate = await TonSeqnoManager.canBroadcast(db, treasuryWallet, pId);
        expect(gate.allowed).toBe(true);
        expect(gate.seqno).toBe(expectedSeqno);

        // Mark broadcasted
        await TonSeqnoManager.markBroadcasted(db, treasuryWallet, pId);

        // Next payout must NOT be allowed to broadcast while this is in flight
        if (i + 1 < 20) {
          const nextGate = await TonSeqnoManager.canBroadcast(db, treasuryWallet, payouts[i + 1] as string);
          expect(nextGate.allowed).toBe(false);
        }

        // Confirm this payout on chain
        await TonSeqnoManager.confirm(db, treasuryWallet, pId, expectedSeqno);
      }

      // Verify wallet on-chain seqno is advanced to 220
      const walletRow = await db.query<{ current_onchain_seqno: number; confirmed_seqno: number }>(
        `SELECT current_onchain_seqno, confirmed_seqno FROM finance.treasury_wallet_sequences WHERE address = $1`,
        [treasuryWallet],
      );
      expect(walletRow.rows[0]?.confirmed_seqno).toBe(219);
      expect(walletRow.rows[0]?.current_onchain_seqno).toBe(220);
    });

    it('recovers safely from crash after broadcast before DB update, unblocking subsequent payouts', async () => {
      const crashWallet = 'EQD_CRASH_RECOVERY_WALLET_TEST_______________0vo';
      const p1 = await createTestPayout();
      const p2 = await createTestPayout();

      // Allocate seqnos 300 and 301
      const s1 = await TonSeqnoManager.allocate(db, crashWallet, p1, 300);
      const s2 = await TonSeqnoManager.allocate(db, crashWallet, p2, 300);
      expect(s1).toBe(300);
      expect(s2).toBe(301);

      // Payout 1 broadcasts to network and lands on chain (on-chain seqno is now 301),
      // but the worker process CRASHES before calling markBroadcasted() or confirm().
      // In DB, p1 remains 'RESERVED'.

      // Payout 2 is blocked from broadcasting
      const gate2Before = await TonSeqnoManager.canBroadcast(db, crashWallet, p2);
      expect(gate2Before.allowed).toBe(false);

      // Reconciler runs on-chain sync (detects on-chain seqno 301)
      const recResult = await TonSeqnoManager.reconcileSequenceGap(
        db,
        crashWallet,
        301,
        async (payoutId, seqno) => {
          // Evidence finder queries chain and confirms p1 landed with seqno 300
          if (payoutId === p1 && seqno === 300) {
            return { confirmed: true, txHash: 'ton-tx-hash-for-300' };
          }
          return { confirmed: false };
        },
      );

      expect(recResult.resolvedCount).toBe(1);

      // Payout 2 is now cleanly unblocked and allowed to broadcast with seqno 301!
      const gate2After = await TonSeqnoManager.canBroadcast(db, crashWallet, p2);
      expect(gate2After.allowed).toBe(true);
      expect(gate2After.seqno).toBe(301);
    });
  });

  describe('Immutable Signing Intent & Tamper-Proof DB Enforcement', () => {
    it('persists full canonical intent and produces valid external message BoC with Ed25519 signature', async () => {
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

    it('database trigger prevents direct SQL mutation of any canonical intent column, including setting to NULL', async () => {
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

      // 1. Attempt manual SQL UPDATE to mutate destination address
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET destination_address = 'UQ_TAMPERED_ADDRESS'
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);

      // 2. Attempt manual SQL UPDATE to mutate amount_atomic
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET amount_atomic = '9999999999'
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);

      // 3. Attempt manual SQL UPDATE to set amount_atomic = NULL (tested with IS DISTINCT FROM)
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET amount_atomic = NULL
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);

      // 4. Attempt manual SQL UPDATE to set intent_hash = NULL
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET intent_hash = NULL
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);

      // 5. Attempt manual SQL UPDATE to mutate network
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET network = 'TON_MAINNET'
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);

      // 6. Attempt manual SQL UPDATE to mutate wallet_id
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET wallet_id = 12345
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);

      // 7. Attempt manual SQL UPDATE to mutate comment
      await expect(
        db.query(
          `UPDATE system.signing_requests
              SET comment = 'tampered-comment'
            WHERE sign_request_id = $1`,
          [signReqId],
        ),
      ).rejects.toThrow(/IMMUTABLE_SIGNING_INTENT_VIOLATION/);
    });
  });
});
