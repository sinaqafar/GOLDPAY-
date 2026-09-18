/**
 * Ledger and concurrency integrity.
 *
 * SPEC 117.86: ledger balancing, payment idempotency, 48h eligibility,
 * liquidity reservation, payout state machine, concurrency / double-spend,
 * tenant isolation.
 * SPEC 103926: the database must protect the system even when application code
 * has a bug — several of these tests attack the DB directly, bypassing the
 * domain layer, and assert that it still refuses.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHarness, createMerchant, fundTreasury, fastForwardRelease, type Harness , chainEvidenceFor } from '../helpers/harness.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../packages/core/src/use-cases/finalize-payment.ts';
import { releaseEligiblePayments } from '../../packages/core/src/use-cases/release-payment.ts';
import {
  queuePayoutForMerchant,
  lockPayoutRate,
  reservePayoutLiquidity,
  signPayout,
  broadcastPayout,
  settlePayout,
  failPayout,
  reconcilePayout,
  expireStaleReservations,
} from '../../packages/core/src/use-cases/payout.ts';
import { post, verifyGlobalBalance, verifyProjection } from '../../packages/ledger/src/ledger-service.ts';
import { requestRefund, refundableAmount } from '../../packages/core/src/use-cases/refund.ts';
import { placeHold, releaseHold } from '../../packages/core/src/risk.ts';
import { markConfirming } from '../../packages/core/src/use-cases/payout.ts';
import { openDispute, resolveDispute } from '../../packages/core/src/use-cases/dispute.ts';
import { getOrCreateMerchantAccount, getSystemAccountId } from '../../packages/ledger/src/accounts.ts';
import { Money } from '../../packages/money/src/index.ts';

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const evidence = (id: string, amount: string) => ({
  provider: 'CUBEPAY',
  externalPaymentId: id,
  paidAmount: amount,
  status: 'PAID' as const,
  paidAt: new Date().toISOString(),
  raw: {},
});

/** Invoice -> verified payment, the common setup. */
async function paidInvoice(h: Harness, merchantId: string, base = '1000000', extId = randomUUID()) {
  const invoice = await createInvoice(h.db, h.config, {
    merchantId,
    baseAmount: base,
    feeMode: 'CUSTOMER',
  });
  const payment = await finalizePayment(h.db, h.config, {
    invoiceId: invoice.invoiceId,
    evidence: evidence(extId, invoice.customerTotal),
  });
  return { invoice, payment };
}

describe('double-entry invariants', () => {
  it('rejects an unbalanced journal', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db);

    await expect(
      db.transaction(async (tx) => {
        const account = await getOrCreateMerchantAccount(tx, merchant.merchantId);
        const clearing = await getSystemAccountId(tx, 'PROVIDER_CLEARING_TOMAN');
        await post(tx, {
          referenceType: 'TEST',
          referenceId: randomUUID(),
          operationId: `test:${randomUUID()}`,
          lines: [
            { accountId: clearing, debit: Money.toman(1000) },
            { accountId: account, credit: Money.toman(999) }, // one Toman short
          ],
        });
      }),
    ).rejects.toThrow();
  });

  it('rejects a line that is both a debit and a credit', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db);

    await expect(
      db.transaction(async (tx) => {
        const account = await getOrCreateMerchantAccount(tx, merchant.merchantId);
        await post(tx, {
          referenceType: 'TEST',
          referenceId: randomUUID(),
          operationId: `test:${randomUUID()}`,
          lines: [{ accountId: account, debit: Money.toman(10), credit: Money.toman(10) }],
        });
      }),
    ).rejects.toThrow();
  });

  it('refuses to mutate a posted journal entry, even with direct SQL', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db);
    await paidInvoice(harness, merchant.merchantId);

    // Attack the ledger directly: the immutability trigger must stop it.
    await expect(
      db.query('UPDATE finance.journal_entries SET credit = credit + 1000000'),
    ).rejects.toThrow();
    await expect(db.query('DELETE FROM finance.journal_entries')).rejects.toThrow();
    await expect(db.query('DELETE FROM finance.journals')).rejects.toThrow();
  });

  it('keeps the balance projection in agreement with the journal', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db);
    const { payment } = await paidInvoice(harness, merchant.merchantId);
    await fastForwardRelease(db, payment.paymentId);
    await releaseEligiblePayments(db);

    await db.transaction(async (tx) => {
      const account = await getOrCreateMerchantAccount(tx, merchant.merchantId);
      const check = await verifyProjection(tx, account);
      expect(check.consistent, JSON.stringify(check)).toBe(true);
      expect((await verifyGlobalBalance(tx)).balanced).toBe(true);
    });
  });
});

