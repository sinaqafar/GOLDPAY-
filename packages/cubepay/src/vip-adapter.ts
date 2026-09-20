/**
 * CubePay VIP Adapter (Managed Settlement).
 *
 * Implements the official CubePay VIP API specification:
 * Reference: https://github.com/cubepy/cubepay-doc/blob/main/docs/CUBEPAY-VIP-API-REFERENCE.md
 *
 * Key Characteristics:
 * - Base URL: https://cubevps.ir/managed-settlement/
 * - Token Prefix: vip_ (production) or vipsb_ (sandbox)
 * - Currency / Amounts: strictly TOMAN
 * - Create Order: POST /api/create-order.php
 * - Status Check: GET /api/check-order-status.php?order_id=... (or invoice_uid)
 * - Webhook HMAC verification: hash_hmac('sha256', order_id + '|paid|' + amount_toman, vip_token)
 */

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreateProviderInvoiceRequest,
  ProviderInvoice,
  ProviderPaymentStatus,
  ParsedWebhook,
} from '../../core/src/ports/payment-provider.ts';
import type { CubePayProviderPort, CubePayVipCreateOrderResponse, CubePayVipCheckStatusResponse } from './types.ts';
import type { CubePayModeConfig } from '../../config/src/index.ts';
import { IntegrationError, SecurityError, ErrorCodes } from '../../errors/src/index.ts';

interface SandboxRecord {
  externalPaymentId: string;
  internalInvoiceId: string;
  amountToman: string;
  status: 'PAID' | 'FAILED' | 'PENDING';
  paidAt: string | null;
  providerFee?: string | null;
}

export class CubePayVipAdapter implements CubePayProviderPort {
  readonly name = 'CUBEPAY';
  readonly mode = 'VIP' as const;
  readonly version = '2026-09-VIP';

  #config: CubePayModeConfig;
  #sandbox = new Map<string, SandboxRecord>();

  constructor(config: CubePayModeConfig) {
    this.#config = config;
  }

  async createInvoice(request: CreateProviderInvoiceRequest): Promise<ProviderInvoice> {
    if (this.#config.sandbox) {
      const invoiceUid = `vip_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      this.#sandbox.set(invoiceUid, {
        externalPaymentId: invoiceUid,
        internalInvoiceId: request.internalInvoiceId,
        amountToman: request.amount,
        status: 'PENDING',
        paidAt: null,
      });
      return {
        externalInvoiceId: invoiceUid,
        paymentUrl: `${this.#config.baseUrl}/pay.php?authority=${invoiceUid}`,
        expiresAt: null,
      };
    }

    const body = JSON.stringify({
      order_id: request.internalInvoiceId,
      amount_toman: Number(request.amount),
      callback_url: request.callbackUrl,
      customer_ref: request.description ?? undefined,
    });

    const res = (await this.#request('POST', '/api/create-order.php', body)) as unknown as CubePayVipCreateOrderResponse;

    if (!res.success || !res.invoice_uid || !res.pay_page_url) {
      throw new IntegrationError(
        'CUBEPAY_VIP_CREATE_ORDER_FAILED',
        res.message ?? 'CubePay VIP did not return invoice_uid and pay_page_url',
        { retryable: false, details: res as unknown as Record<string, unknown> },
      );
    }

    const expiresAt = res.expires_in_minutes
      ? new Date(Date.now() + res.expires_in_minutes * 60_000).toISOString()
      : null;

    return {
      externalInvoiceId: res.invoice_uid,
      paymentUrl: res.pay_page_url,
      expiresAt,
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
          providerFeeAmount: null,
          paidAt: null,
          raw: { sandbox: true, found: false },
        };
      }
      return {
        externalPaymentId,
        status: record.status,
        paidAmount: record.status === 'PAID' ? record.amountToman : null,
        providerFeeAmount: record.status === 'PAID' ? (record.providerFee ?? null) : null,
        paidAt: record.paidAt,
        raw: { sandbox: true, ...record },
      };
    }

    // Check status via GET /api/check-order-status.php
    const query = externalPaymentId.includes('-') || externalPaymentId.startsWith('vip_')
      ? `invoice_uid=${encodeURIComponent(externalPaymentId)}`
      : `order_id=${encodeURIComponent(externalPaymentId)}`;

