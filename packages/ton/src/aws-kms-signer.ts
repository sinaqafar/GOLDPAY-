/**
 * AWS KMS Ed25519 Signer Adapter for TON.
 *
 * Implements SignerPort using AWS KMS with KeySpec: ECC_NIST_EDWARDS25519.
 * Private key material never leaves the AWS KMS HSM boundary.
 *
 * Features:
 * - Official AWS KMS algorithm: ED25519_SHA_512 with MessageType = RAW
 * - Canonical TON Wallet V4R2 TL-B Cell representation hashing
 * - Immutable Signing Intent: binds signRequestId strictly to transaction parameters
 *   (fromAddress, destinationAddress, amountAtomic, seqno, validUntil, unsignedHash).
 * - Preserves exact validUntil and seqno across logical retries, preventing digest drift.
 * - Atomic DB claim with lease expiration to recover from worker crashes.
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
  type CanonicalTonSigningPayload,
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
    // 1. Independent security validation
    assertSignable(request, this.#config);

    let canonical: CanonicalTonSigningPayload;
    let completedResult: SignedTransfer | null = null;

    // 2. Atomic claim and immutable intent lookup / registration
    if (this.#db) {
      const claimOutcome = await this.#db.transaction(async (tx) => {
        const existing = await tx.query<{
          id: string;
          from_address: string;
          destination_address: string;
          amount_atomic: string;
          seqno: number;
          valid_until: number;
          unsigned_hash: string;
          signing_reference: string | null;
          signed_at: Date | null;
          status: string;
          lease_expires_at: Date | null;
        }>(
          `SELECT id, from_address, destination_address, amount_atomic,
                  seqno, valid_until, unsigned_hash, signing_reference, signed_at,
                  status, lease_expires_at
             FROM system.signing_requests
            WHERE sign_request_id = $1
              FOR UPDATE`,
          [request.signRequestId],
        );

        const record = existing.rows[0];
        if (record) {
          // Payload binding check: forbid same signRequestId with different intent
          if (
            (record.from_address && record.from_address !== request.fromAddress) ||
            (record.destination_address && record.destination_address !== request.destinationAddress) ||
            (record.amount_atomic && record.amount_atomic !== request.amountAtomic)
          ) {
            throw new SecurityError(
              'SIGN_REQUEST_PAYLOAD_MISMATCH',
              `signRequestId ${request.signRequestId} was previously registered for a different transaction payload`,
            );
          }

          if (record.status === 'COMPLETED' && record.signing_reference) {
            return {
              type: 'COMPLETED' as const,
              result: {
                signingReference: record.signing_reference,
                unsignedHash: record.unsigned_hash,
                signedAt: record.signed_at ?? new Date(),
                signer: this.name,
              },
            };
          }

          const now = new Date();
          const leaseActive = record.lease_expires_at && new Date(record.lease_expires_at) > now;
          if (record.status === 'CLAIMED' && leaseActive) {
            throw new SecurityError(
              'SIGN_REQUEST_IN_FLIGHT',
              `A signing operation for signRequestId ${request.signRequestId} is already in progress`,
            );
          }

          // Lease expired or retryable failure: reuse existing immutable seqno and valid_until
          await tx.query(
            `UPDATE system.signing_requests
                SET status = 'CLAIMED',
                    lease_expires_at = NOW() + INTERVAL '30 seconds'
              WHERE sign_request_id = $1`,
            [request.signRequestId],
          );

          const reconstructed = buildCanonicalTonSigningPayload({
            walletAddress: request.fromAddress,
            destinationAddress: request.destinationAddress,
            amountNanograms: BigInt(request.amountAtomic),
            seqno: record.seqno,
            validUntil: record.valid_until,
            walletId: this.#walletId,
            bounce: false,
            comment: `payout:${request.payoutId.slice(0, 8)}`,
          });

          return { type: 'CLAIMED' as const, canonical: reconstructed };
        }

        // Fresh sign request: allocate seqno and register immutable intent
        const seqno = await TonSeqnoManager.allocate(
          tx,
          request.fromAddress,
          request.payoutId,
          this.#initialSeqno,
        );
        const validUntil = Math.floor(Date.now() / 1000) + 600;

        const freshCanonical = buildCanonicalTonSigningPayload({
          walletAddress: request.fromAddress,
          destinationAddress: request.destinationAddress,
          amountNanograms: BigInt(request.amountAtomic),
          seqno,
          validUntil,
          walletId: this.#walletId,
          bounce: false,
          comment: `payout:${request.payoutId.slice(0, 8)}`,
        });

        await tx.query(
          `INSERT INTO system.signing_requests
              (id, sign_request_id, payout_id, signer_name, key_reference,
               from_address, destination_address, amount_atomic,
               seqno, valid_until, unsigned_hash, status, lease_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'CLAIMED', NOW() + INTERVAL '30 seconds')`,
          [
            randomUUID(),
            request.signRequestId,
            request.payoutId,
            this.name,
            this.#keyId,
            request.fromAddress,
            request.destinationAddress,
            request.amountAtomic,
            seqno,
            validUntil,
            freshCanonical.digestHex,
          ],
        );

        return { type: 'CLAIMED' as const, canonical: freshCanonical };
      });

      if (claimOutcome.type === 'COMPLETED') {
        return claimOutcome.result;
      }
      canonical = claimOutcome.canonical;
    } else {
      // In-memory mode (tests without database)
      const validUntil = Math.floor(Date.now() / 1000) + 600;
      canonical = buildCanonicalTonSigningPayload({
        walletAddress: request.fromAddress,
        destinationAddress: request.destinationAddress,
        amountNanograms: BigInt(request.amountAtomic),
        seqno: 0,
        validUntil,
        walletId: this.#walletId,
        bounce: false,
        comment: `payout:${request.payoutId.slice(0, 8)}`,
      });
    }

    try {
      // 3. Invoke AWS KMS with official algorithm: ED25519_SHA_512 & MessageType: RAW
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

      // 4. Assemble signed TON external message BoC
      const assembled = assembleSignedTonExternalMessage(canonical, rawSigBuffer);
      const signedAt = new Date();

      // 5. Atomically persist completed signing evidence
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
          `UPDATE system.signing_requests SET status = 'FAILED_RETRYABLE' WHERE sign_request_id = $1`,
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
