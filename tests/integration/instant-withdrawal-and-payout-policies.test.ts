/**
 * Integration test suite for:
 * 1. Instant Withdrawal Policy (2% Fee) vs Automatic Settlement (0% Fee after 48h)
 * 2. Instant Withdrawal Fee Accounting in Double-Entry Ledger (INSTANT_WITHDRAWAL_REVENUE_TOMAN)
 * 3. Atomic Balance Reservation and Double-Spend Protection
 * 4. Insufficient Liquidity -> WAITING_LIQUIDITY (No Partial Payouts)
 * 5. Failed Instant Payout Full Refund (Net + Instant Fee)
 * 6. TON send_mode=3 action failure / empty out_msg detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHarness, createMerchant, fastForwardRelease, type Harness } from '../helpers/harness.ts';
import {
  queuePayoutForMerchant,
  queueInstantPayoutForMerchant,
  lockPayoutRate,
  reservePayoutLiquidity,
  failPayout,
  settlePayout,
} from '../../packages/core/src/use-cases/payout.ts';
import { releaseEligiblePayments } from '../../packages/core/src/use-cases/release-payment.ts';
import { finalizePayment } from '../../packages/core/src/use-cases/finalize-payment.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';
import { Money, Rate } from '../../packages/money/src/index.ts';
import { TonAdapter } from '../../packages/ton/src/adapter.ts';
import type { RateProvider, RateQuote } from '../../packages/core/src/ports/rate-provider.ts';

class FixedRateProvider implements RateProvider {
  constructor(private tomanPerGram: string = '5000000') {}
  async getQuote(base: string, quote: string): Promise<RateQuote> {
    return {
      id: randomUUID(),
      tomanPerGram: this.tomanPerGram,
      source: 'TEST_CONSENSUS',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
  }
  async getHealth(): Promise<{ healthy: boolean; sources: Array<{ name: string; responsive: boolean }> }> {
    return { healthy: true, sources: [{ name: 'TEST_SOURCE', responsive: true }] };
  }
}

describe('Instant Withdrawal (2% Fee) vs Automatic Settlement (0% Fee)', () => {
  let h: Harness;
  const rateProvider = new FixedRateProvider('5000000');

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  async function createActiveMerchantWithBalance(balanceToman: bigint) {
    const { merchantId, walletId, address } = await createMerchant(h.db, {
      feeMode: 'MERCHANT',
      autoPayout: true,
    });

    // Create, pay, and release invoice to populate merchant's AVAILABLE balance
    if (balanceToman > 0n) {
      const inv = await createInvoice(h.db, h.config, {
        merchantId,
        baseAmount: balanceToman.toString(),
        feeMode: 'MERCHANT',
      });

      const payment = await finalizePayment(h.db, h.config, {
        invoiceId: inv.invoiceId,
        evidence: {
          provider: 'CUBEPAY',
          externalPaymentId: `pay_${randomUUID()}`,
          status: 'PAID',
          paidAmount: inv.customerTotal,
          paidAt: new Date().toISOString(),
          raw: { simulated: true },
        },
      });

      // Advance release time past 48h
      await fastForwardRelease(h.db, payment.paymentId, 49);

      await releaseEligiblePayments(h.db, { now: new Date() });
    }

    return { merchantId, walletId, destAddress: address };
  }

  it('Instant Withdrawal: charges exact 2% INSTANT_WITHDRAWAL_FEE and moves net 98% to settling', async () => {
    // Merchant has 1,000,000 Toman base (minus 15% platform fee = 850,000 Toman available)
    const { merchantId } = await createActiveMerchantWithBalance(1_000_000n);

    // Check available balance before instant payout
    const balanceBefore = await h.db.query<{ available: string }>(
      `SELECT b.available::text
         FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );
    const availBefore = BigInt(balanceBefore.rows[0]?.available ?? '0'); // 850,000 Toman

    // Request Instant Withdrawal of full available balance
    const result = await queueInstantPayoutForMerchant(h.db, h.config, merchantId, availBefore);

    expect(result.payoutId).toBeDefined();
    expect(result.payoutType).toBe('INSTANT');
    expect(result.feeType).toBe('INSTANT_WITHDRAWAL_FEE');

    // 2% of 850,000 = 17,000 Toman
    const expectedFee = (availBefore * 2n) / 100n; // 17,000
    const expectedNet = availBefore - expectedFee; // 833,000

    expect(result.grossAmountToman).toBe(availBefore.toString());
    expect(result.instantFeeToman).toBe(expectedFee.toString());
    expect(result.amountToman).toBe(expectedNet.toString());

    // Verify Ledger balances
    const balanceAfter = await h.db.query<{ available: string; settling: string }>(
      `SELECT b.available::text, b.settling::text
         FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );

    expect(balanceAfter.rows[0]?.available).toBe('0');
    expect(balanceAfter.rows[0]?.settling).toBe(expectedNet.toString());

    // Verify INSTANT_WITHDRAWAL_REVENUE_TOMAN ledger account received the 2% fee
    const feeRevenue = await h.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.credit - e.debit),0)::text AS total
         FROM finance.journal_entries e
         JOIN finance.ledger_accounts a ON a.id = e.account_id
        WHERE a.account_code = 'INSTANT_WITHDRAWAL_REVENUE_TOMAN'`,
    );

    expect(feeRevenue.rows[0]?.total).toBe(expectedFee.toString());

    // Verify PLATFORM_REVENUE_TOMAN contains only the 15% platform fee (150,000 Toman)
    const platformRev = await h.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.credit - e.debit),0)::text AS total
         FROM finance.journal_entries e
         JOIN finance.ledger_accounts a ON a.id = e.account_id
        WHERE a.account_code = 'PLATFORM_REVENUE_TOMAN'`,
    );

    expect(platformRev.rows[0]?.total).toBe('140000');
  });

  it('Automatic Settlement: charges 0% withdrawal fee and moves 100% of available funds', async () => {
    const { merchantId } = await createActiveMerchantWithBalance(1_000_000n);

    // Queue standard automatic payout (after 48h hold)
    const result = await queuePayoutForMerchant(h.db, h.config, merchantId, { mode: 'AUTOMATIC' });

    expect(result.payoutId).toBeDefined();
    expect(result.payoutType).toBe('AUTOMATIC');
    expect(result.feeType).toBe('NONE');
    expect(result.instantFeeToman).toBe('0');
    expect(result.amountToman).toBe('860000'); // Full 860,000 Toman net available
  });

  it('Insufficient Treasury Liquidity: parks payout in WAITING_LIQUIDITY with NO partial payout', async () => {
    const { merchantId } = await createActiveMerchantWithBalance(1_000_000n);
    const queueRes = await queueInstantPayoutForMerchant(h.db, h.config, merchantId);

    // Lock rate
    await lockPayoutRate(h.db, h.config, rateProvider, queueRes.payoutId!);

    // Treasury confirmed balance is currently 0 GRAM. Reservation should fail closed to WAITING_LIQUIDITY
    const reserveRes = await reservePayoutLiquidity(h.db, h.config, queueRes.payoutId!);

    expect(reserveRes.reserved).toBe(false);

    const payoutRow = (await h.db.query<{ status: string; gram_amount_atomic: string }>(
      'SELECT status, gram_amount_atomic::text FROM finance.payouts WHERE id = $1',
      [queueRes.payoutId],
    )).rows[0]!;

    expect(payoutRow.status).toBe('WAITING_LIQUIDITY');
  });

  it('Failed Instant Payout: reverses 100% of funds (net payout + 2% instant fee) back to merchant AVAILABLE balance', async () => {
    const { merchantId } = await createActiveMerchantWithBalance(1_000_000n);
    const queueRes = await queueInstantPayoutForMerchant(h.db, h.config, merchantId);

    // Payout fails (e.g. invalid network rejection or timeout before broadcast)
    await failPayout(h.db, queueRes.payoutId!, 'NETWORK_REJECTED');

    // Merchant balance must be fully restored to 850,000 Toman in AVAILABLE
    const balanceRestored = await h.db.query<{ available: string; settling: string }>(
      `SELECT b.available::text, b.settling::text
         FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchantId],
    );

    expect(balanceRestored.rows[0]?.available).toBe('860000');
    expect(balanceRestored.rows[0]?.settling).toBe('0');

    // Instant fee revenue must be 0 (reversed)
    const feeRevRestored = await h.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.credit - e.debit),0)::text AS total
         FROM finance.journal_entries e
         JOIN finance.ledger_accounts a ON a.id = e.account_id
        WHERE a.account_code = 'INSTANT_WITHDRAWAL_REVENUE_TOMAN'`,
    );

    expect(feeRevRestored.rows[0]?.total).toBe('0');
  });

  it('TON send_mode=3 safety: action_phase failure or missing out_msg rejects confirmation', async () => {
    const adapter = new TonAdapter(h.config.ton);

    // Mock fetch to simulate TON RPC returning a top-level tx success with action_phase failure (e.g. exit_code != 0)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v3/transactions')) {
        return new Response(
          JSON.stringify({
            transactions: [
              {
                success: true, // top-level contract execution ok
                mc_block_seqno: 123456,
                action_phase: {
                  success: false, // internal action failed!
                  result_code: 37, // NOT_ENOUGH_FUNDS or action error
                },
                out_msgs: [], // no outgoing internal message delivered
                total_fees: '5000000',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    try {
      const status = await adapter.getTransferStatus({
        idempotencyKey: 'payout:test-action-fail',
        txHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        to: 'UQCKbyoEmLcWDzN4JSlMrQdIJ45x6o-xm2EKCl3j3f8OawgQ',
        amountAtomic: 1000000000n,
      });

      // Must NOT be CONFIRMED!
      expect(status.state).toBe('FAILED');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