    const res = (await this.#request(
      'GET',
      `/api/check-order-status.php?${query}`,
      null,
    )) as unknown as CubePayVipCheckStatusResponse;

    const normalizedStatus = normaliseVipStatus(res.status);
    const paidAmount = res.amount_toman !== undefined ? String(res.amount_toman) : null;
    const providerFee = res.fee_toman !== undefined ? String(res.fee_toman) : null;

    return {
      externalPaymentId: res.invoice_uid ?? externalPaymentId,
      status: normalizedStatus,
      paidAmount: normalizedStatus === 'PAID' ? paidAmount : null,
      providerFeeAmount: normalizedStatus === 'PAID' ? providerFee : null,
      paidAt: res.paid_at ?? null,
      raw: res as unknown as Record<string, unknown>,
    };
  }

  parseWebhook(params: { rawBody: string; headers: Record<string, string | undefined> }): ParsedWebhook {
    const token = this.#config.apiToken;
    if (!token) {
      throw new SecurityError(
        ErrorCodes.INVALID_SIGNATURE,
        'CubePay VIP webhook signature cannot be verified: no VIP API token configured',
      );
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(params.rawBody) as Record<string, unknown>;
    } catch {
      throw new IntegrationError('CUBEPAY_VIP_BAD_JSON', 'VIP webhook body is not valid JSON', {
        retryable: false,
      });
    }

    const orderId = typeof body['order_id'] === 'string' ? body['order_id'] : '';
    const invoiceUid = typeof body['invoice_uid'] === 'string' ? body['invoice_uid'] : '';
    const amountToman = body['amount_toman'] ?? body['amount'];
    const sig = typeof body['sig'] === 'string' ? body['sig'] : '';

    if (!orderId || !sig || amountToman === undefined) {
      throw new SecurityError(
        ErrorCodes.INVALID_SIGNATURE,
        'Missing required signature fields in CubePay VIP webhook',
      );
    }

    // Official HMAC verification: hash_hmac('sha256', $orderId . '|paid|' . $amountToman, $vipToken)
    const expectedSig = createHmac('sha256', token)
      .update(`${orderId}|paid|${amountToman}`)
      .digest('hex');

    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');

    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      throw new SecurityError(
        ErrorCodes.INVALID_SIGNATURE,
        'CubePay VIP webhook HMAC signature mismatch',
      );
    }

    return {
      externalEventId: invoiceUid || `vip_evt_${randomUUID()}`,
      eventType: 'payment.paid',
      internalInvoiceId: orderId,
      payment: {
        externalPaymentId: invoiceUid || orderId,
        status: 'UNKNOWN', // Must be re-verified by authoritative endpoint
        paidAmount: String(amountToman),
        providerFeeAmount: null,
        paidAt: new Date().toISOString(),
        raw: body,
      },
    };
  }

  async #request(method: string, path: string, body: string | null): Promise<Record<string, unknown>> {
    const token = this.#config.apiToken;
    if (!token && !this.#config.sandbox) {
      throw new IntegrationError('CUBEPAY_VIP_NOT_CONFIGURED', 'CUBEPAY_VIP_API_TOKEN is not configured', {
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
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body,
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        throw new IntegrationError('CUBEPAY_VIP_HTTP_ERROR', `CubePay VIP returned ${res.status}`, {
          retryable,
          details: { status: res.status, body: text.slice(0, 500) },
        });
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      throw new IntegrationError('CUBEPAY_VIP_UNREACHABLE', 'CubePay VIP endpoint unreachable', {
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
  }

  sandboxSetProviderFee(externalPaymentId: string, feeToman: string | null): void {
    const record = this.#sandbox.get(externalPaymentId);
    if (!record) throw new Error(`unknown sandbox payment ${externalPaymentId}`);
    record.providerFee = feeToman;
  }
}

function normaliseVipStatus(value: unknown): ProviderPaymentStatus['status'] {
  if (typeof value !== 'string') return 'UNKNOWN';
  const v = value.toLowerCase();
  if (v === 'paid') return 'PAID';
  if (['expired', 'canceled', 'cancelled', 'failed'].includes(v)) return 'FAILED';
  if (['pending', 'held_for_review'].includes(v)) return 'PENDING';
  return 'UNKNOWN';
}
