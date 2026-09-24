/**
 * CubePay package exports & backward-compatible facade.
 */

export * from './types.ts';
export * from './vip-adapter.ts';
export * from './standard-adapter.ts';
export * from './resolver.ts';

import type { ProviderConfig } from '../../config/src/index.ts';
import type {
  PaymentProviderPort,
  CreateProviderInvoiceRequest,
  ProviderInvoice,
  ProviderPaymentStatus,
  ParsedWebhook,
} from '../../core/src/ports/payment-provider.ts';
import { CubePayVipAdapter } from './vip-adapter.ts';
import { CubePayStandardAdapter } from './standard-adapter.ts';

/**
 * Backward-compatible adapter facade that forwards to the active mode adapter.
 */
export class CubePayAdapter implements PaymentProviderPort {
  readonly name = 'CUBEPAY';
  #activeAdapter: PaymentProviderPort;
  #vipAdapter: CubePayVipAdapter;
  #standardAdapter: CubePayStandardAdapter;

  constructor(config: ProviderConfig, windowSeconds = 300) {
    this.#vipAdapter = new CubePayVipAdapter(config.vip ?? config);
    this.#standardAdapter = new CubePayStandardAdapter(config.standard ?? config);
    this.#activeAdapter =
      config.activeMode === 'STANDARD' ? this.#standardAdapter : this.#vipAdapter;
  }

  async createInvoice(request: CreateProviderInvoiceRequest): Promise<ProviderInvoice> {
    return this.#activeAdapter.createInvoice(request);
  }

  async verifyPayment(externalPaymentId: string): Promise<ProviderPaymentStatus> {
    if (externalPaymentId.startsWith('vip_')) {
      return this.#vipAdapter.verifyPayment(externalPaymentId);
    }
    return this.#activeAdapter.verifyPayment(externalPaymentId);
  }

  parseWebhook(params: {
    rawBody: string;
    headers: Record<string, string | undefined>;
  }): ParsedWebhook {
    return this.#activeAdapter.parseWebhook(params);
  }

  // Sandbox helper pass-through
  sandboxMarkPaid(externalPaymentId: string, paidAt = new Date()): void {
    if (externalPaymentId.startsWith('vip_')) {
      this.#vipAdapter.sandboxMarkPaid(externalPaymentId, paidAt);
    } else {
      this.#standardAdapter.sandboxMarkPaid(externalPaymentId, paidAt);
    }
  }

  sandboxMarkFailed(externalPaymentId: string): void {
    if (externalPaymentId.startsWith('vip_')) {
      this.#vipAdapter.sandboxMarkFailed(externalPaymentId);
    } else {
      this.#standardAdapter.sandboxMarkFailed(externalPaymentId);
    }
  }

  sandboxSetAmount(externalPaymentId: string, amount: string): void {
    if (externalPaymentId.startsWith('vip_')) {
      this.#vipAdapter.sandboxSetAmount(externalPaymentId, amount);
    } else {
      this.#standardAdapter.sandboxSetAmount(externalPaymentId, amount);
    }
  }

  sandboxSetProviderFee(externalPaymentId: string, fee: string | null): void {
    if (externalPaymentId.startsWith('vip_')) {
      this.#vipAdapter.sandboxSetProviderFee(externalPaymentId, fee);
    } else {
      this.#standardAdapter.sandboxSetProviderFee(externalPaymentId, fee);
    }
  }
}
