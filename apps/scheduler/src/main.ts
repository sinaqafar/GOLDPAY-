/**
 * Scheduler — periodic integrity and housekeeping jobs.
 *
 * Distinct from the worker: the worker advances individual business items,
 * while the scheduler verifies the system as a whole.
 *
 * SPEC 119.58: a ledger imbalance is CRITICAL and triggers a financial freeze.
 */

import { randomUUID } from 'node:crypto';
import { createContainer, type Container } from '../../../packages/core/src/container.ts';
import { verifyGlobalBalance } from '../../../packages/ledger/src/ledger-service.ts';
import { expireStaleInvoices } from '../../../packages/core/src/use-cases/create-invoice.ts';
import { expireStaleReservations } from '../../../packages/core/src/use-cases/payout.ts';
import { purgeExpired } from '../../../packages/core/src/idempotency.ts';

export interface SchedulerReport {
  ledgerBalanced: boolean;
  invoicesExpired: number;
  reservationsExpired: number;
  staleUnknownPayouts: number;
  openExceptions: number;
}

/**
 * The integrity sweep. Safe to run repeatedly; it only reports and records.
 */
export async function runIntegritySweep(container: Container): Promise<SchedulerReport> {
  const { db, logger } = container;

  const invoicesExpired = await expireStaleInvoices(db);
  const reservationsExpired = await expireStaleReservations(db);
  await purgeExpired(db);

  // THE global invariant: debits must equal credits, per currency.
  const balance = await db.transaction((tx) => verifyGlobalBalance(tx));

  if (!balance.balanced) {
    logger.error('ledger.IMBALANCE_DETECTED', { byCurrency: balance.byCurrency });
    // CRITICAL: record it so operations can freeze financial activity.
    await db.query(
      `INSERT INTO system.reconciliation_exceptions
          (id, kind, severity, entity_type, entity_id, details)
       VALUES ($1,'LEDGER_IMBALANCE','CRITICAL','SYSTEM',NULL,$2::jsonb)`,
      [randomUUID(), JSON.stringify({ byCurrency: balance.byCurrency })],
    );
  }

  // Payouts that have been UNKNOWN for too long need a human.
  const stale = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM finance.payouts
      WHERE status = 'UNKNOWN' AND updated_at < NOW() - INTERVAL '1 hour'`,
  );
  const staleUnknownPayouts = Number.parseInt(stale.rows[0]?.count ?? '0', 10);
  if (staleUnknownPayouts > 0) {
    logger.warn('payouts.stale_unknown', { count: staleUnknownPayouts });
  }

  const open = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM system.reconciliation_exceptions WHERE status = 'OPEN'`,
  );

  const report: SchedulerReport = {
    ledgerBalanced: balance.balanced,
    invoicesExpired,
    reservationsExpired,
    staleUnknownPayouts,
    openExceptions: Number.parseInt(open.rows[0]?.count ?? '0', 10),
  };

  logger.info('scheduler.sweep', { ...report });
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const container = await createContainer({ service: 'scheduler' });
  const intervalMs = Number.parseInt(process.env['SCHEDULER_INTERVAL_MS'] ?? '60000', 10);

  const tick = async () => {
    try {
      await runIntegritySweep(container);
    } catch (e) {
      container.logger.error('scheduler.sweep_failed', {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  await tick();
  const timer = setInterval(() => void tick(), intervalMs);

  const shutdown = async (signal: string) => {
    container.logger.info('scheduler.shutdown', { signal });
    clearInterval(timer);
    await container.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
