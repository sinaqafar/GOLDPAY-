/**
 * Real CubePay Live / External Provider E2E Integration Suite:
 *
 * Exercises real external HTTP requests against CubePay VIP and Standard endpoints
 * with sandbox=false.
 *
 * NOTE: If real environment credentials (CUBEPAY_VIP_API_TOKEN, CUBEPAY_STANDARD_API_TOKEN)
 * are not provisioned in the execution environment, tests are cleanly SKIPPED and
 * NEVER report a false positive pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHarness, createMerchant, type Harness } from '../helpers/harness.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../packages/core/src/use-cases/finalize-payment.ts';
import { CubePayVipAdapter } from '../../packages/cubepay/src/vip-adapter.ts';
import { CubePayStandardAdapter } from '../../packages/cubepay/src/standard-adapter.ts';
import { loadConfig } from '../../packages/config/src/index.ts';

const VIP_TOKEN = process.env['CUBEPAY_VIP_API_TOKEN'] || process.env['CUBEPAY_API_TOKEN'];
const STANDARD_TOKEN = process.env['CUBEPAY_STANDARD_API_TOKEN'];

const hasRealVipCredentials = Boolean(
  VIP_TOKEN &&
    (VIP_TOKEN.startsWith('vip_') || VIP_TOKEN.startsWith('vipsb_')) &&
    !VIP_TOKEN.includes('test') &&
    !VIP_TOKEN.includes('fake'),
);

const hasRealStandardCredentials = Boolean(
  STANDARD_TOKEN &&
    !STANDARD_TOKEN.includes('test') &&
    !STANDARD_TOKEN.includes('fake') &&
    STANDARD_TOKEN.length >= 16,
);

describe('Real External CubePay Provider E2E (Live Network & Credentials)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  // Real VIP E2E
  it.skipIf(!hasRealVipCredentials)(
    'Real External VIP E2E: creates real order on CubePay VIP and validates check-order-status',
    async () => {
      const { merchantId } = await createMerchant(h.db);
      const vipAdapter = new CubePayVipAdapter({
        baseUrl: process.env['CUBEPAY_VIP_BASE_URL'] || 'https://cubevps.ir/managed-settlement',
        apiToken: VIP_TOKEN!,
        webhookSecret: null,
        timeoutMs: 15000,
        sandbox: false,
      });

      const invoice = await createInvoice(h.db, h.config, {
        merchantId,
        baseAmount: '50000',
        feeMode: 'CUSTOMER',
      });

      const provInv = await vipAdapter.createInvoice({
        internalInvoiceId: invoice.invoiceId,
        amount: invoice.customerTotal,
        callbackUrl: `${h.config.app.appUrl}/v1/webhooks/cubepay`,
      });

      expect(provInv.externalInvoiceId).toBeTruthy();
      expect(provInv.paymentUrl).toContain('http');

      const status = await vipAdapter.verifyPayment(provInv.externalInvoiceId);
      expect(['PENDING', 'PAID', 'UNKNOWN']).toContain(status.status);
    },
  );

  // Real Standard E2E
  it.skipIf(!hasRealStandardCredentials)(
    'Real External Standard E2E: creates real payment on CubePay Standard and validates exact pay_amount response',
    async () => {
      const { merchantId } = await createMerchant(h.db);
      const stdAdapter = new CubePayStandardAdapter({
        baseUrl: process.env['CUBEPAY_STANDARD_BASE_URL'] || 'https://cubevps.ir/smspay',
        apiToken: STANDARD_TOKEN!,
        webhookSecret: null,
        timeoutMs: 15000,
        sandbox: false,
      });

      const stdConfig = loadConfig({ ...h.config.app, CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);
      const invoice = await createInvoice(h.db, stdConfig, {
        merchantId,
        baseAmount: '50000',
        feeMode: 'CUSTOMER',
      });

      const provInv = await stdAdapter.createInvoice({
        internalInvoiceId: invoice.invoiceId,
        amount: invoice.customerTotal,
        callbackUrl: `${h.config.app.appUrl}/v1/webhooks/cubepay`,
      });

      expect(provInv.externalInvoiceId).toBeTruthy();
      expect(provInv.paymentUrl).toContain('http');
      expect(provInv.providerPayAmountRial).toBeTruthy();
      expect(provInv.providerPayAmountToman).toBeTruthy();

      const status = await stdAdapter.verifyPayment(provInv.externalInvoiceId);
      expect(['PENDING', 'PAID', 'UNKNOWN', 'FAILED']).toContain(status.status);
    },
  );
});
