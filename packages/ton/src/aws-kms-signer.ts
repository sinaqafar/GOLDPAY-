/**
 * AWS KMS Ed25519 Signer Adapter for TON.
 *
 * Implements SignerPort using AWS KMS with KeySpec: ECC_ED25519.
 * Private key material never leaves the AWS KMS HSM boundary.
 *
 * Requirements:
 * - AWS KMS Key with KeyUsage = SIGN_VERIFY and CustomerMasterKeySpec = ECC_ED25519
 * - MessageType = RAW
 * - SigningAlgorithm = ED25519_RAW
 */

import { createHash } from 'node:crypto';
import type {
  SignerPort,
  SignTransferRequest,
  SignedTransfer,
} from '../../core/src/ports/signer.ts';
import { SecurityError, IntegrationError } from '../../errors/src/index.ts';
import type { TonConfig } from '../../config/src/index.ts';
import { assertSignable } from './signer.ts';

export interface AwsKmsClientLike {
  sign(params: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: 'RAW' | 'DIGEST';
    SigningAlgorithm: 'ED25519_RAW' | string;
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
  region?: string;
}

export class AwsKmsEd25519Signer implements SignerPort {
  readonly name = 'AWS_KMS_ED25519';
  #config: TonConfig;
  #keyId: string;
  #kms: AwsKmsClientLike;
  #region: string;
  #consumedSignRequests = new Set<string>();

  constructor(options: AwsKmsSignerOptions) {
    this.#config = options.config;
    this.#keyId = options.keyId;
    this.#kms = options.kmsClient;
    this.#region = options.region ?? 'us-east-1';

    if (!this.#keyId || !this.#keyId.trim()) {
      throw new SecurityError('KMS_KEY_ID_REQUIRED', 'AWS KMS key ID must be provided');
    }
  }

  async sign(request: SignTransferRequest): Promise<SignedTransfer> {
    // 1. Independent security validation
    assertSignable(request, this.#config);

    // 2. Idempotency defense against double-signing
    if (this.#consumedSignRequests.has(request.signRequestId)) {
      throw new SecurityError(
        'SIGN_REQUEST_ALREADY_CONSUMED',
        `signRequestId ${request.signRequestId} has already been consumed`,
      );
    }

    // 3. Construct canonical TON transfer message hash
    const canonicalPayload = [
      'TON_GRAM_TRANSFER_V1',
      request.network,
      request.fromAddress,
      request.destinationAddress,
      request.amountAtomic,
      request.signRequestId,
    ].join('\n');

    const digest = createHash('sha256').update(canonicalPayload).digest();
    const digestHex = digest.toString('hex');

    try {
      const response = await this.#kms.sign({
        KeyId: this.#keyId,
        Message: digest,
        MessageType: 'RAW',
        SigningAlgorithm: 'ED25519_RAW',
      });

      if (!response.Signature) {
        throw new IntegrationError('KMS_NO_SIGNATURE', 'AWS KMS returned empty signature', {
          retryable: false,
        });
      }

      this.#consumedSignRequests.add(request.signRequestId);

      let rawSig: string;
      if (typeof response.Signature === 'string') {
        rawSig = response.Signature;
      } else if (response.Signature instanceof Uint8Array) {
        rawSig = Buffer.from(response.Signature).toString('hex');
      } else {
        rawSig = Buffer.from(new Uint8Array(response.Signature as ArrayBuffer)).toString('hex');
      }

      return {
        signingReference: `aws-kms:${this.#region}:${this.#keyId}:${digestHex.slice(0, 16)}:${rawSig.slice(0, 32)}`,
        unsignedHash: digestHex,
        signedAt: new Date(),
        signer: this.name,
      };
    } catch (err) {
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
