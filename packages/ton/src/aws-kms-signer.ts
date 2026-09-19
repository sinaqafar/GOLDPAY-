/**
 * AWS KMS Ed25519 Signer Adapter for TON.
 *
 * Implements SignerPort using AWS KMS with KeySpec: ECC_NIST_EDWARDS25519.
 * Private key material never leaves the AWS KMS HSM boundary.
 *
 * Features:
 * - Official AWS KMS algorithm: ED25519_SHA_512 with MessageType = RAW
 * - Canonical TON Wallet V4R2 TL-B Cell representation hashing
 * - Persistent DB-backed signing idempotency bound to canonical payload hash
 * - Real atomic seqno allocation via TonSeqnoManager
 * - Crash recovery and lease timeout defense
 */

import { randomUUID } from 'node:crypto';
import type {
  SignerPort,
  SignTransferRequest,
  SignedTransfer,
} from '../../core/src/ports/signer.ts';
import { SecurityError, IntegrationError } from '../../errors/src/index.ts';
import type { TonConfig } from '../../config/src/index.ts';
import type { Database } from '../../database/src/client.ts';
import { assertSignable } from './signer.ts';
import {
  buildCanonicalTonSigningPayload,
  assembleSignedTonExternalMessage,
} from './ton-wallet-message.ts';
import { TonSeqnoManager } from './seqno-manager.ts';

export interface AwsKmsClientLike {
  sign(params: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: 'RAW' | 'DIGEST';
    SigningAlgorithm: 'ED25519_SHA_512' | string;
    GrantTokens?: string[];
  }): Promise<{
    Signature?: Uint8Array | ArrayBuffer | string;
    KeyId?: string;
    SigningAlgorithm?: string;
  }>;
}

export interface AwsKmsSignerOptions {
  config: TonConfig;
  keyId: string;
  kmsClient: AwsKmsClientLike;
  db?: Database;
  region?: string;
  walletId?: number;
  initialSeqno?: number;
}

export class AwsKmsEd25519Signer implements SignerPort {
  readonly name = 'AWS_KMS_ED25519';
  #config: TonConfig;
  #keyId: string;
  #kms: AwsKmsClientLike;
  #db?: Database;
  #region: string;
  #walletId?: number;
  #initialSeqno: number;

  constructor(options: AwsKmsSignerOptions) {
    this.#config = options.config;
    this.#keyId = options.keyId;
    this.#kms = options.kmsClient;
    this.#db = options.db;
    this.#region = options.region ?? 'us-east-1';
    this.#walletId = options.walletId;
    this.#initialSeqno = options.initialSeqno ?? 0;

    if (!this.#keyId || !this.#keyId.trim()) {
      throw new SecurityError('KMS_KEY_ID_REQUIRED', 'AWS KMS key ID must be provided');
    }
  }