describe('payment idempotency (SPEC 119.41)', () => {
  it('produces exactly one economic result for three identical callbacks', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'CUSTOMER',
    });
    const ev = evidence('cp_dupe_1', invoice.customerTotal);

    const first = await finalizePayment(db, config, { invoiceId: invoice.invoiceId, evidence: ev });
    const second = await finalizePayment(db, config, { invoiceId: invoice.invoiceId, evidence: ev });
    const third = await finalizePayment(db, config, { invoiceId: invoice.invoiceId, evidence: ev });

    expect(first.credited).toBe(true);
    expect(second.credited).toBe(false);
    expect(third.credited).toBe(false);
    expect(second.paymentId).toBe(first.paymentId);

    // One payment row, one journal, one credit.
    const payments = await db.query('SELECT 1 FROM core.payments WHERE invoice_id = $1', [
      invoice.invoiceId,
    ]);
    expect(payments.rowCount).toBe(1);

    const balance = await db.query<{ pending: string }>(
      `SELECT b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchant.merchantId],
    );
    expect(balance.rows[0]?.pending).toBe('1000000');
  });

  it('handles concurrent duplicate callbacks without double-crediting', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '500000',
      feeMode: 'CUSTOMER',
    });
    const ev = evidence('cp_race_1', invoice.customerTotal);

    const results = await Promise.allSettled([
      finalizePayment(db, config, { invoiceId: invoice.invoiceId, evidence: ev }),
      finalizePayment(db, config, { invoiceId: invoice.invoiceId, evidence: ev }),
      finalizePayment(db, config, { invoiceId: invoice.invoiceId, evidence: ev }),
    ]);

    const credited = results.filter((r) => r.status === 'fulfilled' && r.value.credited);
    expect(credited).toHaveLength(1);

    const balance = await db.query<{ pending: string }>(
      `SELECT b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchant.merchantId],
    );
    expect(balance.rows[0]?.pending).toBe('500000');
  });

  it('never credits on an amount mismatch, and records an exception instead', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'CUSTOMER',
    });

    const under = await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: evidence('cp_under_1', '1000000'), // should have been 1,150,000
    });
    expect(under.status).toBe('MISMATCH');
    expect(under.credited).toBe(false);
    expect(under.mismatchCode).toBe('UNDERPAYMENT');

    const exceptions = await db.query<{ kind: string; severity: string }>(
      `SELECT kind, severity FROM system.reconciliation_exceptions WHERE entity_id = $1`,
      [under.paymentId],
    );
    expect(exceptions.rows[0]?.kind).toBe('AMOUNT_MISMATCH');

    // No money moved.
    const balances = await db.query(
      `SELECT 1 FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1 AND (b.pending > 0 OR b.available > 0)`,
      [merchant.merchantId],
    );
    expect(balances.rowCount).toBe(0);
  });

  it('does not credit when the provider status is not PAID', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db);
    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'CUSTOMER',
    });

    const result = await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: { ...evidence('cp_fail_1', invoice.customerTotal), status: 'FAILED' },
    });
    expect(result.status).toBe('FAILED');
    expect(result.credited).toBe(false);
  });
});

