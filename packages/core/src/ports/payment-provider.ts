/**
 * PaymentProviderPort — SPEC 103780: Payment Core -> PaymentProviderPort -> CubePayAdapter.
 * SPEC 103732: the provider adapter never reaches into the domain core.
 */

export interface CreateProviderInvoiceRequest {
  internalInvoiceId: string;
  /** Amount the customer must pay, in TOMAN atomic units. */
  amount: string;
  description?: string;
  callbackUrl: string;
  returnUrl?: string;
}

export interface ProviderInvoice {
  externalInvoiceId: string;
  paymentUrl: string;
  expiresAt: string | null;
}

export interface ProviderPaymentStatus {
  externalPaymentId: string;
  status: 'PAID' | 'FAILED' | 'PENDING' | 'UNKNOWN';
  paidAmount: string | null;
  paidAt: string | null;
  /**
   * The fee the provider actually deducted, in TOMAN atomic units, when the
   * provider reports it.
   *
   * `null` means "not reported", NOT "zero". CubePay's public API documents
   * payment and query endpoints but no guaranteed field for the deducted fee,
   * so an adapter must leave this null rather than inventing a figure. The
   * configured rate is then only an *expectation* and is recorded as such.
   */
  providerFeeAmount: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedWebhook {
  externalEventId: string | null;
  eventType: string;
  internalInvoiceId: string | null;
  payment: ProviderPaymentStatus | null;
}

export interface PaymentProviderPort {
  readonly name: string;
  createInvoice(request: CreateProviderInvoiceRequest): Promise<ProviderInvoice>;
  /**
   * SPEC 1248: the callback is never trusted on its own — the gateway
   * re-verifies the payment against the provider's own API.
   */
  verifyPayment(externalPaymentId: string): Promise<ProviderPaymentStatus>;
  /** Verify the signature and parse an inbound webhook body. Throws on bad signature. */
  parseWebhook(params: {
    rawBody: string;
    headers: Record<string, string | undefined>;
  }): ParsedWebhook;
}
