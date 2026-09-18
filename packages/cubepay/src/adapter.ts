/**
 * CubePay adapter.
 *
 * SPEC 1248: Verify Signature -> Check Invoice -> Check Amount -> Check Provider
 * Status -> Check Duplicate. The webhook is only a *notification*; the amount
 * and status that reach the ledger always come from `verifyPayment`.
 *
 * In sandbox mode the adapter is deterministic and makes no network calls, so
 * tests and local development never touch a real provider (SPEC 117.92).
 */

import { randomUUID } from 'node:crypto';
import type {
  PaymentProviderPort,
  CreateProviderInvoiceRequest,
  ProviderInvoice,
  ProviderPaymentStatus,
  ParsedWebhook,
} from '../../core/src/ports/payment-provider.ts';
import { verifyWebhookSignature, sha256Hex } from '../../crypto/src/index.ts';
import { IntegrationError, SecurityError, ErrorCodes } from '../../errors/src/index.ts';
import type { ProviderConfig } from '../../config/src/index.ts';

interface SandboxRecord {
  externalPaymentId: string;
  internalInvoiceId: string;
  amount: string;
  status: 'PAID' | 'FAILED' | 'PENDING';
  paidAt: string | null;
}

export class CubePayAdapter implements PaymentProviderPort {
  readonly name = 'CUBEPAY';
  #config: ProviderConfig;
  #windowSeconds: number;
  /** Sandbox-only store, keyed by external payment id. */
  #sandbox = new Map<string, SandboxRecord>();

  constructor(config: ProviderConfig, windowSeconds = 300) {
    this.#config = config;
    this.#windowSeconds = windowSeconds;
  }

  async createInvoice(request: CreateProviderInvoiceRequest): Promise<ProviderInvoice> {
    if (this.#config.sandbox) {
      const externalId = `cp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      this.#sandbox.set(externalId, {
        externalPaymentId: externalId,
        internalInvoiceId: request.internalInvoiceId,
        amount: request.amount,
        status: 'PENDING',
        paidAt: null,
      });
      return {
        externalInvoiceId: externalId,
        paymentUrl: `${this.#config.baseUrl}/sandbox/pay/${externalId}`,
        expiresAt: null,
      };
    }

    const body = JSON.stringify({
      order_id: request.internalInvoiceId,
      amount: request.amount,
      currency: 'IRT',
      description: request.description ?? '',
      callback_url: request.callbackUrl,
      return_url: request.returnUrl,
    });

    const res = await this.#request('POST', '/v1/invoices', body);
    const externalInvoiceId = typeof res['id'] === 'string' ? res['id'] : null;
    const paymentUrl = typeof res['payment_url'] === 'string' ? res['payment_url'] : null;
    if (!externalInvoiceId || !paymentUrl) {
      throw new IntegrationError('CUBEPAY_BAD_RESPONSE', 'provider did not return an invoice id and url', {
        retryable: false,
      });
    }
    return {
      externalInvoiceId,
      paymentUrl,
      expiresAt: typeof res['expires_at'] === 'string' ? res['expires_at'] : null,
    };
  }

  /** Authoritative status check. Never derived from the webhook body. */
  async verifyPayment(externalPaymentId: string): Promise<ProviderPaymentStatus> {
    if (this.#config.sandbox) {
      const record = this.#sandbox.get(externalPaymentId);
      if (!record) {
        return {
          externalPaymentId,
          status: 'UNKNOWN',
          paidAmount: null,
          paidAt: null,
          raw: { sandbox: true, found: false },
        };
      }
      return {
        externalPaymentId,
        status: record.status,
        paidAmount: record.status === 'PAID' ? record.amount : null,
        paidAt: record.paidAt,
        raw: { sandbox: true, ...record },
      };
    }

    const res = await this.#request('GET', `/v1/payments/${encodeURIComponent(externalPaymentId)}`, null);
    return {
      externalPaymentId,
      status: normaliseStatus(res['status']),
      paidAmount: typeof res['paid_amount'] === 'string' ? res['paid_amount'] : null,
      paidAt: typeof res['paid_at'] === 'string' ? res['paid_at'] : null,
      raw: res,
    };
  }