describe('48h release eligibility (SPEC 1251)', () => {
  it('does not release before the hold elapses', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db);
    await paidInvoice(harness, merchant.merchantId);

    expect((await releaseEligiblePayments(db)).released).toBe(0);
  });

  it('sets release_at to exactly verified_paid_at + 48h', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db);
    const { payment } = await paidInvoice(harness, merchant.merchantId);

    const r = await db.query<{ diff: string }>(
      `SELECT EXTRACT(EPOCH FROM (release_at - verified_paid_at))::text AS diff
         FROM core.payments WHERE id = $1`,
      [payment.paymentId],
    );
    expect(Number(r.rows[0]?.diff)).toBe(48 * 3600);
  });

  it('releases only once even when several workers run concurrently', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db);
    const { payment } = await paidInvoice(harness, merchant.merchantId);
    await fastForwardRelease(db, payment.paymentId);

    const runs = await Promise.allSettled([
      releaseEligiblePayments(db),
      releaseEligiblePayments(db),
      releaseEligiblePayments(db),
    ]);
    const total = runs.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? r.value.released : 0),
      0,
    );
    expect(total).toBe(1);

    const balance = await db.query<{ available: string; pending: string }>(
      `SELECT b.available::text, b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchant.merchantId],
    );
    expect(balance.rows[0]?.available).toBe('1000000');
    expect(balance.rows[0]?.pending).toBe('0');
  });
});

describe('payout state machine and liquidity', () => {
  async function readyForPayout(h: Harness, gram = 20_000_000_000n) {
    const merchant = await createMerchant(h.db);
    await fundTreasury(h.db, gram);
    const { payment } = await paidInvoice(h, merchant.merchantId);
    await fastForwardRelease(h.db, payment.paymentId);
    await releaseEligiblePayments(h.db);
    return merchant;
  }

  it('allows only one in-flight payout per merchant', async () => {
    harness = await createHarness();
    const merchant = await readyForPayout(harness);

    const first = await queuePayoutForMerchant(harness.db, harness.config, merchant.merchantId);
    expect(first.payoutId).toBeTruthy();

    const second = await queuePayoutForMerchant(harness.db, harness.config, merchant.merchantId);
    expect(second.payoutId).toBeNull();
    expect(second.reason).toBe('PAYOUT_ALREADY_IN_FLIGHT');
  });

  it('does not queue a payout when the merchant has no active wallet', async () => {
    harness = await createHarness();
    const merchant = await readyForPayout(harness);
    await harness.db.query(`UPDATE core.wallets SET status = 'DISABLED' WHERE merchant_id = $1`, [
      merchant.merchantId,
    ]);

    const result = await queuePayoutForMerchant(harness.db, harness.config, merchant.merchantId);
    expect(result.payoutId).toBeNull();
    expect(result.reason).toBe('WALLET_NOT_ACTIVE');
  });

  it('returns the money to AVAILABLE when a payout definitively fails', async () => {
    harness = await createHarness();
    const { db, config, rates, chain } = harness;
    const merchant = await readyForPayout(harness);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);
    await signPayout(db, chain, config, payoutId);

    chain.setNextOutcome('REJECTED');
    const result = await broadcastPayout(db, chain, payoutId);
    expect(result.status).toBe('FAILED');

    const balance = await db.query<{ available: string; settling: string }>(
      `SELECT b.available::text, b.settling::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchant.merchantId],
    );
    expect(balance.rows[0]?.available).toBe('1000000');
    expect(balance.rows[0]?.settling).toBe('0');

    const reservation = await db.query<{ status: string }>(
      'SELECT status FROM finance.liquidity_reservations WHERE payout_id = $1',
      [payoutId],
    );
    expect(reservation.rows[0]?.status).toBe('RELEASED');
  });

  it('sends an ambiguous broadcast to UNKNOWN and refuses a blind failure', async () => {
    harness = await createHarness();
    const { db, config, rates, chain } = harness;
    const merchant = await readyForPayout(harness);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);
    await signPayout(db, chain, config, payoutId);

    chain.setNextOutcome('UNKNOWN');
    const result = await broadcastPayout(db, chain, payoutId);
    expect(result.status).toBe('UNKNOWN');

    // SPEC 124.170 — an UNKNOWN payout may not simply be failed.
    await expect(failPayout(db, payoutId, 'guessing')).rejects.toThrow();

    // Reconciliation is the only way out. The chain did receive it.
    const reconciled = await reconcilePayout(db, chain, payoutId, config);
    expect(reconciled.resolution).toBe('SETTLED');

    const payout = await db.query<{ status: string }>(
      'SELECT status FROM finance.payouts WHERE id = $1',
      [payoutId],
    );
    expect(payout.rows[0]?.status).toBe('SETTLED');
  });

  it('settles idempotently — a second confirmation moves no further money', async () => {
    harness = await createHarness();
    const { db, config, rates, chain } = harness;
    const merchant = await readyForPayout(harness);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);
    await signPayout(db, chain, config, payoutId);
    const broadcast = await broadcastPayout(db, chain, payoutId);

    const first = await settlePayout(db, payoutId, await chainEvidenceFor(db, payoutId, broadcast.txHash as string));
    const second = await settlePayout(db, payoutId, await chainEvidenceFor(db, payoutId, broadcast.txHash as string));
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(false);

    const treasury = await db.query<{ confirmed_balance_atomic: string }>(
      `SELECT confirmed_balance_atomic::text FROM finance.treasury_accounts WHERE asset = 'GRAM'`,
    );
    // One settlement only: 10 GRAM principal + 0.001 fee, not twice that.
    expect(treasury.rows[0]?.confirmed_balance_atomic).toBe('9999000000');
  });

  it('respects the safety reserve when computing spendable liquidity', async () => {
    harness = await createHarness();
    const { db, config, rates } = harness;
    const merchant = await readyForPayout(harness, 10_000_000_000n); // exactly 10 GRAM

    // Reserve 5 GRAM as untouchable.
    await db.query(
      `UPDATE finance.treasury_accounts SET safety_reserve_atomic = 5000000000 WHERE asset = 'GRAM'`,
    );

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);

    const reserved = await reservePayoutLiquidity(db, config, payoutId);
    // 10 GRAM present, 5 reserved, so only 5 spendable against a 10 GRAM need.
    expect(reserved.reserved).toBe(false);
    expect(reserved.spendable).toBe('5000000000');
  });

  it('frees liquidity again when a reservation expires', async () => {
    harness = await createHarness();
    const { db, config, rates } = harness;
    const merchant = await readyForPayout(harness);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);

    await db.query(
      `UPDATE finance.liquidity_reservations SET expires_at = NOW() - INTERVAL '1 minute'
        WHERE payout_id = $1`,
      [payoutId],
    );
    const expired = await expireStaleReservations(db);
    expect(expired).toBe(1);

    const payout = await db.query<{ status: string }>(
      'SELECT status FROM finance.payouts WHERE id = $1',
      [payoutId],
    );
    expect(payout.rows[0]?.status).toBe('RATE_LOCKED');
  });

  it('refuses to broadcast a payout that has not been signed', async () => {
    harness = await createHarness();
    const { db, config, rates, chain } = harness;
    const merchant = await readyForPayout(harness);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);

    // RESERVED but not SIGNED: nothing may reach the network yet (SPEC 5502).
    await expect(broadcastPayout(db, chain, payoutId)).rejects.toThrow(/PAYOUT_NOT_BROADCASTABLE|is RESERVED/);
  });

  it('signs exactly once and is idempotent on a repeated signing attempt', async () => {
    harness = await createHarness();
    const { db, config, rates, chain } = harness;
    const merchant = await readyForPayout(harness);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);

    const first = await signPayout(db, chain, config, payoutId);
    // SPEC 5498 — a second attempt must return the existing signature rather
    // than building a second spendable transaction.
    const second = await signPayout(db, chain, config, payoutId);
    expect(second.signingReference).toBe(first.signingReference);

    const row = await db.query<{ status: string; signed_at: string | null; signing_reference: string | null }>(
      'SELECT status, signed_at, signing_reference FROM finance.payouts WHERE id = $1',
      [payoutId],
    );
    expect(row.rows[0]?.status).toBe('SIGNED');
    expect(row.rows[0]?.signed_at).not.toBeNull();
    expect(row.rows[0]?.signing_reference).not.toBeNull();
  });

  it('refuses to sign when the destination no longer matches the active wallet', async () => {
    harness = await createHarness();
    const { db, config, rates, chain } = harness;
    const merchant = await readyForPayout(harness);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);
    await signPayout(db, chain, config, payoutId);

    // The merchant swaps their wallet after the payout was snapshotted.
    await db.query(
      `UPDATE finance.payouts SET destination_address = $2 WHERE id = $1`,
      [payoutId, 'EQD__________________________________________1vo'],
    );

    // SPEC 97.115 — the broadcast guard must catch the divergence.
    await expect(broadcastPayout(db, chain, payoutId)).rejects.toMatchObject({
      code: 'DESTINATION_MISMATCH',
    });
  });

  it('refuses to broadcast without a valid reservation', async () => {
    harness = await createHarness();
    const { db, config, rates, chain } = harness;
    const merchant = await readyForPayout(harness);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, rates, payoutId);

    // Still RATE_LOCKED, never reserved.
    await expect(broadcastPayout(db, chain, payoutId)).rejects.toThrow();
  });

  it('refuses to mark SETTLED without a transaction hash, at the DB level', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db);
    const payoutId = randomUUID();
    const wallet = await db.query<{ id: string }>(
      'SELECT id FROM core.wallets WHERE merchant_id = $1',
      [merchant.merchantId],
    );

    await expect(
      db.query(
        `INSERT INTO finance.payouts
            (id, merchant_id, wallet_id, amount_toman, status, destination_address,
             destination_network, rate, rate_source, gram_amount_atomic)
         VALUES ($1,$2,$3,1000,'SETTLED','EQtest','TON_TESTNET',1,'X',1)`,
        [payoutId, merchant.merchantId, wallet.rows[0]?.id],
      ),
    ).rejects.toThrow();
  });
});

