/**
 * The golden path (SPEC 117.85):
 *   CREATE INVOICE -> VERIFY PAYMENT -> POST LEDGER -> WAIT 48H -> RELEASE -> PAYOUT
 *
 * This is the test the whole system exists to pass.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, createMerchant, fundTreasury, fastForwardRelease, type Harness } from '../helpers/harness.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../packages/core/src/use-cases/finalize-payment.ts';
import { releaseEligiblePayments } from '../../packages/core/src/use-cases/release-payment.ts';
import {
  queuePayoutForMerchant,
  lockPayoutRate,
  reservePayoutLiquidity,
  broadcastPayout,
  settlePayout,
} from '../../packages/core/src/use-cases/payout.ts';
import { verifyGlobalBalance } from '../../packages/ledger/src/ledger-service.ts';

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('golden path', () => {
  it('carries 1,000,000 Toman from invoice to settled GRAM payout', async () => {
    harness = await createHarness();
    const { db, config, chain, rates } = harness;
    const merchant = await createMerchant(db);

    // The owner funds the treasury manually — the only permitted way.
    await fundTreasury(db, 20_000_000_000n); // 20 GRAM

    // --- 1. CREATE INVOICE -------------------------------------------------
    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'CUSTOMER',
    });

    // 15% fee added on top: the customer pays 1,150,000 and the merchant is
    // owed the full 1,000,000.
    expect(invoice.customerTotal).toBe('1150000');
    expect(invoice.platformFee).toBe('150000');
    expect(invoice.merchantNet).toBe('1000000');

    // --- 2. VERIFY PAYMENT + 3. POST LEDGER --------------------------------
    const payment = await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: 'cp_golden_1',
        paidAmount: '1150000',
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: { ok: true },
      },
    });

    expect(payment.status).toBe('VERIFIED');
    expect(payment.credited).toBe(true);
    expect(payment.merchantNet).toBe('1000000');

    // The money is PENDING, not yet available.
    const pending = await balances(db, merchant.merchantId);
    expect(pending.pending).toBe('1000000');
    expect(pending.available).toBe('0');

    // Platform revenue was recognised immediately.
    expect(await systemBalance(db, 'PLATFORM_REVENUE_TOMAN')).toBe('150000');

    // --- 4. WAIT 48H -------------------------------------------------------
    // Nothing is releasable before the hold elapses.
    expect((await releaseEligiblePayments(db)).released).toBe(0);

    await fastForwardRelease(db, payment.paymentId);

    // --- 5. RELEASE --------------------------------------------------------
    const released = await releaseEligiblePayments(db);
    expect(released.released).toBe(1);

    const afterRelease = await balances(db, merchant.merchantId);
    expect(afterRelease.pending).toBe('0');
    expect(afterRelease.available).toBe('1000000');

    // --- 6. PAYOUT ---------------------------------------------------------
    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    expect(queued.payoutId).toBeTruthy();
    const payoutId = queued.payoutId as string;
    expect(queued.amountToman).toBe('1000000');

    // Balance moved AVAILABLE -> SETTLING; it is no longer spendable twice.
    const afterQueue = await balances(db, merchant.merchantId);
    expect(afterQueue.available).toBe('0');
    expect(afterQueue.settling).toBe('1000000');

    // At 100,000 Toman/GRAM, 1,000,000 Toman = 10 GRAM = 10e9 nanoGRAM.
    const locked = await lockPayoutRate(db, config, rates, payoutId);
    expect(locked.gramAmount).toBe('10000000000');

    const reserved = await reservePayoutLiquidity(db, config, payoutId);
    expect(reserved.reserved).toBe(true);

    const broadcast = await broadcastPayout(db, chain, payoutId);
    expect(broadcast.status).toBe('BROADCASTED');

    const settled = await settlePayout(db, payoutId, { txHash: broadcast.txHash as string });
    expect(settled.settled).toBe(true);

    // --- Final state -------------------------------------------------------
    const final = await balances(db, merchant.merchantId);
    expect(final.available).toBe('0');
    expect(final.pending).toBe('0');
    expect(final.settling).toBe('0');

    const payout = await db.query<{ status: string; transaction_hash: string }>(
      'SELECT status, transaction_hash FROM finance.payouts WHERE id = $1',
      [payoutId],
    );
    expect(payout.rows[0]?.status).toBe('SETTLED');
    expect(payout.rows[0]?.transaction_hash).toBeTruthy();

    // The treasury paid out 10 GRAM from its 20.
    const treasury = await db.query<{ confirmed_balance_atomic: string }>(
      `SELECT confirmed_balance_atomic::text FROM finance.treasury_accounts WHERE asset = 'GRAM'`,
    );
    expect(treasury.rows[0]?.confirmed_balance_atomic).toBe('10000000000');

    // The reservation was consumed, not left dangling.
    const reservation = await db.query<{ status: string }>(
      'SELECT status FROM finance.liquidity_reservations WHERE payout_id = $1',
      [payoutId],
    );
    expect(reservation.rows[0]?.status).toBe('CONSUMED');

    // THE invariant: debits equal credits, per currency, across the whole ledger.
    await db.transaction(async (tx) => {
      const balanced = await verifyGlobalBalance(tx);
      expect(balanced.balanced).toBe(true);
    });
  });

  it('holds the payout at WAITING_LIQUIDITY when the treasury is short, and never buys', async () => {
    harness = await createHarness();
    const { db, config, rates } = harness;
    const merchant = await createMerchant(db);

    // Only 1 GRAM available, but the payout needs 10.
    await fundTreasury(db, 1_000_000_000n);

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'CUSTOMER',
    });
    const payment = await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: 'cp_short_1',
        paidAmount: '1150000',
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
    await fastForwardRelease(db, payment.paymentId);
    await releaseEligiblePayments(db);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);

    const reserved = await reservePayoutLiquidity(db, config, payoutId);
    expect(reserved.reserved).toBe(false);
    expect(reserved.required).toBe('10000000000');

    const payout = await db.query<{ status: string }>(
      'SELECT status FROM finance.payouts WHERE id = $1',
      [payoutId],
    );
    // It waits. It does not buy, swap, bridge or auto-fund.
    expect(payout.rows[0]?.status).toBe('WAITING_LIQUIDITY');

    // The treasury balance is untouched: nothing was acquired.
    const treasury = await db.query<{ confirmed_balance_atomic: string }>(
      `SELECT confirmed_balance_atomic::text FROM finance.treasury_accounts WHERE asset = 'GRAM'`,
    );
    expect(treasury.rows[0]?.confirmed_balance_atomic).toBe('1000000000');

    // No reservation was created.
    const reservations = await db.query(
      'SELECT 1 FROM finance.liquidity_reservations WHERE payout_id = $1',
      [payoutId],
    );
    expect(reservations.rowCount).toBe(0);

    // The merchant's money is still safely in SETTLING, not lost.
    expect((await balances(db, merchant.merchantId)).settling).toBe('1000000');
  });
});

async function balances(
  db: Harness['db'],
  merchantId: string,
): Promise<{ available: string; pending: string; settling: string }> {
  const r = await db.query<{ available: string; pending: string; settling: string }>(
    `SELECT b.available::text, b.pending::text, b.settling::text
       FROM finance.balances b
       JOIN finance.ledger_accounts a ON a.id = b.account_id
      WHERE a.owner_type = 'MERCHANT' AND a.owner_id = $1`,
    [merchantId],
  );
  return r.rows[0] ?? { available: '0', pending: '0', settling: '0' };
}

async function systemBalance(db: Harness['db'], code: string): Promise<string> {
  const r = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(e.credit - e.debit),0)::text AS total
       FROM finance.journal_entries e
       JOIN finance.ledger_accounts a ON a.id = e.account_id
      WHERE a.account_code = $1 AND a.owner_id IS NULL`,
    [code],
  );
  return r.rows[0]?.total ?? '0';
}
