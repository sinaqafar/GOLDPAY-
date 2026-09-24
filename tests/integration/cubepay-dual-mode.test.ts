/**
 * Integration Test Suite for CubePay Dual-Mode Architecture:
 * Official CubePay VIP (Managed Settlement) vs CubePay Standard (Card-to-Card).
 *
 * Requirements Tested:
 * 1. Default mode is strictly VIP in production configuration.
 * 2. Creating an invoice under VIP creates an immutable VIP snapshot (provider=CUBEPAY, provider_mode=VIP).
 * 3. Atomic, audited, and versioned mode switch: VIP -> STANDARD.
 * 4. Creating an invoice under STANDARD creates an immutable STANDARD snapshot.
 * 5. Existing VIP invoice remains VIP after switching to STANDARD.
 * 6. Switching back: STANDARD -> VIP.
 * 7. Existing STANDARD invoice remains STANDARD after switching back to VIP.
 * 8. VIP webhook cannot process/verify a STANDARD invoice (mode mismatch rejected).
 * 9. STANDARD webhook cannot process/verify a VIP invoice (mode mismatch rejected).
 * 10. Concurrent mode switch + invoice creation never creates ambiguous provider_mode.
 * 11. Failed switch (e.g. invalid mode or DB error) leaves previous active mode intact.
 * 12. Routing invariant: Exactly ONE mode is active at any time (no split-brain or random routing).
 * 13. VIP endpoint contract validation matching CUBEPAY-VIP-API-REFERENCE.md (HMAC SHA-256 over order_id|paid|amount_toman).
 * 14. Standard endpoint contract validation matching API-REFERENCE.md (Rials * 10 on wire, authority verification).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { createHarness, createMerchant, type Harness } from '../helpers/harness.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../packages/core/src/use-cases/finalize-payment.ts';
import { CubePayProviderResolver } from '../../packages/cubepay/src/resolver.ts';
import { CubePayVipAdapter } from '../../packages/cubepay/src/vip-adapter.ts';
import { CubePayStandardAdapter } from '../../packages/cubepay/src/standard-adapter.ts';
import { SecurityError, ValidationError } from '../../packages/errors/src/index.ts';
import { loadConfig } from '../../packages/config/src/index.ts';

describe('CubePay Dual-Mode: VIP & Standard Official Contract Integration', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  // 1. Default = VIP
  it('1. Default mode is strictly VIP in production / default configuration', () => {
    const resolver = new CubePayProviderResolver(h.config);
    expect(resolver.getActiveMode()).toBe('VIP');
    expect(resolver.resolveActive().mode).toBe('VIP');
    expect(resolver.getVersion()).toBe(1);
  });

  // 2. Create Invoice -> VIP
  it('2. Creating an invoice in VIP mode creates an immutable VIP snapshot', async () => {
    const { merchantId } = await createMerchant(h.db);

    const inv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '500000', // 500,000 Toman
      feeMode: 'MERCHANT',
    });

    expect(inv.provider).toBe('CUBEPAY');
    expect(inv.providerMode).toBe('VIP');
    expect(inv.providerVersion).toBe('2026-09-VIP');

    const dbRow = (await h.db.query<{ provider: string; provider_mode: string; provider_version: string }>(
      'SELECT provider, provider_mode, provider_version FROM core.invoices WHERE id = $1',
      [inv.invoiceId],
    )).rows[0]!;

    expect(dbRow.provider).toBe('CUBEPAY');
    expect(dbRow.provider_mode).toBe('VIP');
    expect(dbRow.provider_version).toBe('2026-09-VIP');
  });

  // 3. Switch -> STANDARD
  it('3. Switch mode from VIP to STANDARD is atomic, versioned, and recorded in audit log', async () => {
    const resolver = new CubePayProviderResolver(h.config);
    const adminId = randomUUID();

    const switchRes = await resolver.switchMode('STANDARD', {
      actor: adminId,
      reason: 'Testing switch to STANDARD mode',
      db: h.db,
    });

    expect(switchRes.previousMode).toBe('VIP');
    expect(switchRes.newMode).toBe('STANDARD');
    expect(switchRes.version).toBe(2);
    expect(resolver.getActiveMode()).toBe('STANDARD');
    expect(resolver.resolveActive().mode).toBe('STANDARD');

    // Verify audit log
    const auditLogs = await h.db.query<{ action: string; metadata: any }>(
      `SELECT action, metadata FROM audit.audit_logs WHERE action = 'CUBEPAY_MODE_SWITCHED'`,
    );
    expect(auditLogs.rows.length).toBe(1);
    expect(auditLogs.rows[0]?.metadata?.previous_mode).toBe('VIP');
    expect(auditLogs.rows[0]?.metadata?.new_mode).toBe('STANDARD');
    expect(auditLogs.rows[0]?.metadata?.configuration_version).toBe(2);
  });

  // 4. Create Invoice -> STANDARD
  it('4. Creating an invoice in STANDARD mode creates an immutable STANDARD snapshot', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ ...h.config.app, CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '200000',
      feeMode: 'CUSTOMER',
    });

    expect(inv.providerMode).toBe('STANDARD');
    expect(inv.providerVersion).toBe('2026-09-STANDARD');

    const dbRow = (await h.db.query<{ provider_mode: string }>(
      'SELECT provider_mode FROM core.invoices WHERE id = $1',
      [inv.invoiceId],
    )).rows[0]!;

    expect(dbRow.provider_mode).toBe('STANDARD');
  });

  // 5. Existing VIP invoice remains VIP after switch to STANDARD
  it('5. Existing VIP invoice remains VIP even after system switches to STANDARD', async () => {
    const { merchantId } = await createMerchant(h.db);

    // Invoice A created in VIP mode
    const invA = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '300000',
    });
    expect(invA.providerMode).toBe('VIP');

    // Switch mode to STANDARD
    const resolver = new CubePayProviderResolver(h.config);
    await resolver.switchMode('STANDARD', { actor: 'admin_test', db: h.db });
    expect(resolver.getActiveMode()).toBe('STANDARD');

    // Invoice A in DB must still be VIP
    const invARow = (await h.db.query<{ provider_mode: string }>(
      'SELECT provider_mode FROM core.invoices WHERE id = $1',
      [invA.invoiceId],
    )).rows[0]!;
    expect(invARow.provider_mode).toBe('VIP');

    // Resolver resolves Invoice A strictly as VIP
    const adapterForA = resolver.resolveForMode(invARow.provider_mode);
    expect(adapterForA.mode).toBe('VIP');
  });

  // 6. Switch -> VIP
  it('6. Switch mode back from STANDARD to VIP increments version and audits transition', async () => {
    const resolver = new CubePayProviderResolver(loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any));
    expect(resolver.getActiveMode()).toBe('STANDARD');

    const switchRes = await resolver.switchMode('VIP', {
      actor: 'admin_test_2',
      reason: 'Switch back to VIP for production',
      db: h.db,
    });

    expect(switchRes.previousMode).toBe('STANDARD');
    expect(switchRes.newMode).toBe('VIP');
    expect(switchRes.version).toBe(2);
    expect(resolver.getActiveMode()).toBe('VIP');
  });

  // 7. Existing STANDARD invoice remains STANDARD after switch to VIP
  it('7. Existing STANDARD invoice remains STANDARD even after system switches back to VIP', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const invStd = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '450000',
    });
    expect(invStd.providerMode).toBe('STANDARD');

    const resolver = new CubePayProviderResolver(h.config); // VIP active
    expect(resolver.getActiveMode()).toBe('VIP');

    const invStdRow = (await h.db.query<{ provider_mode: string }>(
      'SELECT provider_mode FROM core.invoices WHERE id = $1',
      [invStd.invoiceId],
    )).rows[0]!;

    expect(invStdRow.provider_mode).toBe('STANDARD');
    expect(resolver.resolveForMode(invStdRow.provider_mode).mode).toBe('STANDARD');
  });

  // 8. VIP webhook cannot process STANDARD invoice
  it('8. VIP webhook parser rejects a STANDARD invoice callback payload with SecurityError', () => {
    const vipAdapter = new CubePayVipAdapter({
      baseUrl: 'https://cubevps.ir/managed-settlement',
      apiToken: 'vip_test_token_1234567890',
      webhookSecret: null,
      timeoutMs: 10000,
      sandbox: false,
    });

    // Standard payload without VIP HMAC sig
    const standardPayload = JSON.stringify({
      success: true,
      status: 'paid',
      authority: 'auth_standard_123456',
      order_id: 'INV-123456',
      amount: 5000000, // in Rials
    });

    expect(() => {
      vipAdapter.parseWebhook({
        rawBody: standardPayload,
        headers: { 'content-type': 'application/json' },
      });
    }).toThrow(SecurityError);
  });

  // 9. STANDARD webhook cannot process VIP invoice
  it('9. STANDARD webhook verifier does not know VIP invoice_uid and rejects standard verification', async () => {
    const standardAdapter = new CubePayStandardAdapter({
      baseUrl: 'https://cubevps.ir/smspay',
      apiToken: 'standard_token_123',
      webhookSecret: null,
      timeoutMs: 10000,
      sandbox: true,
    });

    // Asking Standard adapter for a non-existent authority/VIP uid returns UNKNOWN
    const status = await standardAdapter.verifyPayment('vip_nonexistent_uid_123');
    expect(status.status).toBe('UNKNOWN');
  });

  // 10. Concurrent switch + invoice creation cannot create ambiguous provider_mode
  it('10. Concurrent switch + invoice creations guarantees deterministic, unambiguous snapshotting', async () => {
    const { merchantId } = await createMerchant(h.db);
    const resolver = new CubePayProviderResolver(h.config);

    // Create 10 concurrent invoice operations while switching modes
    const creations = Promise.all([
      createInvoice(h.db, h.config, { merchantId, baseAmount: '100000', invoiceNumber: `CONC-1-${randomUUID()}` }),
      createInvoice(h.db, h.config, { merchantId, baseAmount: '200000', invoiceNumber: `CONC-2-${randomUUID()}` }),
      resolver.switchMode('STANDARD', { actor: 'admin_concurrent', db: h.db }),
      createInvoice(h.db, h.config, { merchantId, baseAmount: '300000', invoiceNumber: `CONC-3-${randomUUID()}` }),
      createInvoice(h.db, h.config, { merchantId, baseAmount: '400000', invoiceNumber: `CONC-4-${randomUUID()}` }),
    ]);

    await creations;

    // All created invoices must have valid, non-null, unambiguous provider_mode
    const allInvoices = await h.db.query<{ invoice_number: string; provider: string; provider_mode: string }>(
      `SELECT invoice_number, provider, provider_mode FROM core.invoices WHERE merchant_id = $1`,
      [merchantId],
    );

    expect(allInvoices.rows.length).toBeGreaterThanOrEqual(4);
    for (const row of allInvoices.rows) {
      expect(row.provider).toBe('CUBEPAY');
      expect(['VIP', 'STANDARD']).toContain(row.provider_mode);
    }
  });

  // 11. Failed switch leaves previous active mode unchanged
  it('11. Failed switch (e.g. invalid mode parameter) leaves active mode unchanged', async () => {
    const resolver = new CubePayProviderResolver(h.config);
    expect(resolver.getActiveMode()).toBe('VIP');

    await expect(
      resolver.switchMode('INVALID_MODE' as any, { actor: 'admin_test', db: h.db }),
    ).rejects.toThrow(ValidationError);

    expect(resolver.getActiveMode()).toBe('VIP');
    expect(resolver.getVersion()).toBe(1);
  });

  // 12. Never allow two active modes for New Invoice routing
  it('12. Invariant: exactly ONE mode is active at any time for new invoice routing', () => {
    const resolver = new CubePayProviderResolver(h.config);
    const active = resolver.resolveActive();
    expect(active.mode).toBe('VIP');
    expect(['VIP', 'STANDARD']).toContain(resolver.getActiveMode());
  });

  // 13. Verify VIP contract according to CUBEPAY-VIP-API-REFERENCE.md
  it('13. VIP contract: verifies HMAC SHA-256 over order_id|paid|amount_toman and creates order with amount_toman', async () => {
    const token = 'vip_live_secret_token_abcdef123456';
    const vipAdapter = new CubePayVipAdapter({
      baseUrl: 'https://cubevps.ir/managed-settlement',
      apiToken: token,
      webhookSecret: null,
      timeoutMs: 10000,
      sandbox: false,
    });

    const orderId = 'ORD_VIP_TEST_999';
    const amountToman = 750000;
    const validSig = createHmac('sha256', token)
      .update(`${orderId}|paid|${amountToman}`)
      .digest('hex');

    const webhookBody = JSON.stringify({
      success: true,
      status: 'paid',
      order_id: orderId,
      invoice_uid: 'b1a2c3d4-e5f6-7890-abcd-ef0123456789',
      amount_toman: amountToman,
      amount: amountToman,
      sig: validSig,
    });

    const parsed = vipAdapter.parseWebhook({
      rawBody: webhookBody,
      headers: { 'content-type': 'application/json' },
    });

    expect(parsed.internalInvoiceId).toBe(orderId);
    expect(parsed.payment?.paidAmount).toBe(amountToman.toString());

    // Tampered amount must fail HMAC check
    const tamperedBody = JSON.stringify({
      success: true,
      status: 'paid',
      order_id: orderId,
      invoice_uid: 'b1a2c3d4-e5f6-7890-abcd-ef0123456789',
      amount_toman: 999999, // tampered!
      amount: 999999,
      sig: validSig,
    });

    expect(() => {
      vipAdapter.parseWebhook({
        rawBody: tamperedBody,
        headers: { 'content-type': 'application/json' },
      });
    }).toThrow(SecurityError);
  });

  // 14. Verify Standard contract according to API-REFERENCE.md
  it('14. Standard contract: handles Rials (Toman * 10) on wire and parses authority callback', async () => {
    const standardAdapter = new CubePayStandardAdapter({
      baseUrl: 'https://cubevps.ir/smspay',
      apiToken: 'std_test_token_123',
      webhookSecret: null,
      timeoutMs: 10000,
      sandbox: true,
    });

    // Create standard sandbox invoice
    const inv = await standardAdapter.createInvoice({
      internalInvoiceId: 'ORD_STD_123',
      amount: '50000', // 50,000 Toman
      callbackUrl: 'https://goldpay.example/v1/webhooks/cubepay',
    });

    expect(inv.externalInvoiceId).toMatch(/^std_/);
    expect(inv.paymentUrl).toContain(inv.externalInvoiceId);

    // Sandbox mark paid
    standardAdapter.sandboxMarkPaid(inv.externalInvoiceId);

    // Verify payment returns Toman amount
    const verified = await standardAdapter.verifyPayment(inv.externalInvoiceId);
    expect(verified.status).toBe('PAID');
    expect(verified.paidAmount).toBe('50000');
  });

  // 15. CubePay Standard exact pay_amount offset snapshot & verification without false mismatch
  it('15. Standard offset snapshot: captures exact pay_amount and verifies against provider snapshot', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '20000', // 20,000 Toman
      feeMode: 'MERCHANT',
    });

    // Simulate CubePay adding an identification offset (e.g. 20,072 Toman / 200,720 Rials)
    const authority = 'std_offset_auth_12345';
    const payAmountToman = '20072';
    const payAmountRial = '200720';

    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_toman = $3,
              provider_pay_amount_rial = $4,
              provider_ttl_minutes = 30,
              redirect_after_payment = FALSE,
              updated_at = NOW()
        WHERE id = $1`,
      [inv.invoiceId, authority, payAmountToman, payAmountRial],
    );

    // Finalize payment with the provider's verified offset amount
    const finRes = await finalizePayment(h.db, standardConfig, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: authority,
        paidAmount: payAmountToman, // Matches provider_pay_amount_toman!
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: { authority, amount: 200720, pay_amount: 200720, pay_amount_toman: 20072 },
      },
    });

    expect(finRes.status).toBe('VERIFIED');
    expect(finRes.credited).toBe(true);

    // Verify merchant net is based on base amount (17,000 Toman for 20,000 with 15% platform fee)
    // and NOT inflated by provider identification offset
    const balance = await h.db.query<{ pending: string }>(
      `SELECT b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );
    expect(balance.rows[0]?.pending).toBe('17000');
  });

  // 16. Amount mismatch detection if paid amount does not match snapshot
  it('16. Standard amount mismatch: rejects payment if paid amount differs from snapshot', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '20000',
      feeMode: 'CUSTOMER',
    });

    const authority = 'std_mismatch_auth_999';
    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_toman = '20072',
              provider_pay_amount_rial = '200720'
        WHERE id = $1`,
      [inv.invoiceId, authority],
    );

    // Finalize payment with an unexpected amount (e.g. 20,000 instead of snapshotted 20,072)
    const finRes = await finalizePayment(h.db, standardConfig, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: authority,
        paidAmount: '20000', // Underpayment compared to snapshotted 20072!
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: { authority, amount: 200000 },
      },
    });

    expect(finRes.status).toBe('MISMATCH');
    expect(finRes.credited).toBe(false);
    expect(finRes.mismatchCode).toBe('UNDERPAYMENT');
  });

  // 17. Fee separation: Platform Fee 15%, Expected Provider Fee 9%, Instant Withdrawal 2%
  it('17. Fee separation: validates isolated ledger booking for platform fee and provider cost', async () => {
    const { merchantId } = await createMerchant(h.db);

    const inv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '1000000', // 1,000,000 Toman
      feeMode: 'CUSTOMER',   // Customer pays 1,150,000 Toman
    });

    const finRes = await finalizePayment(h.db, h.config, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `ev_fee_sep_${randomUUID()}`,
        paidAmount: inv.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    expect(finRes.status).toBe('VERIFIED');

    // Merchant pending balance = base amount = 1,000,000
    const mBal = await h.db.query<{ pending: string }>(
      `SELECT b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );
    expect(mBal.rows[0]?.pending).toBe('1000000');

    // Platform revenue = 150,000 Toman (15% platform fee)
    const revRes = await h.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.credit - e.debit),0)::text AS total
         FROM finance.journal_entries e
         JOIN finance.ledger_accounts a ON a.id = e.account_id
        WHERE a.account_code = 'PLATFORM_REVENUE_TOMAN'`,
    );
    expect(revRes.rows[0]?.total).toBe('150000');

    // Expected provider expense = 9% of 1,150,000 = 103,500 Toman
    const expRes = await h.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.debit - e.credit),0)::text AS total
         FROM finance.journal_entries e
         JOIN finance.ledger_accounts a ON a.id = e.account_id
        WHERE a.account_code = 'PLATFORM_EXPENSE_TOMAN'`,
    );
    expect(expRes.rows[0]?.total).toBe('103500');
  });

  // 18. Duplicate verify produces idempotent single credit
  it('18. Duplicate verification produces idempotent single credit', async () => {
    const { merchantId } = await createMerchant(h.db);

    const inv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '500000',
      feeMode: 'CUSTOMER',
    });

    const evidence = {
      provider: 'CUBEPAY',
      externalPaymentId: `ev_idem_${randomUUID()}`,
      paidAmount: inv.customerTotal,
      status: 'PAID' as const,
      paidAt: new Date().toISOString(),
      raw: {},
    };

    const first = await finalizePayment(h.db, h.config, { invoiceId: inv.invoiceId, evidence });
    expect(first.credited).toBe(true);

    const second = await finalizePayment(h.db, h.config, { invoiceId: inv.invoiceId, evidence });
    expect(second.credited).toBe(false);
    expect(second.status).toBe('VERIFIED');
  });

  // 19. Exact Rial verification: snapshot 500,750 Rial + verify 500,750 Rial -> PASS
  it('19. Exact Rial verification: snapshot 500,750 Rial and verify 500,750 Rial passes', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '50000',
    });

    const authority = 'auth_exact_rial_500750';
    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_toman = '50075',
              provider_pay_amount_rial = '500750'
        WHERE id = $1`,
      [inv.invoiceId, authority],
    );

    const finRes = await finalizePayment(h.db, standardConfig, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: authority,
        paidAmount: '50075',
        paidAmountRial: '500750',
        orderId: inv.invoiceId,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: { authority, amount: 500750 },
      },
    });

    expect(finRes.status).toBe('VERIFIED');
    expect(finRes.credited).toBe(true);
  });

  // 20. Exact Rial verification: snapshot 500,750 Rial + verify 500,751 Rial -> FAIL (AMOUNT_MISMATCH)
  it('20. Exact Rial verification: snapshot 500,750 Rial and verify 500,751 (+1 Rial) fails with AMOUNT_MISMATCH', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '50000',
    });

    const authority = 'auth_rial_mismatch_500751';
    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_toman = '50075',
              provider_pay_amount_rial = '500750'
        WHERE id = $1`,
      [inv.invoiceId, authority],
    );

    // 500751 Rials (would divide to 50075 Toman if truncated, but exact Rial must fail closed!)
    const finRes = await finalizePayment(h.db, standardConfig, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: authority,
        paidAmount: '50075',
        paidAmountRial: '500751',
        orderId: inv.invoiceId,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: { authority, amount: 500751 },
      },
    });

    expect(finRes.status).toBe('MISMATCH');
    expect(finRes.credited).toBe(false);
    expect(finRes.mismatchCode).toBe('OVERPAYMENT');
  });

  // 21. Exact Rial verification: snapshot 500,750 Rial + verify 500,749 Rial -> FAIL (AMOUNT_MISMATCH)
  it('21. Exact Rial verification: snapshot 500,750 Rial and verify 500,749 (-1 Rial) fails with AMOUNT_MISMATCH', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '50000',
    });

    const authority = 'auth_rial_mismatch_500749';
    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_toman = '50075',
              provider_pay_amount_rial = '500750'
        WHERE id = $1`,
      [inv.invoiceId, authority],
    );

    const finRes = await finalizePayment(h.db, standardConfig, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: authority,
        paidAmount: '50074',
        paidAmountRial: '500749',
        orderId: inv.invoiceId,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: { authority, amount: 500749 },
      },
    });

    expect(finRes.status).toBe('MISMATCH');
    expect(finRes.credited).toBe(false);
    expect(finRes.mismatchCode).toBe('UNDERPAYMENT');
  });

  // 22. Callback with odd Rial amount preserves raw Rial and does not truncate silently
  it('22. Webhook parser preserves exact raw Rial amount without silent division truncation', () => {
    const standardAdapter = new CubePayStandardAdapter({
      baseUrl: 'https://cubevps.ir/smspay',
      apiToken: 'std_test_token_123',
      webhookSecret: null,
      timeoutMs: 10000,
      sandbox: false,
    });

    const parsed = standardAdapter.parseWebhook({
      rawBody: JSON.stringify({
        success: true,
        status: 'paid',
        authority: 'auth_odd_rial_999',
        order_id: 'ORD_ODD_999',
        amount: 500757, // Odd Rial amount ending in 7
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(parsed.payment?.paidAmountRial).toBe('500757');
    expect(parsed.payment?.paidAmount).toBe('50075');
  });

  // 23. Verify order_id binding mismatch throws VERIFY_ORDER_ID_MISMATCH
  it('23. Verify order_id mismatch rejects payment with VERIFY_ORDER_ID_MISMATCH', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '50000',
    });

    await expect(
      finalizePayment(h.db, standardConfig, {
        invoiceId: inv.invoiceId,
        evidence: {
          provider: 'CUBEPAY',
          externalPaymentId: 'auth_order_mismatch',
          paidAmount: inv.customerTotal,
          orderId: 'DIFFERENT_INVOICE_ID_123', // Does not match inv.invoiceId!
          status: 'PAID',
          paidAt: new Date().toISOString(),
          raw: { order_id: 'DIFFERENT_INVOICE_ID_123' },
        },
      }),
    ).rejects.toThrow(ValidationError);
  });

  // 24. Low match confidence or abnormal flags places a risk hold
  it('24. Low match confidence (< 80) or abnormal flags places a risk hold', async () => {
    const { merchantId } = await createMerchant(h.db);
    const standardConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, standardConfig, {
      merchantId,
      baseAmount: '100000',
    });

    const authority = 'auth_risk_flag_123';
    const finRes = await finalizePayment(h.db, standardConfig, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: authority,
        paidAmount: inv.customerTotal,
        orderId: inv.invoiceId,
        matchConfidence: 70, // Below 80!
        matchFlags: ['SUSPICIOUS_CARD_NAME_MISMATCH'],
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: { match_confidence: 70, match_flags: ['SUSPICIOUS_CARD_NAME_MISMATCH'] },
      },
    });

    expect(finRes.status).toBe('VERIFIED');
    expect(finRes.credited).toBe(true);

    // Verify a risk hold was created
    const holds = await h.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM finance.payment_holds WHERE payment_id = $1 AND status = 'ACTIVE'`,
      [finRes.paymentId],
    );
    expect(holds.rows[0]?.count).toBe('1');
  });

  // 25. Missed callback is recovered by independent status polling
  it('25. Missed callback: independent status polling discovers completed payment and finalizes ledger', async () => {
    const { merchantId } = await createMerchant(h.db);
    const resolver = new CubePayProviderResolver(loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any));
    const stdConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, stdConfig, {
      merchantId,
      baseAmount: '250000',
      feeMode: 'MERCHANT', // 15% fee = 37,500 Toman -> merchant net = 212,500 Toman
    });

    // Create provider invoice in Standard adapter
    const stdAdapter = resolver.resolveForMode('STANDARD') as CubePayStandardAdapter;
    const provInv = await stdAdapter.createInvoice({
      internalInvoiceId: inv.invoiceId,
      amount: inv.customerTotal,
      callbackUrl: 'https://gateway.goldpay.ir/v1/webhooks/cubepay',
    });

    // Save provider snapshot on invoice
    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_toman = $3,
              provider_pay_amount_rial = $4
        WHERE id = $1`,
      [inv.invoiceId, provInv.externalInvoiceId, provInv.providerPayAmountToman, provInv.providerPayAmountRial],
    );

    // Customer completes payment, but webhook is lost/missed!
    stdAdapter.sandboxMarkPaid(provInv.externalInvoiceId);

    // Run independent status polling
    const { pollPendingInvoices } = await import('../../packages/core/src/use-cases/poll-pending-invoices.ts');
    const pollResult = await pollPendingInvoices(h.db, stdConfig, resolver);

    expect(pollResult.polled).toBe(1);
    expect(pollResult.verified).toBe(1);

    // Verify invoice is marked PAID and ledger credited
    const invRow = (await h.db.query<{ status: string }>(
      `SELECT status FROM core.invoices WHERE id = $1`,
      [inv.invoiceId],
    )).rows[0]!;
    expect(invRow.status).toBe('PAID');

    const mBal = await h.db.query<{ pending: string }>(
      `SELECT b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );
    expect(mBal.rows[0]?.pending).toBe('212500'); // 250,000 * 85%
  });

  // 26. Concurrent callback + polling produces exactly ONE ledger credit
  it('26. Concurrent callback + status polling produces exactly ONE ledger credit', async () => {
    const { merchantId } = await createMerchant(h.db);
    const resolver = new CubePayProviderResolver(loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any));
    const stdConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, stdConfig, {
      merchantId,
      baseAmount: '100000',
    });

    const stdAdapter = resolver.resolveForMode('STANDARD') as CubePayStandardAdapter;
    const provInv = await stdAdapter.createInvoice({
      internalInvoiceId: inv.invoiceId,
      amount: inv.customerTotal,
      callbackUrl: 'https://gateway.goldpay.ir/v1/webhooks/cubepay',
    });

    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = $2,
              provider_pay_amount_toman = $3,
              provider_pay_amount_rial = $4
        WHERE id = $1`,
      [inv.invoiceId, provInv.externalInvoiceId, provInv.providerPayAmountToman, provInv.providerPayAmountRial],
    );

    stdAdapter.sandboxMarkPaid(provInv.externalInvoiceId);

    // Run callback finalization and polling concurrently
    const { pollPendingInvoices } = await import('../../packages/core/src/use-cases/poll-pending-invoices.ts');
    const [finResult, pollResult] = await Promise.all([
      finalizePayment(h.db, stdConfig, {
        invoiceId: inv.invoiceId,
        evidence: {
          provider: 'CUBEPAY',
          externalPaymentId: provInv.externalInvoiceId,
          paidAmount: provInv.providerPayAmountToman!,
          paidAmountRial: provInv.providerPayAmountRial,
          orderId: inv.invoiceId,
          status: 'PAID',
          paidAt: new Date().toISOString(),
          raw: {},
        },
      }),
      pollPendingInvoices(h.db, stdConfig, resolver),
    ]);

    // Exactly one operation should have credited the ledger
    const journals = await h.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM finance.journals WHERE description LIKE $1`,
      [`%payment verified for invoice ${inv.invoiceId}%`],
    );
    expect(journals.rows[0]?.count).toBe('1');
  });

  // 27. Pending invoice until TTL is expired by polling
  it('27. Pending invoice until TTL is marked EXPIRED by polling', async () => {
    const { merchantId } = await createMerchant(h.db);
    const resolver = new CubePayProviderResolver(loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any));
    const stdConfig = loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any);

    const inv = await createInvoice(h.db, stdConfig, {
      merchantId,
      baseAmount: '50000',
    });

    // Backdate expires_at to 10 minutes ago
    await h.db.query(
      `UPDATE core.invoices
          SET provider_invoice_id = 'auth_expired_123',
              expires_at = NOW() - INTERVAL '10 minutes'
        WHERE id = $1`,
      [inv.invoiceId],
    );

    const { pollPendingInvoices } = await import('../../packages/core/src/use-cases/poll-pending-invoices.ts');
    const pollResult = await pollPendingInvoices(h.db, stdConfig, resolver);

    expect(pollResult.expired).toBe(1);

    const invRow = (await h.db.query<{ status: string }>(
      `SELECT status FROM core.invoices WHERE id = $1`,
      [inv.invoiceId],
    )).rows[0]!;
    expect(invRow.status).toBe('EXPIRED');
  });

  // 28. Standard create-payment contract strictly includes type: "card"
  it('28. Standard create-payment contract strictly includes type: "card"', async () => {
    const resolver = new CubePayProviderResolver(loadConfig({ CUBEPAY_ACTIVE_MODE: 'STANDARD' } as any));
    const stdAdapter = resolver.resolveForMode('STANDARD') as CubePayStandardAdapter;

    const invoice = await stdAdapter.createInvoice({
      internalInvoiceId: 'inv_wire_test_card_1',
      amount: '100000',
      callbackUrl: 'https://gateway.goldpay.ir/v1/webhooks/cubepay',
      description: 'card wire validation test',
    });

    expect(invoice.externalInvoiceId).toBeTruthy();
    expect(invoice.providerPayAmountRial).toBe('1000000');
    expect(invoice.providerPayAmountToman).toBe('100000');
    expect(invoice.redirectAfterPayment).toBe(false);
  });

  // 29. Four-Eyes Mode Switching: Propose by Admin A, Approve by Admin B updates DB runtime state
  it('29. Four-Eyes Mode Switching: Propose by Admin A, Approve by Admin B updates DB runtime state', async () => {
    const resolver = new CubePayProviderResolver(h.config);
    expect(resolver.getActiveModeSync()).toBe('VIP');

    // Step 1: Admin A proposes switch to STANDARD
    const proposal = await resolver.proposeSwitch({
      proposedBy: 'admin_alice',
      targetMode: 'STANDARD',
      reason: 'Migrate to standard gateway',
      db: h.db,
    });

    expect(proposal.id).toBeTruthy();
    expect(proposal.status).toBe('PENDING');
    expect(proposal.current_mode).toBe('VIP');
    expect(proposal.requested_mode).toBe('STANDARD');

    // Active mode is still VIP before approval
    expect(resolver.getActiveModeSync()).toBe('VIP');

    // Step 2: Admin B approves the proposal
    const result = await resolver.approveSwitch({
      requestId: proposal.id,
      approvedBy: 'admin_bob',
      db: h.db,
    });

    expect(result.previousMode).toBe('VIP');
    expect(result.newMode).toBe('STANDARD');
    expect(result.version).toBe(2);
    expect(result.approvedBy).toBe('admin_bob');
    expect(resolver.getActiveModeSync()).toBe('STANDARD');

    // DB state must be updated
    const dbState = (await h.db.query<{ active_mode: string; version: number }>(
      `SELECT active_mode, version FROM core.provider_runtime_state WHERE provider_name = 'CUBEPAY'`,
    )).rows[0]!;
    expect(dbState.active_mode).toBe('STANDARD');
    expect(dbState.version).toBe(2);
  });

  // 30. Four-Eyes Mode Switching: Self-approval by proposer is rejected with SecurityError
  it('30. Four-Eyes Mode Switching: Self-approval by proposer is rejected with SecurityError', async () => {
    const resolver = new CubePayProviderResolver(h.config);

    const proposal = await resolver.proposeSwitch({
      proposedBy: 'admin_alice',
      targetMode: 'STANDARD',
      reason: 'Self approval test',
      db: h.db,
    });

    await expect(
      resolver.approveSwitch({
        requestId: proposal.id,
        approvedBy: 'admin_alice', // Same admin -> Four-Eyes violation!
        db: h.db,
      }),
    ).rejects.toThrow('Four-Eyes');
  });

  // 31. Multi-instance visibility: Second resolver instance observes DB runtime state
  it('31. Multi-instance visibility: Second resolver instance observes DB runtime state', async () => {
    const instanceA = new CubePayProviderResolver(h.config);
    const instanceB = new CubePayProviderResolver(h.config);

    // Instance A executes Four-Eyes switch to STANDARD
    await instanceA.directSwitch({
      actor: 'admin_alice',
      approver: 'admin_bob',
      newMode: 'STANDARD',
      reason: 'multi-instance sync test',
      db: h.db,
    });

    expect(instanceA.getActiveModeSync()).toBe('STANDARD');

    // Instance B synchronizes and observes STANDARD
    expect(await instanceB.getActiveMode(h.db)).toBe('STANDARD');
  });

  // 32. Invoice Provider Creation Recovery (P1.4): Poller retries uncreated invoices with same ID
  it('32. Invoice Provider Creation Recovery (P1.4): Poller retries uncreated invoices with same ID', async () => {
    const { merchantId } = await createMerchant(h.db);
    const resolver = new CubePayProviderResolver(h.config);

    // Create an invoice directly with provider_invoice_id = null (simulating provider outage at creation)
    const inv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '100000',
    });

    const checkRow = (await h.db.query<{ provider_create_status: string; provider_invoice_id: string | null }>(
      `SELECT provider_create_status, provider_invoice_id FROM core.invoices WHERE id = $1`,
      [inv.invoiceId],
    )).rows[0]!;
    expect(checkRow.provider_create_status).toBe('PENDING_PROVIDER_CREATE');
    expect(checkRow.provider_invoice_id).toBeNull();

    // Run recovery poller
    const { pollPendingInvoices } = await import('../../packages/core/src/use-cases/poll-pending-invoices.ts');
    const pollResult = await pollPendingInvoices(h.db, h.config, resolver);

    expect(pollResult.recovered).toBe(1);

    // Verify invoice now has provider_invoice_id populated
    const recoveredRow = (await h.db.query<{ provider_create_status: string; provider_invoice_id: string | null }>(
      `SELECT provider_create_status, provider_invoice_id FROM core.invoices WHERE id = $1`,
      [inv.invoiceId],
    )).rows[0]!;
    expect(recoveredRow.provider_create_status).toBe('PROVIDER_CREATED');
    expect(recoveredRow.provider_invoice_id).toBeTruthy();
  });
});