describe('tenant isolation', () => {
  it('keeps two merchants’ balances completely separate', async () => {
    harness = await createHarness();
    const { db } = harness;
    const a = await createMerchant(db, { name: 'Shop A' });
    const b = await createMerchant(db, { name: 'Shop B' });

    await paidInvoice(harness, a.merchantId, '1000000');
    await paidInvoice(harness, b.merchantId, '2000000');

    const balances = await db.query<{ owner_id: string; pending: string }>(
      `SELECT a.owner_id, b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_type = 'MERCHANT'`,
    );
    const byMerchant = Object.fromEntries(balances.rows.map((r) => [r.owner_id, r.pending]));
    expect(byMerchant[a.merchantId]).toBe('1000000');
    expect(byMerchant[b.merchantId]).toBe('2000000');
  });

  it('gives each merchant their own liability account', async () => {
    harness = await createHarness();
    const { db } = harness;
    const a = await createMerchant(db);
    const b = await createMerchant(db);

    await db.transaction(async (tx) => {
      const accountA = await getOrCreateMerchantAccount(tx, a.merchantId);
      const accountB = await getOrCreateMerchantAccount(tx, b.merchantId);
      expect(accountA).not.toBe(accountB);
      // Repeated calls are stable, not duplicating rows.
      expect(await getOrCreateMerchantAccount(tx, a.merchantId)).toBe(accountA);
    });
  });
});

describe('treasury (manual funding only)', () => {
  it('records manual funding once per transaction hash', async () => {
    harness = await createHarness();
    const { db } = harness;
    const { recordManualTreasuryFunding } = await import('../../packages/core/src/use-cases/payout.ts');
    const treasury = await db.query<{ id: string }>(
      `SELECT id FROM finance.treasury_accounts WHERE asset = 'GRAM'`,
    );
    const id = treasury.rows[0]?.id as string;

    const first = await recordManualTreasuryFunding(db, {
      treasuryAccountId: id,
      amountAtomic: 5_000_000_000n,
      txHash: 'chain_tx_abc',
    });
    const replay = await recordManualTreasuryFunding(db, {
      treasuryAccountId: id,
      amountAtomic: 5_000_000_000n,
      txHash: 'chain_tx_abc',
    });

    expect(first.recorded).toBe(true);
    expect(replay.recorded).toBe(false);

    const balance = await db.query<{ confirmed_balance_atomic: string }>(
      `SELECT confirmed_balance_atomic::text FROM finance.treasury_accounts WHERE id = $1`,
      [id],
    );
    expect(balance.rows[0]?.confirmed_balance_atomic).toBe('5000000000');
  });

  it('refuses any treasury transaction source that implies automation', async () => {
    harness = await createHarness();
    const { db } = harness;
    const treasury = await db.query<{ id: string }>(
      `SELECT id FROM finance.treasury_accounts WHERE asset = 'GRAM'`,
    );

    for (const source of ['AUTO_BUY', 'SWAP', 'BRIDGE', 'EXCHANGE']) {
      await expect(
        db.query(
          `INSERT INTO finance.treasury_transactions
              (id, treasury_account_id, direction, asset, amount_atomic, status, source)
           VALUES ($1,$2,'IN','GRAM',1000,'CONFIRMED',$3)`,
          [randomUUID(), treasury.rows[0]?.id, source],
        ),
        source,
      ).rejects.toThrow();
    }
  });
});

describe('per-merchant fee mode (SPEC 2386)', () => {
  it("uses the merchant's own default rather than the platform default", async () => {
    harness = await createHarness();
    const { db, config } = harness;

    // The platform default is CUSTOMER; this merchant is configured MERCHANT.
    expect(config.fees.defaultFeeMode).toBe('CUSTOMER');
    const merchant = await createMerchant(db, { feeMode: 'MERCHANT' });

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
    });

    // MERCHANT mode: the customer pays the base and the merchant absorbs 15%.
    expect(invoice.feeMode).toBe('MERCHANT');
    expect(invoice.customerTotal).toBe('1000000');
    expect(invoice.merchantNet).toBe('850000');
  });

  it('still lets an explicit request override the merchant default', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'MERCHANT' });

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
      feeMode: 'SPLIT',
    });

    // SPLIT: 7.5% each side.
    expect(invoice.feeMode).toBe('SPLIT');
    expect(invoice.customerTotal).toBe('1075000');
    expect(invoice.merchantNet).toBe('925000');
  });

  it('freezes the snapshot, so changing the default later does not move it', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
    });
    expect(invoice.customerTotal).toBe('1150000');

    // The merchant switches their default afterwards.
    await db.query(`UPDATE core.merchants SET default_fee_mode = 'MERCHANT' WHERE id = $1`, [
      merchant.merchantId,
    ]);

    const stored = await db.query<{ fee_mode: string; customer_total_amount: string }>(
      'SELECT fee_mode, customer_total_amount::text FROM core.invoices WHERE id = $1',
      [invoice.invoiceId],
    );
    expect(stored.rows[0]?.fee_mode).toBe('CUSTOMER');
    expect(stored.rows[0]?.customer_total_amount).toBe('1150000');
  });
});

