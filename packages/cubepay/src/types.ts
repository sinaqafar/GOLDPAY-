/**
 * CubePay types & interface definitions.
 *
 * Implements official API contracts for both:
 * 1. CubePay VIP (Managed Settlement): CUBEPAY-VIP-API-REFERENCE.md
 * 2. CubePay Standard (Card-to-Card): API-REFERENCE.md
 */

import type {
  PaymentProviderPort,
  CreateProviderInvoiceRequest,
  ProviderInvoice,
  ProviderPaymentStatus,
  ParsedWebhook,
} from '../../core/src/ports/payment-provider.ts';

export type CubePayMode = 'VIP' | 'STANDARD';

export interface CubePayProviderPort extends PaymentProviderPort {
  readonly mode: CubePayMode;
  readonly version: string;
  createInvoice(request: CreateProviderInvoiceRequest): Promise<ProviderInvoice>;
  verifyPayment(externalPaymentId: string): Promise<ProviderPaymentStatus>;
  parseWebhook(params: {
    rawBody: string;
    headers: Record<string, string | undefined>;
  }): ParsedWebhook;
}

// ---------------------------------------------------------------------------
// CubePay VIP Schemas (Official CUBEPAY-VIP-API-REFERENCE.md)
// ---------------------------------------------------------------------------

export interface CubePayVipCreateOrderRequest {
  order_id: string;
  amount_toman: number;
  callback_url?: string;
  customer_ref?: string;
}

export interface CubePayVipCreateOrderResponse {
  success: boolean;
  invoice_uid?: string;
  pay_page_url?: string;
  amount_toman?: number;
  expires_in_minutes?: number;
  message?: string;
}

export interface CubePayVipCheckStatusResponse {
  success: boolean;
  status?: 'pending' | 'paid' | 'expired' | 'canceled' | 'held_for_review';
  order_id?: string;
  invoice_uid?: string;
  amount_toman?: number;
  created_at?: string;
  paid_at?: string;
  fee_toman?: number;
  message?: string;
}

export interface CubePayVipWebhookPayload {
  success: boolean;
  status: string;
  order_id: string;
  invoice_uid: string;
  amount_toman: number;
  amount: number;
  sig: string;
}

// ---------------------------------------------------------------------------
// CubePay Standard Schemas (Official API-REFERENCE.md)
// ---------------------------------------------------------------------------

export interface CubePayStandardCreatePaymentRequest {
  amount: number; // in Rials (Toman * 10)
  order_id: string;
  callback_url: string;
  redirect_after_payment?: boolean;
  ttl_minutes?: number;
  customer_user_id?: string;
  description?: string;
}

export interface CubePayStandardCreatePaymentResponse {
  success: boolean;
  authority?: string;
  payment_link?: string;
  pay_amount?: number;
  pay_amount_toman?: number;
  is_test?: boolean;
  card?: {
    number: string;
    holder: string;
    sheba?: string | null;
  };
  expires_at?: string;
  expires_in_minutes?: number;
  message?: string;
}

export interface CubePayStandardVerifyPaymentRequest {
  authority: string;
}

export interface CubePayStandardVerifyPaymentResponse {
  success: boolean;
  message?: string;
  order_id?: string;
  amount?: number; // in Rials
  status?: string;
  match_confidence?: number;
  match_flags?: string[];
  paid_at?: string;
}

export interface CubePayStandardWebhookPayload {
  success: boolean;
  status: string;
  authority: string;
  order_id: string;
  amount: number; // in Rials
}
