/**
 * CubePay Standard Adapter (Card-to-Card with SMS Forwarder).
 *
 * Implements the official CubePay Standard API specification:
 * Reference: https://github.com/cubepy/cubepay-doc/blob/main/docs/API-REFERENCE.md
 *
 * Key Characteristics:
 * - Base URL: https://cubevps.ir/smspay/
 * - Token: Standard Merchant API Token
 * - Currency / Amounts: Rials on wire (Toman * 10)
 * - Create Payment: POST /api/create-payment.php
 * - Verify Payment: POST /api/verify-payment.php with authority
 * - Webhook notification: POST callback_url with authority & order_id
 */

import { randomUUID } from 'node:crypto';
import type {
  CreateProviderInvoiceRequest,
  ProviderInvoice,
  ProviderPaymentStatus,
  ParsedWebhook,
} from '../../core/src/ports/payment-provider.ts';
import type {
  CubePayProviderPort,
  CubePayStandardCreatePaymentResponse,
  CubePayStandardVerifyPaymentResponse,
} from './types.ts';
import type { CubePayModeConfig } from '../../config/src/index.ts';
import { IntegrationError } from '../../errors/src/index.ts';

interface SandboxRecord {
  authority: string;
  internalInvoiceId: string;
  amountToman: string;
  payAmountRial?: string | null;
  payAmountToman?: string | null;
  orderId?: string | null;
  matchConfidence?: number | null;
  matchFlags?: string[] | null;
  status: 'PAID' | 'FAILED' | 'PENDING';
  paidAt: string | null;
  providerFee?: string | null;
}

export class CubePayStandardAdapter implements CubePayProviderPort {
  readonly name = 'CUBEPAY';
  readonly mode = 'STANDARD' as const;
  readonly version = '2026-09-STANDARD';

  #config: CubePayModeConfig;
  #sandbox = new Map<string, SandboxRecord>();

  constructor(config: CubePayModeConfig) {
    this.#config = config;
  }

