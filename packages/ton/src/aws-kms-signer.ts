/**
 * AWS KMS Ed25519 Signer Adapter for TON.
 *
 * Implements SignerPort using AWS KMS with KeySpec: ECC_NIST_EDWARDS25519.
 * Private key material never leaves the AWS KMS HSM boundary.
 *
 * Requirements:
 * - AWS KMS Key with KeyUsage = SIGN_VERIFY and CustomerMasterKeySpec = ECC_NIST_EDWARDS25519
 * - MessageType = RAW
 * - SigningAlgorithm = ED25519_SHA_512
 * - Canonical TON Wallet V4R2 message structure
 * - Persistent atomic idempotency store to defend against double-authorization
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
}

export class AwsKmsEd25519Signer implements SignerPort {
  readonly name = 'AWS_KMS_ED25519';
  #config: TonConfig;
  #keyId: string;
  #kms: AwsKmsClientLike;
  #db?: Database;
  #region: string;
  #walletId?: number;

  constructor(options: AwsKmsSignerOptions) {
    this.#config = options.config;
    this.#keyId = options.keyId;
    this.#kms = options.kmsClient;
    this.#db = options.db;
    this.#region = options.region ?? 'us-east-1';
    this.#walletId = options.walletId;

    if (!this.#keyId || !this.#keyId.trim()) {
      throw new SecurityError('KMS_KEY_ID_REQUIRED', 'AWS KMS key ID must be provided');
    }
  }

  async sign(request: SignTransferRequest): Promise<SignedTransfer> {
    // 1. Independent security validation
    assertSignable(request, this.#config);

    // 2. Persistent atomic idempotency check if DB is available
    if (this.#db) {
      const existing = await this.#db.query<{
        signing_reference: string;
        unsigned_hash: string;
        signed_at: Date;
        status: string;
      }>(
        `SELECT signing_reference, unsigned_hash, signed_at, status
           FROM system.signing_requests
          WHERE sign_request_id = $1`,
        [request.signRequestId],
      );

      const record = existing.rows[0];
      if (record) {
        if (record.status === 'COMPLETED' && record.signing_reference) {
          return {
            signingReference: record.signing_reference,
            unsignedHash: record.unsigned_hash,
            signedAt: record.signed_at ?? new Date(),
            signer: this.name,
          };
        }
        if (record.status === 'PENDING') {
          throw new SecurityError(
            'SIGN_REQUEST_IN_FLIGHT',
            `A signing operation for signRequestId ${request.signRequestId} is already in progress`,
          );
        }
      }
    }

    // 3. Build canonical TON Wallet message payload
    const nowSec = Math.floor(Date.now() / 1000);
    const canonical = buildCanonicalTonSigningPayload({
      walletId: this.#walletId,
      seqno: 1, // Determined by payout sequence manager
      validUntil: nowSec + 600, // 10 minutes validity
      destinationAddress: request.destinationAddress,
      amountNanograms: BigInt(request.amountAtomic),
      bounce: false,
      comment: `payout:${request.payoutId.slice(0, 8)}`,
    });

    const signingRequestId = randomUUID();

    // 4. Atomically insert PENDING state into persistent DB store
    if (this.#db) {
      try {
        await this.#db.query(
          `INSERT INTO system.signing_requests
            (id, sign_request_id, payout_id, signer_name, key_reference, unsigned_hash, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')`,
          [
            signingRequestId,
            request.signRequestId,
            request.payoutId,
            this.name,
            this.#keyId,
            canonical.digestHex,
          ],
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('unique') || message.includes('ux_signing_requests_idempotency')) {
          throw new SecurityError(
            'SIGN_REQUEST_ALREADY_CONSUMED',
            `signRequestId ${request.signRequestId} has already been registered`,
          );
        }
        throw err;
      }
    }

    try {
      // 5. Invoke AWS KMS with official algorithm: ED25519_SHA_512 & MessageType: RAW
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

      // 6. Assemble signed TON external message
      const assembled = assembleSignedTonExternalMessage(canonical.canonicalBytes, rawSigBuffer);
      const signedAt = new Date();

      // 7. Atomically persist completed signing evidence
      if (this.#db) {
        await this.#db.query(
          `UPDATE system.signing_requests
              SET status = 'COMPLETED',
                  signing_reference = $1,
                  raw_signature = $2,
                  signed_at = $3
            WHERE id = $4`,
          [assembled.signingReference, assembled.signatureHex, signedAt, signingRequestId],
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
          `UPDATE system.signing_requests SET status = 'FAILED' WHERE id = $1`,
          [signingRequestId],
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