  async sign(request: SignTransferRequest): Promise<SignedTransfer> {
    // 1. Independent security validation of caller inputs
    assertSignable(request, this.#config);

    // 2. Allocate real monotonic seqno
    let seqno = 1;
    if (this.#db && request.fromAddress) {
      seqno = await TonSeqnoManager.allocate(
        this.#db,
        request.fromAddress,
        request.payoutId,
        this.#initialSeqno,
      );
    }

    // 3. Build canonical TON Wallet message payload
    const nowSec = Math.floor(Date.now() / 1000);
    const canonical = buildCanonicalTonSigningPayload({
      walletAddress: request.fromAddress,
      destinationAddress: request.destinationAddress,
      amountNanograms: BigInt(request.amountAtomic),
      seqno,
      validUntil: nowSec + 600,
      walletId: this.#walletId,
      bounce: false,
      comment: `payout:${request.payoutId.slice(0, 8)}`,
    });

    // 4. Persistent atomic idempotency check bound to canonical payload hash
    if (this.#db) {
      const existing = await this.#db.query<{
        id: string;
        signing_reference: string;
        unsigned_hash: string;
        signed_at: Date;
        status: string;
        created_at: Date;
      }>(
        `SELECT id, signing_reference, unsigned_hash, signed_at, status, created_at
           FROM system.signing_requests
          WHERE sign_request_id = $1`,
        [request.signRequestId],
      );

      const record = existing.rows[0];
      if (record) {
        // Enforce payload binding: same ID with different payload is forbidden
        if (record.unsigned_hash !== canonical.digestHex) {
          throw new SecurityError(
            'SIGN_REQUEST_PAYLOAD_MISMATCH',
            `signRequestId ${request.signRequestId} was previously registered for a different transaction payload`,
          );
        }

        if (record.status === 'COMPLETED' && record.signing_reference) {
          return {
            signingReference: record.signing_reference,
            unsignedHash: record.unsigned_hash,
            signedAt: record.signed_at ?? new Date(),
            signer: this.name,
          };
        }

        // Lease check: if PENDING for less than 30s, reject in-flight concurrency
        const ageMs = Date.now() - new Date(record.created_at).getTime();
        if (record.status === 'PENDING' && ageMs < 30_000) {
          throw new SecurityError(
            'SIGN_REQUEST_IN_FLIGHT',
            `A signing operation for signRequestId ${request.signRequestId} is already in progress`,
          );
        }
      }
    }

    const signingRequestId = randomUUID();

    // 5. Register PENDING state into DB
    if (this.#db) {
      await this.#db.query(
        `INSERT INTO system.signing_requests
          (id, sign_request_id, payout_id, signer_name, key_reference, unsigned_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
         ON CONFLICT (sign_request_id) DO UPDATE
            SET status = 'PENDING',
                unsigned_hash = $6,
                created_at = NOW()
          WHERE system.signing_requests.status IN ('PENDING', 'FAILED')`,
        [
          signingRequestId,
          request.signRequestId,
          request.payoutId,
          this.name,
          this.#keyId,
          canonical.digestHex,
        ],
      );
    }

    try {
      // 6. Invoke AWS KMS with official algorithm: ED25519_SHA_512 & MessageType: RAW
      const response = await this.#kms.sign({
        KeyId: this.#keyId,
        Message: canonical.digest,
        MessageType: 'RAW',
        SigningAlgorithm: 'ED25519_SHA_512',
      });

      if (!response.Signature) {
        throw new IntegrationError('KMS_NO_SIGNATURE', 'AWS KMS returned empty signature', {
          retryable: false,
        });
      }

      let rawSigBuffer: Buffer;
      if (typeof response.Signature === 'string') {
        rawSigBuffer = Buffer.from(response.Signature, 'hex');
      } else if (response.Signature instanceof Uint8Array) {
        rawSigBuffer = Buffer.from(response.Signature);
      } else {
        rawSigBuffer = Buffer.from(new Uint8Array(response.Signature as ArrayBuffer));
      }

      // 7. Assemble signed TON external message BoC
      const assembled = assembleSignedTonExternalMessage(canonical, rawSigBuffer);
      const signedAt = new Date();

      // 8. Atomically persist completed signing evidence
      if (this.#db) {
        await this.#db.query(
          `UPDATE system.signing_requests
              SET status = 'COMPLETED',
                  signing_reference = $1,
                  raw_signature = $2,
                  signed_at = $3
            WHERE sign_request_id = $4`,
          [assembled.signingReference, assembled.signatureHex, signedAt, request.signRequestId],
        );
      }

      return {
        signingReference: assembled.signingReference,
        unsignedHash: canonical.digestHex,
        signedAt,
        signer: this.name,
      };
    } catch (err) {
      if (this.#db) {
        await this.#db.query(
          `UPDATE system.signing_requests SET status = 'FAILED' WHERE sign_request_id = $1`,
          [request.signRequestId],
        ).catch(() => undefined);
      }

      if (err instanceof SecurityError || err instanceof IntegrationError) {
        throw err;
      }
      throw new IntegrationError('KMS_SIGN_FAILED', 'Failed to sign payload via AWS KMS Ed25519', {
        retryable: true,
        cause: err,
      });
    }
  }
}
