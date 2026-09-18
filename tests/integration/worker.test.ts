/**
 * Worker and scheduler.
 * Proves the automated pipeline carries a payment all the way to a settled
 * payout with no human step, and that the outbox/webhook chain fires.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHarness, createMerchant, fundTreasury, fastForwardRelease, type Harness } from '../helpers/harness.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../packages/core/src/use-cases/finalize-payment.ts';
import { startWorker } from '../../apps/worker/src/main.ts';
import { runIntegritySweep } from '../../apps/scheduler/src/main.ts';
import { dispatchOutbox } from '../../packages/core/src/dispatcher.ts';
import { dispatchWebhooks } from '../../packages/core/src/webhooks.ts';
import { silentLogger } from '../../packages/core/src/logger.ts';
import { randomUUID } from 'node:crypto';

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function container(h: Harness) {
  return {
    db: h.db,
    config: h.config,
    logger: silentLogger,
    provider: h.cubepay,
    chain: h.chain,
    rates: h.rates,
    shutdown: async () => {},
  };
}

describe('worker pipeline', () => {
  it('drives a released payment to a SETTLED payout with no manual step', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    await fundTreasury(db, 50_000_000_000n);

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'CUSTOMER',
    });
    const payment = await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: 'cp_worker_1',
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    // The hold has elapsed; from here the worker does everything.
    await fastForwardRelease(db, payment.paymentId);

    const worker = await startWorker(container(harness), 1_000_000);
    // Each cycle advances the pipeline one stage.
    for (let i = 0; i < 6; i++) await worker.runOnce();
    await worker.stop();

    const payout = await db.query<{ status: string; transaction_hash: string | null }>(
      'SELECT status, transaction_hash FROM finance.payouts WHERE merchant_id = $1',
      [merchant.merchantId],
    );
    expect(payout.rows[0]?.status).toBe('SETTLED');
    expect(payout.rows[0]?.transaction_hash).toBeTruthy();

    const balance = await db.query<{ available: string; pending: string; settling: string }>(
      `SELECT b.available::text, b.pending::text, b.settling::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchant.merchantId],
    );
    expect(balance.rows[0]).toEqual({ available: '0', pending: '0', settling: '0' });
  });

  it('keeps running when one stage throws', async () => {
    harness = await createHarness();
    const c = container(harness);
    // Break the chain adapter entirely.
    c.chain = {
      ...c.chain,
      send: async () => {
        throw new Error('chain exploded');
      },
    } as never;

    const worker = await startWorker(c, 1_000_000);
    await expect(worker.runOnce()).resolves.toBeUndefined();
    await worker.stop();
  });
});

describe('outbox and merchant webhooks', () => {
  it('publishes events and signs the delivery', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);

    // Register a merchant endpoint.
    await db.query(
      `INSERT INTO core.webhook_endpoints (id, merchant_id, url, secret_reference, status)
       VALUES ($1,$2,'https://merchant.example/hook','whsec_test','ACTIVE')`,
      [randomUUID(), merchant.merchantId],
    );

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '500000',
      feeMode: 'CUSTOMER',
    });
    await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: 'cp_hook_1',
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    // The outbox turns payment.verified into a merchant delivery.
    const summary = await dispatchOutbox(db, silentLogger);
    expect(summary.sent).toBeGreaterThan(0);
    expect(summary.deliveriesScheduled).toBeGreaterThan(0);

    const pending = await db.query<{ event_type: string; status: string }>(
      'SELECT event_type, status FROM integration.webhook_deliveries',
    );
    expect(pending.rows[0]?.event_type).toBe('payment.paid');
    expect(pending.rows[0]?.status).toBe('PENDING');

    // Deliver it, capturing the HTTP call.
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const outcomes = await dispatchWebhooks(db, {
      timeoutMs: 5000,
      maxAttempts: 5,
      allowedSchemes: ['https'],
      allowPrivate: true,
      fetchImpl: fakeFetch,
    });

    expect(outcomes[0]?.status).toBe('SENT');
    const call = calls[0] as (typeof calls)[number];
    expect(call.headers['X-Gateway-Event-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(call.headers['X-Gateway-Event-Timestamp']).toBeTruthy();
    expect(call.headers['X-Gateway-Event-Id']).toBeTruthy();
    expect(JSON.parse(call.body).type).toBe('payment.paid');
  });

  it('retries a 500 and gives up permanently on a 400', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    await db.query(
      `INSERT INTO core.webhook_endpoints (id, merchant_id, url, secret_reference, status)
       VALUES ($1,$2,'https://merchant.example/hook','whsec_test','ACTIVE')`,
      [randomUUID(), merchant.merchantId],
    );

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '500000',
      feeMode: 'CUSTOMER',
    });
    await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: 'cp_hook_2',
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
    await dispatchOutbox(db, silentLogger);

    const serverError = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const retried = await dispatchWebhooks(db, {
      timeoutMs: 5000,
      maxAttempts: 5,
      allowedSchemes: ['https'],
      allowPrivate: true,
      fetchImpl: serverError,
    });
    expect(retried[0]?.status).toBe('RETRY');

    // Make it due again, then answer with a permanent rejection.
    await db.query(`UPDATE integration.webhook_deliveries SET next_attempt_at = NOW()`);
    const badRequest = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
    const dead = await dispatchWebhooks(db, {
      timeoutMs: 5000,
      maxAttempts: 5,
      allowedSchemes: ['https'],
      allowPrivate: true,
      fetchImpl: badRequest,
    });
    expect(dead[0]?.status).toBe('DEAD');
  });

  it('refuses to deliver to a private address', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    await db.query(
      `INSERT INTO core.webhook_endpoints (id, merchant_id, url, secret_reference, status)
       VALUES ($1,$2,'https://127.0.0.1/hook','whsec_test','ACTIVE')`,
      [randomUUID(), merchant.merchantId],
    );

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '500000',
      feeMode: 'CUSTOMER',
    });
    await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: 'cp_hook_3',
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
    await dispatchOutbox(db, silentLogger);

    const shouldNotBeCalled = vi.fn();
    const outcomes = await dispatchWebhooks(db, {
      timeoutMs: 5000,
      maxAttempts: 5,
      allowedSchemes: ['https'],
      allowPrivate: false, // production behaviour
      fetchImpl: shouldNotBeCalled as unknown as typeof fetch,
    });

    expect(outcomes[0]?.status).toBe('DEAD');
    expect(shouldNotBeCalled).not.toHaveBeenCalled();
  });
});

describe('scheduler integrity sweep', () => {
  it('reports a balanced ledger on a healthy system', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'SPLIT',
    });
    await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: 'cp_sweep_1',
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    const report = await runIntegritySweep(container(harness));
    expect(report.ledgerBalanced).toBe(true);
    expect(report.openExceptions).toBe(0);
  });

  it('expires an invoice that was never paid', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      expiresInSeconds: 60,
    });

    await db.query(`UPDATE core.invoices SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [
      invoice.invoiceId,
    ]);

    const report = await runIntegritySweep(container(harness));
    expect(report.invoicesExpired).toBe(1);

    const status = await db.query<{ status: string }>(
      'SELECT status FROM core.invoices WHERE id = $1',
      [invoice.invoiceId],
    );
    expect(status.rows[0]?.status).toBe('EXPIRED');
  });
});

describe('financial freeze halts the pipeline', () => {
  it('stops a releasable payment from being paid out while frozen', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    await fundTreasury(db, 50_000_000_000n);

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'CUSTOMER',
    });
    const payment = await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: 'cp_freeze_1',
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
    await fastForwardRelease(db, payment.paymentId);

    // Freeze, then run the worker hard.
    await db.query(
      `UPDATE system.platform_state
          SET financial_freeze = TRUE, freeze_reason = 'test', frozen_at = NOW() WHERE id = TRUE`,
    );

    const worker = await startWorker(container(harness), 1_000_000);
    for (let i = 0; i < 6; i++) await worker.runOnce();

    // Nothing moved: no payout exists and the payment is still held.
    expect((await db.query('SELECT 1 FROM finance.payouts')).rowCount).toBe(0);
    const held = await db.query<{ status: string }>(
      'SELECT status FROM core.payments WHERE id = $1',
      [payment.paymentId],
    );
    expect(held.rows[0]?.status).toBe('VERIFIED');

    // Lift the freeze and the same worker settles it.
    await db.query(`UPDATE system.platform_state SET financial_freeze = FALSE, freeze_reason = NULL, frozen_at = NULL`);
    for (let i = 0; i < 6; i++) await worker.runOnce();
    await worker.stop();

    const payout = await db.query<{ status: string }>(
      'SELECT status FROM finance.payouts WHERE merchant_id = $1',
      [merchant.merchantId],
    );
    expect(payout.rows[0]?.status).toBe('SETTLED');
  });
});
