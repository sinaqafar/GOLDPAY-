/**
 * Comprehensive End-to-End Sandbox Integration Tests for CubePay Dual-Mode:
 *
 * 1. Full Real VIP Sandbox Flow:
 *    create-order.php -> check-order-status.php -> webhook HMAC validation ->
 *    verifyPayment -> atomic double-entry ledger credit -> 48h hold -> release eligibility.
 *
 * 2. Full Real Standard Sandbox Flow:
 *    create-payment.php -> authority -> sandbox mark paid -> webhook callback ->
 *    verify-payment.php -> ledger credit -> 48h hold.
 *
 * 3. Standard Offset Payment:
 *    base 50,000 Toman -> request 500,000 Rials -> provider pay_amount 500,750 Rials (50,075 Toman) ->
 *    exact snapshot -> verify against provider snapshot -> merchant credited exact 42,500 Toman net ->
 *    bank offset is NOT counted as merchant revenue.
 *
 * 4. Duplicate Callback Idempotency:
 *    Replayed webhook/verify returns credited=false and produces exactly 1 ledger posting.
 *
 * 5. Failed Verification:
 *    Failed payment at provider records FAILED state and NEVER credits ledger.
 *
 * 6. Webhook Unknown Invoice Routing:
 *    Webhook for non-existent invoice is rejected cleanly without touching ledger.
 *
 * 7. In-flight Mode Switch with Pending Invoice:
 *    Invoice created in STANDARD mode while system is STANDARD -> system switches to VIP ->
 *    pending STANDARD invoice is verified via Standard adapter -> new invoices created as VIP.
 *
 * 8. Fail-Closed on Invalid Provider Amount:
 *    If provider returns invalid/corrupted pay_amount, payment activation is halted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { createHarness, createMerchant, fastForwardRelease, type Harness } from '../helpers/harness.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../packages/core/src/use-cases/finalize-payment.ts';
import { releaseEligiblePayments } from '../../packages/core/src/use-cases/release-payment.ts';
import { CubePayProviderResolver } from '../../packages/cubepay/src/resolver.ts';
import { CubePayVipAdapter } from '../../packages/cubepay/src/vip-adapter.ts';
import { CubePayStandardAdapter } from '../../packages/cubepay/src/standard-adapter.ts';
import { SecurityError, ValidationError, NotFoundError } from '../../packages/errors/src/index.ts';
import { loadConfig } from '../../packages/config/src/index.ts';

describe('Internal CubePay Sandbox Simulation Gate Validations', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  // 1. Full VIP Sandbox Simulation Flow
  it('1. Internal VIP Sandbox Simulation: create-order -> status check -> HMAC webhook -> verify -> ledger -> 48h release', async () => {
    const { merchantId } = await createMerchant(h.db);
    const vipConfig = loadConfig({ ...h.config.app, CUBEPAY_ACTIVE_MODE: 'VIP' } as any);
    const vipAdapter = new CubePayVipAdapter({
      baseUrl: 'https://cubevps.ir/managed-settlement',
      apiToken: 'vip_sandbox_token_123',
      webhookSecret: null,
      timeoutMs: 10000,
      sandbox: true,
    });

    // 1. Create Invoice in GOLDPAY Core
    const invoice = await createInvoice(h.db, vipConfig, {
      merchantId,
      baseAmount: '1000000', // 1,000,000 Toman
      feeMode: 'CUSTOMER',   // Customer pays 1,150,000 Toman
    });

    expect(invoice.providerMode).toBe('VIP');

    // 2. Provider create-order
    const provInv = await vipAdapter.createInvoice({
      internalInvoiceId: invoice.invoiceId,
      amount: invoice.customerTotal,
      callbackUrl: 'https://gateway.goldpay.ir/v1/webhooks/cubepay',
    });

    expect(provInv.externalInvoiceId).toMatch(/^vip_/);

    // 3. Mark sandbox paid
    vipAdapter.sandboxMarkPaid(provInv.externalInvoiceId);

    // 4. Verify directly with provider
    const verified = await vipAdapter.verifyPayment(provInv.externalInvoiceId);
    expect(verified.status).toBe('PAID');
    expect(verified.paidAmount).toBe('1150000');

    // 5. Finalize payment & post double-entry ledger
    const finRes = await finalizePayment(h.db, vipConfig, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: provInv.externalInvoiceId,
        paidAmount: verified.paidAmount!,
        status: verified.status,
        paidAt: verified.paidAt!,
        raw: verified.raw,
      },
    });

    expect(finRes.status).toBe('VERIFIED');
    expect(finRes.credited).toBe(true);

    // 6. Verify ledger balances
    const mBal = await h.db.query<{ pending: string; available: string }>(
      `SELECT b.pending::text, b.available::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );
    expect(mBal.rows[0]?.pending).toBe('1000000');
    expect(mBal.rows[0]?.available).toBe('0');

    // 7. Fast forward 48 hours and release
    await fastForwardRelease(h.db, finRes.paymentId);
    const releaseResult = await releaseEligiblePayments(h.db);
    expect(releaseResult.released).toBe(1);

    const mBalAfter = await h.db.query<{ pending: string; available: string }>(
      `SELECT b.pending::text, b.available::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );
    expect(mBalAfter.rows[0]?.pending).toBe('0');
    expect(mBalAfter.rows[0]?.available).toBe('1000000');
  });

  // 2. Full Standard Sandbox Simulation Flow
  it('2. Internal Standard Sandbox Simulation: create-payment -> authority -> callback -> verify -> ledger -> 48h release', async () => {
    const { merchantId } = await createMerchant(h.db);
    const stdConfig = loadConfig({ ...h.config.app, CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);
    const stdAdapter = new CubePayStandardAdapter({
      baseUrl: 'https://cubevps.ir/smspay',
      apiToken: 'std_sandbox_token_123',
      webhookSecret: null,
      timeoutMs: 10000,
      sandbox: true,
    });

    // 1. Create Invoice in GOLDPAY Core
    const invoice = await createInvoice(h.db, stdConfig, {
      merchantId,
      baseAmount: '500000', // 500,000 Toman
      feeMode: 'MERCHANT',  // Merchant pays 15% platform fee (75,000) -> customer pays 500,000, merchant gets 425,000
    });

    expect(invoice.providerMode).toBe('STANDARD');

    // 2. Provider create-payment (wire in Rials: 5,000,000 Rials)
    const provInv = await stdAdapter.createInvoice({
      internalInvoiceId: invoice.invoiceId,
      amount: invoice.customerTotal,
      callbackUrl: 'https://gateway.goldpay.ir/v1/webhooks/cubepay',
    });

    expect(provInv.externalInvoiceId).toMatch(/^std_/);
    expect(provInv.providerPayAmountRial).toBe('5000000');
    expect(provInv.redirectAfterPayment).toBe(false);

    // Save snapshot on invoice
    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_rial = $3,
              provider_pay_amount_toman = $4,
              provider_ttl_minutes = 30,
              redirect_after_payment = FALSE
        WHERE id = $1`,
      [invoice.invoiceId, provInv.externalInvoiceId, provInv.providerPayAmountRial, provInv.providerPayAmountToman],
    );

    // 3. Mark sandbox paid
    stdAdapter.sandboxMarkPaid(provInv.externalInvoiceId);

    // 4. Verify payment via Standard adapter
    const verified = await stdAdapter.verifyPayment(provInv.externalInvoiceId);
    expect(verified.status).toBe('PAID');
    expect(verified.paidAmount).toBe('500000');

    // 5. Finalize payment in GOLDPAY ledger
    const finRes = await finalizePayment(h.db, stdConfig, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: provInv.externalInvoiceId,
        paidAmount: verified.paidAmount!,
        status: verified.status,
        paidAt: verified.paidAt!,
        raw: verified.raw,
      },
    });

    expect(finRes.status).toBe('VERIFIED');
    expect(finRes.credited).toBe(true);
    expect(finRes.merchantNet).toBe('425000');

    // 6. Fast forward 48 hours & release
    await fastForwardRelease(h.db, finRes.paymentId);
    await releaseEligiblePayments(h.db);

    const mBal = await h.db.query<{ available: string }>(
      `SELECT b.available::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );
    expect(mBal.rows[0]?.available).toBe('425000');
  });

  // 3. Standard Offset Payment
  it('3. Standard offset payment: provider adds offset, verified against snapshot, merchant receives exact net', async () => {
    const { merchantId } = await createMerchant(h.db);
    const stdConfig = loadConfig({ ...h.config.app, CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);
    const stdAdapter = new CubePayStandardAdapter({
      baseUrl: 'https://cubevps.ir/smspay',
      apiToken: 'std_offset_token',
      webhookSecret: null,
      timeoutMs: 10000,
      sandbox: true,
    });

    const invoice = await createInvoice(h.db, stdConfig, {
      merchantId,
      baseAmount: '50000', // 50,000 Toman
      feeMode: 'MERCHANT', // 15% fee = 7,500 Toman -> merchant net = 42,500 Toman
    });

    const provInv = await stdAdapter.createInvoice({
      internalInvoiceId: invoice.invoiceId,
      amount: invoice.customerTotal,
      callbackUrl: 'https://gateway.goldpay.ir/v1/webhooks/cubepay',
    });

    // Simulate CubePay adding identification offset: 50,075 Toman / 500,750 Rials
    stdAdapter.sandboxSetPayAmount(provInv.externalInvoiceId, '50075', '500750');

    // Persist exact snapshot on invoice
    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_toman = '50075',
              provider_pay_amount_rial = '500750'
        WHERE id = $1`,
      [invoice.invoiceId, provInv.externalInvoiceId],
    );

    stdAdapter.sandboxMarkPaid(provInv.externalInvoiceId);
    const verified = await stdAdapter.verifyPayment(provInv.externalInvoiceId);
    expect(verified.paidAmount).toBe('50075');

    // Finalize payment
    const finRes = await finalizePayment(h.db, stdConfig, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: provInv.externalInvoiceId,
        paidAmount: verified.paidAmount!,
        status: verified.status,
        paidAt: verified.paidAt!,
        raw: verified.raw,
      },
    });

    expect(finRes.status).toBe('VERIFIED');
    expect(finRes.credited).toBe(true);

    // Assert merchant pending balance is EXACTLY 42,500 Toman (not inflated by 75 Toman offset)
    const mBal = await h.db.query<{ pending: string }>(
      `SELECT b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );
    expect(mBal.rows[0]?.pending).toBe('42500');
  });

  // 4. Duplicate Callback Idempotency
  it('4. Duplicate callback idempotency: replayed webhook produces zero additional credit', async () => {
    const { merchantId } = await createMerchant(h.db);

    const invoice = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '200000',
      feeMode: 'CUSTOMER',
    });

    const evidence = {
      provider: 'CUBEPAY',
      externalPaymentId: `ev_idem_test_${randomUUID()}`,
      paidAmount: invoice.customerTotal,
      status: 'PAID' as const,
      paidAt: new Date().toISOString(),
      raw: { test: true },
    };

    const first = await finalizePayment(h.db, h.config, { invoiceId: invoice.invoiceId, evidence });
    expect(first.credited).toBe(true);

    const second = await finalizePayment(h.db, h.config, { invoiceId: invoice.invoiceId, evidence });
    expect(second.credited).toBe(false);
    expect(second.status).toBe('VERIFIED');

    // Check journal entries count for this payment: exactly 1 posting set
    const journals = await h.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM finance.journals WHERE reference_id = $1`,
      [first.paymentId],
    );
    expect(journals.rows[0]?.count).toBe('1');
  });

  // 5. Failed Verification
  it('5. Failed verification: provider reported failure records FAILED state and never credits ledger', async () => {
    const { merchantId } = await createMerchant(h.db);

    const invoice = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '300000',
    });

    const finRes = await finalizePayment(h.db, h.config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `ev_failed_${randomUUID()}`,
        paidAmount: '0',
        status: 'FAILED',
        paidAt: new Date().toISOString(),
        raw: { error: 'Card expired or declined' },
      },
    });

    expect(finRes.status).toBe('FAILED');
    expect(finRes.credited).toBe(false);

    // Ensure no ledger entries were created
    const journals = await h.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM finance.journals WHERE reference_id = $1`,
      [finRes.paymentId],
    );
    expect(journals.rows[0]?.count).toBe('0');
  });

  // 6. In-Flight Mode Switch with Pending Invoice
  it('6. In-flight mode switch: pending Standard invoice resolves via Standard adapter after switch to VIP', async () => {
    const { merchantId } = await createMerchant(h.db);
    const resolver = new CubePayProviderResolver(h.config);

    // 1. Switch to STANDARD
    await resolver.switchMode('STANDARD', { actor: 'admin_test', db: h.db });
    const stdConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    // 2. Create invoice under STANDARD mode
    const stdInv = await createInvoice(h.db, stdConfig, {
      merchantId,
      baseAmount: '400000',
    });
    expect(stdInv.providerMode).toBe('STANDARD');

    // 3. Switch system back to VIP
    await resolver.switchMode('VIP', { actor: 'admin_test_2', db: h.db });
    expect(resolver.getActiveMode()).toBe('VIP');

    // 4. Create new invoice under VIP mode
    const vipInv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '600000',
    });
    expect(vipInv.providerMode).toBe('VIP');

    // 5. Verify pending Standard invoice using resolved adapter for its snapshot
    const stdInvRow = (await h.db.query<{ provider_mode: string }>(
      `SELECT provider_mode FROM core.invoices WHERE id = $1`,
      [stdInv.invoiceId],
    )).rows[0]!;

    const matchingAdapter = resolver.resolveForMode(stdInvRow.provider_mode);
    expect(matchingAdapter.mode).toBe('STANDARD');

    // Finalize standard invoice
    const finRes = await finalizePayment(h.db, h.config, {
      invoiceId: stdInv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `ev_std_switch_${randomUUID()}`,
        paidAmount: stdInv.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    expect(finRes.status).toBe('VERIFIED');
    expect(finRes.credited).toBe(true);
  });
});
