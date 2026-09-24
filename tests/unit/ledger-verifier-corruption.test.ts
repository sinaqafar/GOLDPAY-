import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { createMerchant } from '../helpers/harness.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../packages/core/src/use-cases/finalize-payment.ts';
import {
  verifySequenceContinuity,
  verifyLedgerBlocks,
  sealLedgerBlock,
} from '../../packages/ledger/src/ledger-blocks.ts';
import { runLedgerVerification } from '../../scripts/ledger-verify.ts';
import { randomUUID } from 'node:crypto';

describe('Ledger Verifier Cryptographic Integrity & Sequence Tests', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('verifies healthy sequence continuity on real payments', async () => {
    const { merchantId } = await createMerchant(h.db);

    // Create 3 invoices and finalize them
    for (let i = 1; i <= 3; i++) {
      const inv = await createInvoice(h.db, h.config, {
        merchantId,
        baseAmount: '100000',
      });
      await finalizePayment(h.db, h.config, {
        invoiceId: inv.invoiceId,
        evidence: {
          provider: 'CUBEPAY',
          externalPaymentId: `seq_test_${i}_${randomUUID()}`,
          paidAmount: inv.customerTotal,
          status: 'PAID',
          paidAt: new Date().toISOString(),
          raw: {},
        },
      });
    }

    const seqCheck = await verifySequenceContinuity(h.db);
    expect(seqCheck.valid).toBe(true);
    expect(seqCheck.journalCount).toBe(3);
    expect(seqCheck.entryCount).toBe(15);
  });

  it('detects corrupted journal sequence gap and fails verification', async () => {
    const { merchantId } = await createMerchant(h.db);
    const inv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '100000',
    });
    await finalizePayment(h.db, h.config, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `seq_gap_${randomUUID()}`,
        paidAmount: inv.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    // Drop immutable trigger temporarily to simulate low-level disk/DB corruption
    await h.db.query(`DROP TRIGGER IF EXISTS trg_journals_immutable ON finance.journals`);
    await h.db.query(`UPDATE finance.journals SET journal_sequence = 2 WHERE journal_sequence = 1`);

    const seqCheck = await verifySequenceContinuity(h.db);
    expect(seqCheck.valid).toBe(false);
    expect(seqCheck.errors[0]).toContain('Journal sequence mismatch');

    const globalResult = await runLedgerVerification(h.db);
    expect(globalResult).toBe(false);
  });

  it('seals ledger block and verifies Merkle root & block hash chain', async () => {
    const { merchantId } = await createMerchant(h.db);
    const inv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '100000',
    });
    await finalizePayment(h.db, h.config, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `block_test_${randomUUID()}`,
        paidAmount: inv.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    // Seal the block
    const sealed = await h.db.transaction((tx) => sealLedgerBlock(tx));
    expect(sealed).not.toBeNull();
    expect(sealed?.blockId).toBe('1');
    expect(sealed?.entryCount).toBeGreaterThanOrEqual(2);

    const blockCheck = await verifyLedgerBlocks(h.db);
    expect(blockCheck.valid).toBe(true);
    expect(blockCheck.blockCount).toBe(1);

    const fullCheck = await runLedgerVerification(h.db);
    expect(fullCheck).toBe(true);
  });

  it('detects tampered previous_block_hash in ledger blocks chain and fails verification', async () => {
    const { merchantId } = await createMerchant(h.db);
    const inv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '100000',
    });
    await finalizePayment(h.db, h.config, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `block_tamper_${randomUUID()}`,
        paidAmount: inv.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    await h.db.transaction((tx) => sealLedgerBlock(tx));

    // Tamper with previous_block_hash
    await h.db.query(
      `UPDATE finance.ledger_blocks SET previous_block_hash = '1111111111111111111111111111111111111111111111111111111111111111' WHERE block_id = 1`,
    );

    const blockCheck = await verifyLedgerBlocks(h.db);
    expect(blockCheck.valid).toBe(false);
    expect(blockCheck.errors.some((e) => e.includes('previous_block_hash broken'))).toBe(true);

    const fullCheck = await runLedgerVerification(h.db);
    expect(fullCheck).toBe(false);
  });

  it('detects tampered Merkle root and fails verification', async () => {
    const { merchantId } = await createMerchant(h.db);
    const inv = await createInvoice(h.db, h.config, {
      merchantId,
      baseAmount: '100000',
    });
    await finalizePayment(h.db, h.config, {
      invoiceId: inv.invoiceId,
      evidence: {
        provider: 'CUBEPAY',
        externalPaymentId: `merkle_tamper_${randomUUID()}`,
        paidAmount: inv.customerTotal,
        status: 'PAID',
        paidAt: new Date().toISOString(),
        raw: {},
      },
    });

    await h.db.transaction((tx) => sealLedgerBlock(tx));

    // Tamper with merkle_root_hash
    await h.db.query(
      `UPDATE finance.ledger_blocks SET merkle_root_hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' WHERE block_id = 1`,
    );

    const blockCheck = await verifyLedgerBlocks(h.db);
    expect(blockCheck.valid).toBe(false);
    expect(blockCheck.errors.some((e) => e.includes('Merkle root mismatch'))).toBe(true);

    const fullCheck = await runLedgerVerification(h.db);
    expect(fullCheck).toBe(false);
  });
});