describe('provider fee: expected vs actual (SPEC 71.13)', () => {
  it('records the config estimate when the provider reports no fee', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'MERCHANT' });

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
    });
    await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `pay_${randomUUID()}`,
        paidAmount: '1000000',
        providerFeeAmount: null,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    const row = await db.query<{
      provider_fee_expected: string;
      provider_fee_actual: string | null;
      provider_fee_status: string;
      provider_fee_source: string;
    }>(
      `SELECT provider_fee_expected::text, provider_fee_actual::text,
              provider_fee_status, provider_fee_source
         FROM core.payments WHERE invoice_id = $1`,
      [invoice.invoiceId],
    );
    // 9% of 1,000,000, CEIL.
    expect(row.rows[0]?.provider_fee_expected).toBe('90000');
    expect(row.rows[0]?.provider_fee_actual).toBeNull();
    expect(row.rows[0]?.provider_fee_status).toBe('CONFIG_ESTIMATED');
    expect(row.rows[0]?.provider_fee_source).toBe('CONFIG');
  });

  it('marks the fee confirmed when the provider agrees', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'MERCHANT' });

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
    });
    await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `pay_${randomUUID()}`,
        paidAmount: '1000000',
        providerFeeAmount: '90000',
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    const row = await db.query<{ provider_fee_status: string; provider_fee_difference: string }>(
      `SELECT provider_fee_status, provider_fee_difference::text
         FROM core.payments WHERE invoice_id = $1`,
      [invoice.invoiceId],
    );
    expect(row.rows[0]?.provider_fee_status).toBe('PROVIDER_CONFIRMED');
    expect(row.rows[0]?.provider_fee_difference).toBe('0');
  });

  it('flags a divergence and raises a reconciliation exception', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'MERCHANT' });

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
    });
    // The provider actually took 8.7%, not the 9% we expected.
    const result = await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `pay_${randomUUID()}`,
        paidAmount: '1000000',
        providerFeeAmount: '87000',
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
    // The payment itself still succeeds — the money moved correctly.
    expect(result.status).toBe('VERIFIED');

    const row = await db.query<{
      provider_fee_expected: string;
      provider_fee_actual: string;
      provider_fee_difference: string;
      provider_fee_status: string;
    }>(
      `SELECT provider_fee_expected::text, provider_fee_actual::text,
              provider_fee_difference::text, provider_fee_status
         FROM core.payments WHERE invoice_id = $1`,
      [invoice.invoiceId],
    );
    expect(row.rows[0]?.provider_fee_expected).toBe('90000');
    expect(row.rows[0]?.provider_fee_actual).toBe('87000');
    expect(row.rows[0]?.provider_fee_difference).toBe('-3000');
    expect(row.rows[0]?.provider_fee_status).toBe('MISMATCH');

    const exception = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM system.reconciliation_exceptions
        WHERE entity_type = 'PAYMENT' AND status = 'OPEN'`,
    );
    expect(exception.rows[0]?.details['reason']).toBe('PROVIDER_FEE_MISMATCH');

    // The ledger books the ACTUAL cost, so margin is not overstated. Expense
    // accounts carry no projection row by design — they are reported by
    // aggregating the journal — so read the entries directly.
    const expense = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.debit - e.credit), 0)::text AS total
         FROM finance.journal_entries e
         JOIN finance.ledger_accounts a ON a.id = e.account_id
        WHERE a.account_code = 'PLATFORM_EXPENSE_TOMAN'`,
    );
    expect(expense.rows[0]?.total).toBe('87000');

    // And the clearing asset keeps the rest: 1,000,000 − 87,000.
    const clearing = await db.query<{ balance: string }>(
      `SELECT b.available::text AS balance FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.account_code = 'PROVIDER_CLEARING_TOMAN'`,
    );
    expect(clearing.rows[0]?.balance).toBe('913000');
  });
});

