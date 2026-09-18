/**
 * Signer implementations.
 *
 * The only production-acceptable signer is one whose key lives in a KMS or HSM.
 * `StubSigner` exists so development and tests can exercise the full payout
 * pipeline; it refuses to run in production.
 */

import { createHash } from 'node:crypto';
import type {
  SignerPort,
  SignTransferRequest,
  SignedTransfer,
} from '../../core/src/ports/signer.ts';
import { SecurityError, IntegrationError } from '../../errors/src/index.ts';
import type { TonConfig } from '../../config/src/index.ts';

/**
 * Checks every signer must perform regardless of what the caller claims.
 * SPEC 5567 / 7567 — defence in depth: the signer is the last gate before
 * value leaves, so it re-validates rather than trusting its caller.
 */
export function assertSignable(request: SignTransferRequest, config: TonConfig): void {
  if (request.asset !== config.gramAsset) {
    throw new SecurityError('SIGNER_ASSET_MISMATCH', `refusing to sign asset ${request.asset}`);
  }
  if (request.network !== config.network) {
    throw new SecurityError(
      'SIGNER_NETWORK_MISMATCH',
      `refusing to sign for network ${request.network}`,
    );
  }
  if (config.payoutWalletAddress && request.fromAddress !== config.payoutWalletAddress) {
    throw new SecurityError(
      'SIGNER_WALLET_MISMATCH',
      'refusing to sign from an address this signer does not control',
    );
  }
  if (!/^\d+$/.test(request.amountAtomic) || BigInt(request.amountAtomic) <= 0n) {
    throw new SecurityError('SIGNER_INVALID_AMOUNT', 'refusing to sign a non-positive amount');
  }
  if (!request.destinationAddress.trim()) {
    throw new SecurityError('SIGNER_INVALID_DESTINATION', 'refusing to sign without a destination');
  }
}

/**
 * Development signer.
 *
 * Produces a deterministic reference instead of a real signature, so the
 * RESERVED → SIGNED → BROADCASTED pipeline can be exercised end to end without
 * a key anywhere. Fails closed in production.
 */
export class StubSigner implements SignerPort {
  readonly name = 'STUB_SIGNER';
  #config: TonConfig;
  #isProduction: boolean;
  #consumed = new Set<string>();

  constructor(config: TonConfig, options: { isProduction?: boolean } = {}) {
    this.#config = config;
    this.#isProduction = options.isProduction ?? false;
    if (this.#isProduction) {
      throw new SecurityError(
        'STUB_SIGNER_IN_PRODUCTION',
        'the stub signer must never be used in production; configure a KMS/HSM signer',
      );
    }
  }

  async sign(request: SignTransferRequest): Promise<SignedTransfer> {
    assertSignable(request, this.#config);

    // SPEC 5569/5570 — one signature per sign request, ever.
    if (this.#consumed.has(request.signRequestId)) {
      throw new SecurityError(
        'SIGN_REQUEST_ALREADY_CONSUMED',
        'this sign request has already produced a signature',
      );
    }
    this.#consumed.add(request.signRequestId);

    const digest = createHash('sha256')
      .update(
        [
          request.payoutId,
          request.asset,
          request.network,
          request.fromAddress,
          request.destinationAddress,
          request.amountAtomic,
        ].join('|'),
      )
      .digest('hex');

    return {
      signingReference: `stub:${digest.slice(0, 32)}`,
      unsignedHash: digest,
      signedAt: new Date(),
      signer: this.name,
    };
  }
}

/**
 * KMS/HSM signer.
 *
 * Talks to an external signing service over HTTP. The key never leaves that
 * service: this class sends a description of the transfer and receives a
 * reference to the signed payload.
 *
 * The endpoint is expected to enforce its own authorisation policy — being able
 * to reach the signer must not by itself be enough to move money.
 */
export class KmsSigner implements SignerPort {
  readonly name = 'KMS_SIGNER';
  #config: TonConfig;
  #endpoint: string;
  #keyReference: string;
  #timeoutMs: number;
  #apiKey: string | null;

  constructor(options: {
    config: TonConfig;
    endpoint: string;
    keyReference: string;
    timeoutMs?: number;
    apiKey?: string | null;
  }) {
    this.#config = options.config;
    this.#endpoint = options.endpoint;
    this.#keyReference = options.keyReference;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#apiKey = options.apiKey ?? null;
  }

  async sign(request: SignTransferRequest): Promise<SignedTransfer> {
    assertSignable(request, this.#config);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await fetch(`${this.#endpoint}/sign`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify({
          // The signer deduplicates on this, so a network retry cannot yield a
          // second signature.
          sign_request_id: request.signRequestId,
          key_reference: this.#keyReference,
          payout_id: request.payoutId,
          asset: request.asset,
          network: request.network,
          from: request.fromAddress,
          to: request.destinationAddress,
          amount: request.amountAtomic,
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new IntegrationError('SIGNER_HTTP_ERROR', `signer returned ${res.status}`, {
          // 5xx may be transient; a 4xx is a refusal and must not be retried.
          retryable: res.status >= 500,
          details: { status: res.status, body: text.slice(0, 300) },
        });
      }

      const body = JSON.parse(text) as Record<string, unknown>;
      const reference = body['signing_reference'] ?? body['reference'];
      if (typeof reference !== 'string' || !reference) {
        throw new IntegrationError('SIGNER_NO_REFERENCE', 'signer returned no signing reference', {
          retryable: false,
        });
      }

      return {
        signingReference: reference,
        unsignedHash: typeof body['hash'] === 'string' ? body['hash'] : undefined,
        signedAt: new Date(),
        signer: this.name,
      };
    } catch (e) {
      if (e instanceof IntegrationError || e instanceof SecurityError) throw e;
      // An ambiguous signer call is not a definite failure: the signature may
      // exist. Mark it retryable and let the payout pipeline decide.
      throw new IntegrationError('SIGNER_UNREACHABLE', 'could not reach the signer', {
        retryable: true,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