  parseWebhook(params: { rawBody: string; headers: Record<string, string | undefined> }): ParsedWebhook {
    const secret = this.#config.webhookSecret;
    if (!secret) {
      throw new IntegrationError('CUBEPAY_NO_WEBHOOK_SECRET', 'webhook secret is not configured', {
        retryable: false,
      });
    }

    const signature = header(params.headers, 'x-cubepay-signature');
    const timestamp = header(params.headers, 'x-cubepay-timestamp');
    if (!signature || !timestamp) {
      throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'webhook signature headers are missing');
    }

    // Throws on a bad signature or a stale timestamp.
    verifyWebhookSignature({
      secret,
      rawBody: params.rawBody,
      timestamp,
      signature,
      windowSeconds: this.#windowSeconds,
    });

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(params.rawBody) as Record<string, unknown>;
    } catch {
      throw new IntegrationError('CUBEPAY_BAD_JSON', 'webhook body is not valid JSON', {
        retryable: false,
      });
    }

    const externalPaymentId =
      typeof body['payment_id'] === 'string'
        ? body['payment_id']
        : typeof body['id'] === 'string'
          ? body['id']
          : null;

    return {
      externalEventId: typeof body['event_id'] === 'string' ? body['event_id'] : null,
      eventType: typeof body['event'] === 'string' ? body['event'] : 'unknown',
      internalInvoiceId: typeof body['order_id'] === 'string' ? body['order_id'] : null,
      payment: externalPaymentId
        ? {
            externalPaymentId,
            // Deliberately UNKNOWN: the caller must re-verify via the API.
            status: 'UNKNOWN',
            paidAmount: null,
            paidAt: null,
            raw: body,
          }
        : null,
    };
  }

  async #request(method: string, path: string, body: string | null): Promise<Record<string, unknown>> {
    const apiKey = this.#config.apiKey;
    if (!apiKey) {
      throw new IntegrationError('CUBEPAY_NOT_CONFIGURED', 'CUBEPAY_API_KEY is not set', {
        retryable: false,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const res = await fetch(`${this.#config.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'x-request-id': randomUUID(),
          ...(body ? { 'x-body-sha256': sha256Hex(body) } : {}),
        },
        body,
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        // 5xx and 429 are transient; 4xx is a permanent contract problem.
        const retryable = res.status >= 500 || res.status === 429;
        throw new IntegrationError('CUBEPAY_HTTP_ERROR', `provider returned ${res.status}`, {
          retryable,
          details: { status: res.status, body: text.slice(0, 500) },
        });
      }
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new IntegrationError('CUBEPAY_BAD_JSON', 'provider response was not JSON', {
          retryable: false,
        });
      }
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      // A timeout or network failure is indeterminate, so it is retryable.
      throw new IntegrationError('CUBEPAY_UNREACHABLE', 'provider request failed', {
        retryable: true,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- sandbox controls (test/dev only) ----

  /** Simulate a customer completing payment. */
  sandboxMarkPaid(externalPaymentId: string, paidAt = new Date()): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.status = 'PAID';
    record.paidAt = paidAt.toISOString();
  }

  sandboxMarkFailed(externalPaymentId: string): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.status = 'FAILED';
  }

  /** Force an amount different from the invoice, to exercise MISMATCH handling. */
  sandboxSetAmount(externalPaymentId: string, amount: string): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.amount = amount;
  }
}

function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function normaliseStatus(value: unknown): ProviderPaymentStatus['status'] {
  if (typeof value !== 'string') return 'UNKNOWN';
  const v = value.toLowerCase();
  if (['paid', 'success', 'succeeded', 'completed'].includes(v)) return 'PAID';
  if (['failed', 'cancelled', 'canceled', 'expired', 'rejected'].includes(v)) return 'FAILED';
  if (['pending', 'processing', 'created', 'waiting'].includes(v)) return 'PENDING';
  return 'UNKNOWN';
}