  async createInvoice(request: CreateProviderInvoiceRequest): Promise<ProviderInvoice> {
    if (this.#config.sandbox) {
      const authority = `std_${randomUUID().replace(/-/g, '').slice(0, 32)}`;
      const amountRial = (BigInt(request.amount) * 10n).toString();
      this.#sandbox.set(authority, {
        authority,
        internalInvoiceId: request.internalInvoiceId,
        amountToman: request.amount,
        payAmountRial: amountRial,
        payAmountToman: request.amount,
        orderId: request.internalInvoiceId,
        matchConfidence: 100,
        matchFlags: [],
        status: 'PENDING',
        paidAt: null,
      });
      return {
        externalInvoiceId: authority,
        paymentUrl: `${this.#config.baseUrl}/pay.php?authority=${authority}`,
        expiresAt: null,
        providerPayAmountRial: amountRial,
        providerPayAmountToman: request.amount,
        providerTtlMinutes: 30,
        redirectAfterPayment: false,
      };
    }

    // Amount in RIALS (1 Toman = 10 Rials) via pure BigInt integer arithmetic
    const amountRial = (BigInt(request.amount) * 10n).toString();

    const body = JSON.stringify({
      amount: amountRial,
      order_id: request.internalInvoiceId,
      callback_url: request.callbackUrl,
      redirect_after_payment: false, // Recommended for Bot/Telegram integrations
      ttl_minutes: 30,
      description: request.description ?? undefined,
    });

    const res = (await this.#request(
      'POST',
      '/api/create-payment.php',
      body,
    )) as unknown as CubePayStandardCreatePaymentResponse;

    if (!res.success || !res.authority || !res.payment_link) {
      throw new IntegrationError(
        'CUBEPAY_STANDARD_CREATE_PAYMENT_FAILED',
        res.message ?? 'CubePay Standard did not return authority and payment_link',
        { retryable: false, details: res as unknown as Record<string, unknown> },
      );
    }

    // Exact pay_amount validation - STRICTLY NO FALLBACK
    if (
      res.pay_amount === undefined ||
      res.pay_amount === null ||
      res.pay_amount_toman === undefined ||
      res.pay_amount_toman === null
    ) {
      throw new IntegrationError(
        'CUBEPAY_STANDARD_INVALID_RESPONSE',
        'CubePay Standard create response missing required pay_amount or pay_amount_toman',
        { retryable: false, details: res as unknown as Record<string, unknown> },
      );
    }

    let payAmountRial: string;
    let payAmountToman: string;
    try {
      payAmountRial = BigInt(String(res.pay_amount)).toString();
      payAmountToman = BigInt(String(res.pay_amount_toman)).toString();
    } catch {
      throw new IntegrationError(
        'CUBEPAY_STANDARD_INVALID_RESPONSE',
        'CubePay Standard returned non-integer pay_amount or pay_amount_toman',
        { retryable: false, details: res as unknown as Record<string, unknown> },
      );
    }

    if (BigInt(payAmountRial) <= 0n || BigInt(payAmountToman) <= 0n) {
      throw new IntegrationError(
        'CUBEPAY_STANDARD_INVALID_RESPONSE',
        'CubePay Standard returned non-positive pay_amount or pay_amount_toman',
        { retryable: false, details: res as unknown as Record<string, unknown> },
      );
    }

    const expiresAt = res.expires_at ?? (res.expires_in_minutes
      ? new Date(Date.now() + res.expires_in_minutes * 60_000).toISOString()
      : null);

    return {
      externalInvoiceId: res.authority,
      paymentUrl: res.payment_link,
      expiresAt,
      providerPayAmountRial: payAmountRial,
      providerPayAmountToman: payAmountToman,
      providerTtlMinutes: res.expires_in_minutes ?? 30,
      redirectAfterPayment: false,
    };
  }

  async verifyPayment(externalPaymentId: string): Promise<ProviderPaymentStatus> {
    if (this.#config.sandbox) {
      const record = this.#sandbox.get(externalPaymentId);
      if (!record) {
        return {
          externalPaymentId,
          status: 'UNKNOWN',
          paidAmount: null,
          paidAmountRial: null,
          orderId: null,
          matchConfidence: null,
          matchFlags: null,
          providerFeeAmount: null,
          paidAt: null,
          raw: { sandbox: true, found: false },
        };
      }
      return {
        externalPaymentId,
        status: record.status,
        paidAmount: record.status === 'PAID' ? (record.payAmountToman ?? record.amountToman) : null,
        paidAmountRial: record.status === 'PAID' ? (record.payAmountRial ?? `${BigInt(record.amountToman) * 10n}`) : null,
        orderId: record.orderId ?? record.internalInvoiceId,
        matchConfidence: record.matchConfidence ?? 100,
        matchFlags: record.matchFlags ?? [],
        providerFeeAmount: record.status === 'PAID' ? (record.providerFee ?? null) : null,
        paidAt: record.paidAt,
        raw: { sandbox: true, ...record },
      };
    }

    const body = JSON.stringify({ authority: externalPaymentId });
    const res = (await this.#request(
      'POST',
      '/api/verify-payment.php',
      body,
    )) as unknown as CubePayStandardVerifyPaymentResponse;

    const normalizedStatus = normaliseStandardStatus(res.status ?? (res.success ? 'verified' : 'failed'));

    // Preserve exact raw Rial amount without silent division truncation
    let rawAmountRial: string | null = null;
    let paidAmountToman: string | null = null;
    if (res.amount !== undefined && res.amount !== null) {
      try {
        rawAmountRial = BigInt(String(res.amount)).toString();
        paidAmountToman = (BigInt(String(res.amount)) / 10n).toString();
      } catch {
        rawAmountRial = null;
        paidAmountToman = null;
      }
    }

    return {
      externalPaymentId,
      status: normalizedStatus,
      paidAmount: normalizedStatus === 'PAID' ? paidAmountToman : null,
      paidAmountRial: normalizedStatus === 'PAID' ? rawAmountRial : null,
      orderId: typeof res.order_id === 'string' ? res.order_id : null,
      matchConfidence: typeof res.match_confidence === 'number' ? res.match_confidence : null,
      matchFlags: Array.isArray(res.match_flags) ? res.match_flags : null,
      providerFeeAmount: null, // CubePay Standard does not report actual deducted fee in response
      paidAt: res.paid_at ?? (normalizedStatus === 'PAID' ? new Date().toISOString() : null),
      raw: res as unknown as Record<string, unknown>,
    };
  }

  parseWebhook(params: { rawBody: string; headers: Record<string, string | undefined> }): ParsedWebhook {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(params.rawBody) as Record<string, unknown>;
    } catch {
      throw new IntegrationError('CUBEPAY_STANDARD_BAD_JSON', 'Standard webhook body is not valid JSON', {
        retryable: false,
      });
    }

    const authority = typeof body['authority'] === 'string' ? body['authority'] : '';
    const orderId = typeof body['order_id'] === 'string' ? body['order_id'] : '';
    let amountRial: string | null = null;
    let amountToman: string | null = null;
    if (body['amount'] !== undefined && body['amount'] !== null) {
      try {
        amountRial = BigInt(String(body['amount'])).toString();
        amountToman = (BigInt(String(body['amount'])) / 10n).toString();
      } catch {
        amountRial = null;
        amountToman = null;
      }
    }

    return {
      externalEventId: authority || `std_evt_${randomUUID()}`,
      eventType: 'payment.paid',
      internalInvoiceId: orderId || null,
      payment: {
        externalPaymentId: authority,
        status: 'UNKNOWN', // Must be re-verified with verifyPayment(authority)
        paidAmount: amountToman,
        paidAmountRial: amountRial,
        orderId: orderId || null,
        providerFeeAmount: null,
        paidAt: new Date().toISOString(),
        raw: body,
      },
    };
  }

  async #request(method: string, path: string, body: string | null): Promise<Record<string, unknown>> {
    const token = this.#config.apiToken;
    if (!token && !this.#config.sandbox) {
      throw new IntegrationError(
        'CUBEPAY_STANDARD_NOT_CONFIGURED',
        'CUBEPAY_STANDARD_API_TOKEN is not configured',
        { retryable: false },
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const res = await fetch(`${this.#config.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body,
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        throw new IntegrationError('CUBEPAY_STANDARD_HTTP_ERROR', `CubePay Standard returned ${res.status}`, {
          retryable,
          details: { status: res.status, body: text.slice(0, 500) },
        });
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      throw new IntegrationError('CUBEPAY_STANDARD_UNREACHABLE', 'CubePay Standard endpoint unreachable', {
        retryable: true,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- sandbox controls (test/dev only) ----

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

  sandboxSetAmount(externalPaymentId: string, amountToman: string): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.amountToman = amountToman;
    record.payAmountToman = amountToman;
    record.payAmountRial = String(BigInt(amountToman) * 10n);
  }

  sandboxSetPayAmount(externalPaymentId: string, payAmountToman: string, payAmountRial?: string): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.payAmountToman = payAmountToman;
    record.payAmountRial = payAmountRial ?? String(BigInt(payAmountToman) * 10n);
    record.amountToman = payAmountToman;
  }

  sandboxSetOrderId(externalPaymentId: string, orderId: string): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.orderId = orderId;
  }

  sandboxSetMatchEvidence(externalPaymentId: string, matchConfidence: number | null, matchFlags?: string[]): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.matchConfidence = matchConfidence;
    record.matchFlags = matchFlags ?? [];
  }

  sandboxSetProviderFee(externalPaymentId: string, feeToman: string | null): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.providerFee = feeToman;
  }
}

function normaliseStandardStatus(value: unknown): ProviderPaymentStatus['status'] {
  if (typeof value !== 'string') return 'UNKNOWN';
  const v = value.toLowerCase();
  if (['verified', 'paid', 'success'].includes(v)) return 'PAID';
  if (['expired', 'failed', 'canceled', 'cancelled'].includes(v)) return 'FAILED';
  if (['pending', 'processing'].includes(v)) return 'PENDING';
  return 'UNKNOWN';
}