describe('refunds (PART 70)', () => {
  async function verifiedPayment(h: Harness) {
    const merchant = await createMerchant(h.db, { feeMode: 'CUSTOMER' });
    const invoice = await createInvoice(h.db, h.config, {
      merchantId: merchant.merchantId,
      baseAmount: '1000000',
    });
    const payment = await finalizePayment(h.db, h.config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `pay_${randomUUID()}`,
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
    return { merchant, invoice, payment };
  }

  it('records the request but refuses to execute while the policy is undefined', async () => {
    harness = await createHarness();
    const { merchant, payment } = await verifiedPayment(harness);

    const result = await requestRefund(harness.db, {
      paymentId: payment.paymentId,
      merchantId: merchant.merchantId,
      amount: '100000',
      reason: 'customer changed their mind',
      requestedByType: 'MERCHANT',
    });

    // Recorded and audited, but explicitly not executed: the provider contract
    // does not yet say how the fees behave on a reversal.
    expect(result.status).toBe('BLOCKED_POLICY_UNDEFINED');
    expect(result.blockedReason).toContain('policy');

    // No money moved.
    const outbox = await harness.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM system.outbox_events
        WHERE event_type = 'payment.refunded'`,
    );
    expect(outbox.rows[0]?.count).toBe('0');
  });

  it('stores the fee components separately so a policy can be applied later', async () => {
    harness = await createHarness();
    const { merchant, payment } = await verifiedPayment(harness);

    await requestRefund(harness.db, {
      paymentId: payment.paymentId,
      merchantId: merchant.merchantId,
      amount: '500000',
      reason: 'partial',
      requestedByType: 'MERCHANT',
    });

    const row = await harness.db.query<{
      original_amount: string;
      original_platform_fee: string;
      original_provider_fee: string | null;
      platform_fee_reversal: string | null;
    }>(
      `SELECT original_amount::text, original_platform_fee::text,
              original_provider_fee::text, platform_fee_reversal::text
         FROM core.refunds WHERE payment_id = $1`,
      [payment.paymentId],
    );
    expect(row.rows[0]?.original_amount).toBe('1150000');
    expect(row.rows[0]?.original_platform_fee).toBe('150000');
    expect(row.rows[0]?.original_provider_fee).toBe('103500');
    // Undecided, which is exactly why execution is blocked.
    expect(row.rows[0]?.platform_fee_reversal).toBeNull();
  });

  it('never lets the total refunded exceed what was collected', async () => {
    harness = await createHarness();
    const { merchant, payment } = await verifiedPayment(harness);

    await requestRefund(harness.db, {
      paymentId: payment.paymentId,
      merchantId: merchant.merchantId,
      amount: '1000000',
      reason: 'first',
      requestedByType: 'MERCHANT',
    });

    // 1,000,000 + 200,000 > 1,150,000 collected.
    await expect(
      requestRefund(harness.db, {
        paymentId: payment.paymentId,
        merchantId: merchant.merchantId,
        amount: '200000',
        reason: 'second',
        requestedByType: 'MERCHANT',
      }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_PAYMENT' });
  });

  it('is defended by the database even if the application check is bypassed', async () => {
    harness = await createHarness();
    const { merchant, payment } = await verifiedPayment(harness);

    // Insert straight past the use case, as a buggy code path would.
    await expect(
      harness.db.query(
        `INSERT INTO core.refunds
           (id, payment_id, merchant_id, original_amount, original_platform_fee,
            requested_amount, status, reason, requested_by_type)
         VALUES ($1,$2,$3,'1150000','150000','9999999','REQUESTED','bypass','ADMIN')`,
        [randomUUID(), payment.paymentId, merchant.merchantId],
      ),
    ).rejects.toThrow(/exceeds the collected amount/);
  });

  it('reports how much is still refundable', async () => {
    harness = await createHarness();
    const { merchant, payment } = await verifiedPayment(harness);

    expect(await refundableAmount(harness.db, payment.paymentId)).toBe('1150000');

    await requestRefund(harness.db, {
      paymentId: payment.paymentId,
      merchantId: merchant.merchantId,
      amount: '150000',
      reason: 'partial',
      requestedByType: 'MERCHANT',
    });
    expect(await refundableAmount(harness.db, payment.paymentId)).toBe('1000000');
  });

  it("will not let one merchant refund another's payment", async () => {
    harness = await createHarness();
    const { payment } = await verifiedPayment(harness);
    const other = await createMerchant(harness.db, { name: 'Other' });

    await expect(
      requestRefund(harness.db, {
        paymentId: payment.paymentId,
        merchantId: other.merchantId,
        amount: '1000',
        reason: 'not mine',
        requestedByType: 'MERCHANT',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('risk holds and disputes', () => {
  async function verifiedPaymentFor(h: Harness, merchantId: string) {
    const invoice = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '1000000',
    });
    return finalizePayment(h.db, h.config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `pay_${randomUUID()}`,
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
  }

  it('a hold pauses release without moving any money', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    const payment = await verifiedPaymentFor(harness, merchant.merchantId);

    await db.transaction(async (tx) =>
      placeHold(tx, {
        paymentId: payment.paymentId,
        merchantId: merchant.merchantId,
        source: 'RISK',
        reason: 'manual test hold',
      }),
    );

    await fastForwardRelease(db, payment.paymentId);
    const released = await releaseEligiblePayments(db);
    expect(released.released).toBe(0);

    // The money is untouched — still credited, still PENDING, not lost.
    const balance = await db.query<{ pending: string; available: string }>(
      `SELECT b.pending::text, b.available::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchant.merchantId],
    );
    expect(balance.rows[0]?.pending).toBe('1000000');
    expect(balance.rows[0]?.available).toBe('0');
  });

  it('releases normally once the hold is lifted', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    const payment = await verifiedPaymentFor(harness, merchant.merchantId);

    const hold = await db.transaction(async (tx) =>
      placeHold(tx, {
        paymentId: payment.paymentId,
        merchantId: merchant.merchantId,
        source: 'RISK',
        reason: 'temporary',
      }),
    );
    await fastForwardRelease(db, payment.paymentId);
    expect((await releaseEligiblePayments(db)).released).toBe(0);

    await releaseHold(db, { holdId: hold.holdId, releasedBy: randomUUID() });
    expect((await releaseEligiblePayments(db)).released).toBe(1);
  });

  it('is idempotent: holding twice from one source yields one hold', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    const payment = await verifiedPaymentFor(harness, merchant.merchantId);

    const first = await db.transaction(async (tx) =>
      placeHold(tx, {
        paymentId: payment.paymentId,
        merchantId: merchant.merchantId,
        source: 'RISK',
        reason: 'one',
      }),
    );
    const second = await db.transaction(async (tx) =>
      placeHold(tx, {
        paymentId: payment.paymentId,
        merchantId: merchant.merchantId,
        source: 'RISK',
        reason: 'two',
      }),
    );

    expect(second.created).toBe(false);
    expect(second.holdId).toBe(first.holdId);
  });

  it('opening a dispute holds the money but reverses nothing', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    const payment = await verifiedPaymentFor(harness, merchant.merchantId);

    const dispute = await openDispute(db, {
      paymentId: payment.paymentId,
      reason: 'customer claims non-delivery',
      openedByType: 'CUSTOMER',
    });
    expect(dispute.status).toBe('HOLD');
    expect(dispute.holdPlaced).toBe(true);

    await fastForwardRelease(db, payment.paymentId);
    expect((await releaseEligiblePayments(db)).released).toBe(0);

    // Crucially: the ledger is unchanged. A dispute investigates; it does not
    // claw back.
    const balance = await db.query<{ pending: string }>(
      `SELECT b.pending::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchant.merchantId],
    );
    expect(balance.rows[0]?.pending).toBe('1000000');
  });

  it('allows only one live dispute per payment', async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    const payment = await verifiedPaymentFor(harness, merchant.merchantId);

    await openDispute(db, {
      paymentId: payment.paymentId,
      reason: 'first',
      openedByType: 'MERCHANT',
    });
    await expect(
      openDispute(db, {
        paymentId: payment.paymentId,
        reason: 'second',
        openedByType: 'MERCHANT',
      }),
    ).rejects.toMatchObject({ code: 'DISPUTE_ALREADY_OPEN' });
  });

  it('lifts the hold when the merchant is upheld', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    const payment = await verifiedPaymentFor(harness, merchant.merchantId);

    const dispute = await openDispute(db, {
      paymentId: payment.paymentId,
      reason: 'investigating',
      openedByType: 'ADMIN',
    });
    const resolved = await resolveDispute(db, {
      disputeId: dispute.disputeId,
      resolution: 'UPHELD_MERCHANT',
      resolvedBy: randomUUID(),
    });

    expect(resolved.holdReleased).toBe(true);
    await fastForwardRelease(db, payment.paymentId);
    expect((await releaseEligiblePayments(db)).released).toBe(1);
  });

  it('keeps the hold when a refund is required', async () => {
    // Releasing here would let the money leave while it is still owed back.
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    const payment = await verifiedPaymentFor(harness, merchant.merchantId);

    const dispute = await openDispute(db, {
      paymentId: payment.paymentId,
      reason: 'customer wins',
      openedByType: 'ADMIN',
    });
    const resolved = await resolveDispute(db, {
      disputeId: dispute.disputeId,
      resolution: 'REFUND_REQUIRED',
      resolvedBy: randomUUID(),
    });

    expect(resolved.holdReleased).toBe(false);
    await fastForwardRelease(db, payment.paymentId);
    expect((await releaseEligiblePayments(db)).released).toBe(0);
  });

  it("will not let a merchant dispute another merchant's payment", async () => {
    harness = await createHarness();
    const { db } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    const other = await createMerchant(db, { name: 'Other' });
    const payment = await verifiedPaymentFor(harness, merchant.merchantId);

    await expect(
      openDispute(db, {
        paymentId: payment.paymentId,
        reason: 'not mine',
        openedByType: 'MERCHANT',
        merchantId: other.merchantId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('payout allocation and settlement evidence', () => {
  /** Release a payment of an exact net amount for a merchant. */
  async function releasedPayment(h: Harness, merchantId: string, baseAmount: string) {
    const invoice = await createInvoice(h.db, h.config, { merchantId, baseAmount });
    const payment = await finalizePayment(h.db, h.config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `pay_${randomUUID()}`,
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
    await fastForwardRelease(h.db, payment.paymentId);
    await releaseEligiblePayments(h.db);
    return payment.paymentId;
  }

  it('never attaches more in items than the payout is worth', async () => {
    harness = await createHarness();
    const { db, config } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    await fundTreasury(db, 500_000_000_000n);

    // Two payments of 700,000 and 600,000 = 1,300,000 available.
    await releasedPayment(harness, merchant.merchantId, '700000');
    await releasedPayment(harness, merchant.merchantId, '600000');

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;

    const items = await db.query<{ total: string; count: string }>(
      `SELECT COALESCE(SUM(amount_toman),0)::text AS total, COUNT(*)::text AS count
         FROM finance.payout_items WHERE payout_id = $1`,
      [payoutId],
    );
    const payout = await db.query<{ amount_toman: string }>(
      'SELECT amount_toman::text FROM finance.payouts WHERE id = $1',
      [payoutId],
    );

    // The audit trail must never claim the payout settled more than it moved.
    expect(BigInt(items.rows[0]?.total ?? '0')).toBeLessThanOrEqual(
      BigInt(payout.rows[0]?.amount_toman ?? '0'),
    );
  });

  it('re-uses a payment after its payout failed, instead of stranding it', async () => {
    // Previously a failed payout left its items behind, so the money sat in
    // AVAILABLE forever while every future selection skipped it.
    harness = await createHarness();
    const { db, config, chain } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    await fundTreasury(db, 500_000_000_000n);

    const paymentId = await releasedPayment(harness, merchant.merchantId, '400000');

    const first = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const firstPayoutId = first.payoutId as string;
    await lockPayoutRate(db, config, harness.rates, firstPayoutId);
    await reservePayoutLiquidity(db, config, firstPayoutId);
    await signPayout(db, chain, config, firstPayoutId, harness.signer);

    chain.setNextOutcome('REJECTED');
    expect((await broadcastPayout(db, chain, firstPayoutId)).status).toBe('FAILED');

    // The money is back in AVAILABLE...
    const balance = await db.query<{ available: string }>(
      `SELECT b.available::text FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_id = $1`,
      [merchant.merchantId],
    );
    expect(BigInt(balance.rows[0]?.available ?? '0')).toBeGreaterThan(0n);

    // ...and a new payout must actually pick that payment up again.
    const second = await queuePayoutForMerchant(db, config, merchant.merchantId);
    expect(second.payoutId).toBeTruthy();

    const reattached = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM finance.payout_items
        WHERE payout_id = $1 AND payment_id = $2`,
      [second.payoutId, paymentId],
    );
    expect(reattached.rows[0]?.count).toBe('1');
  });

  it('refuses to settle on a transaction hash alone', async () => {
    harness = await createHarness();
    const { db, config, chain } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    await fundTreasury(db, 500_000_000_000n);
    await releasedPayment(harness, merchant.merchantId, '300000');

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, harness.rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);
    await signPayout(db, chain, config, payoutId, harness.signer);
    const broadcast = await broadcastPayout(db, chain, payoutId);

    const good = await chainEvidenceFor(db, payoutId, broadcast.txHash as string);

    // Wrong destination: the transfer confirmed, but not to our merchant.
    await expect(
      settlePayout(db, payoutId, { ...good, onChainDestination: 'EQsomewhereElse' }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_DESTINATION_MISMATCH' });

    // Wrong amount.
    await expect(
      settlePayout(db, payoutId, { ...good, onChainAmountAtomic: good.onChainAmountAtomic - 1n }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_AMOUNT_MISMATCH' });

    // Not yet confirmed.
    await expect(
      settlePayout(db, payoutId, { ...good, confirmations: 0 }, { minConfirmations: 1 }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_NOT_CONFIRMED' });

    // Wrong asset entirely.
    await expect(
      settlePayout(db, payoutId, { ...good, asset: 'USDT' }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_ASSET_MISMATCH' });

    // Still BROADCASTED: none of the above moved it.
    const row = await db.query<{ status: string }>(
      'SELECT status FROM finance.payouts WHERE id = $1',
      [payoutId],
    );
    expect(row.rows[0]?.status).toBe('BROADCASTED');

    // Correct evidence settles it.
    expect((await settlePayout(db, payoutId, good)).settled).toBe(true);
  });

  it('does not treat a fresh NOT_FOUND as a definitive failure', async () => {
    // An indexer lagging looks exactly like a transfer that never happened.
    // Returning the funds immediately risks paying the merchant twice.
    harness = await createHarness();
    const { db, config, chain } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    await fundTreasury(db, 500_000_000_000n);
    await releasedPayment(harness, merchant.merchantId, '250000');

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, harness.rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);
    await signPayout(db, chain, config, payoutId, harness.signer);

    chain.setNextOutcome('UNKNOWN');
    await broadcastPayout(db, chain, payoutId);

    // The in-memory chain has no record under a different key, so this reads
    // NOT_FOUND — but the payout only just became UNKNOWN.
    const fresh = await reconcilePayout(db, chain, payoutId, config);
    expect(fresh.resolution).not.toBe('FAILED');

    const row = await db.query<{ status: string }>(
      'SELECT status FROM finance.payouts WHERE id = $1',
      [payoutId],
    );
    // Funds stay committed while the outcome is genuinely unknown.
    expect(['UNKNOWN', 'SETTLED']).toContain(row.rows[0]?.status);
  });
});

describe('CONFIRMING state', () => {
  it('distinguishes "sent" from "seen but not final"', async () => {
    harness = await createHarness();
    const { db, config, chain } = harness;
    const merchant = await createMerchant(db, { feeMode: 'CUSTOMER' });
    await fundTreasury(db, 500_000_000_000n);

    const invoice = await createInvoice(db, config, {
      merchantId: merchant.merchantId,
      baseAmount: '220000',
    });
    const payment = await finalizePayment(db, config, {
      invoiceId: invoice.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `pay_${randomUUID()}`,
        paidAmount: invoice.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });
    await fastForwardRelease(db, payment.paymentId);
    await releaseEligiblePayments(db);

    const queued = await queuePayoutForMerchant(db, config, merchant.merchantId);
    const payoutId = queued.payoutId as string;
    await lockPayoutRate(db, config, harness.rates, payoutId);
    await reservePayoutLiquidity(db, config, payoutId);
    await signPayout(db, chain, config, payoutId, harness.signer);
    const broadcast = await broadcastPayout(db, chain, payoutId);

    const moved = await markConfirming(db, payoutId, {
      txHash: broadcast.txHash as string,
      confirmations: 1,
    });
    expect(moved.moved).toBe(true);

    const row = await db.query<{ status: string }>(
      'SELECT status FROM finance.payouts WHERE id = $1',
      [payoutId],
    );
    expect(row.rows[0]?.status).toBe('CONFIRMING');

    // And a payout in CONFIRMING still settles on full evidence.
    const settled = await settlePayout(
      db,
      payoutId,
      await chainEvidenceFor(db, payoutId, broadcast.txHash as string),
    );
    expect(settled.settled).toBe(true);
  });
});
