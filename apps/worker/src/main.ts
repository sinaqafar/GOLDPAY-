/**
 * Worker — runs the background pipeline on a fixed cadence.
 *
 * SPEC 117.56 queues: payment.release, payout.selection, payout.broadcast,
 * payout.reconciliation, webhook.delivery, reconciliation, maintenance.
 *
 * Every job is wrapped so one failing stage can never stop the loop, and the
 * process shuts down cleanly on SIGTERM without abandoning an in-flight job.
 */

import { createContainer, type Container } from '../../../packages/core/src/container.ts';
import { dispatchOutbox } from '../../../packages/core/src/dispatcher.ts';
import { dispatchWebhooks } from '../../../packages/core/src/webhooks.ts';
import { releaseEligiblePayments } from '../../../packages/core/src/use-cases/release-payment.ts';
import {
  queuePayoutForMerchant,
  lockPayoutRate,
  reservePayoutLiquidity,
  broadcastPayout,
  settlePayout,
  reconcilePayout,
  expireStaleReservations,
} from '../../../packages/core/src/use-cases/payout.ts';
import { expireStaleInvoices } from '../../../packages/core/src/use-cases/create-invoice.ts';
import { purgeExpired } from '../../../packages/core/src/idempotency.ts';

export interface WorkerHandle {
  stop(): Promise<void>;
  runOnce(): Promise<void>;
}

export async function startWorker(container: Container, intervalMs = 5000): Promise<WorkerHandle> {
  const { db, config, logger, chain, rates } = container;
  let stopping = false;
  let current: Promise<void> = Promise.resolve();

  async function safely(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      logger.error('worker.job_failed', {
        job: name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function runOnce(): Promise<void> {
    // 1. Release payments whose 48h hold has elapsed.
    await safely('payment.release', async () => {
      const result = await releaseEligiblePayments(db, { limit: 100 });
      if (result.released > 0) {
        logger.info('payments.released', { count: result.released });
        // 2. A release makes a merchant payable: queue their payout.
        for (const merchantId of result.merchantIds) {
          await safely('payout.selection', () => queuePayoutForMerchant(db, config, merchantId));
        }
      }
    });

    // 3. Advance every payout through its pipeline stage.
    await safely('payout.pipeline', () => advancePayouts(container));

    // 4. Resolve anything ambiguous against the chain.
    await safely('payout.reconciliation', async () => {
      const unknown = await db.query<{ id: string }>(
        `SELECT id FROM finance.payouts
          WHERE status = 'UNKNOWN' AND updated_at < NOW() - INTERVAL '30 seconds'
          ORDER BY updated_at ASC LIMIT 20`,
      );
      for (const row of unknown.rows) {
        await safely('reconcile', () => reconcilePayout(db, chain, row.id));
      }
    });

    // 5. Publish domain events, then deliver merchant webhooks.
    await safely('outbox.dispatch', () => dispatchOutbox(db, logger));
    await safely('webhook.delivery', () =>
      dispatchWebhooks(db, {
        timeoutMs: config.security.webhookTimeoutMs,
        maxAttempts: config.security.webhookMaxRetries,
        allowedSchemes: config.security.allowedWebhookSchemes,
        allowPrivate: !config.app.isProduction,
      }),
    );

    // 6. Maintenance.
    await safely('maintenance', async () => {
      await expireStaleReservations(db);
      await expireStaleInvoices(db);
      await purgeExpired(db);
    });
  }

  const timer = setInterval(() => {
    if (stopping) return;
    current = runOnce();
  }, intervalMs);
  // Do not hold the event loop open on this timer alone.
  timer.unref?.();

  logger.info('worker.started', { intervalMs });

  return {
    runOnce,
    async stop() {
      stopping = true;
      clearInterval(timer);
      // Let the in-flight cycle finish so no job is torn in half.
      await current.catch(() => undefined);
      logger.info('worker.stopped');
    },
  };
}

/**
 * Drive each payout one step further. Each stage is attempted independently so
 * a single stuck payout cannot block the others.
 */
async function advancePayouts(container: Container): Promise<void> {
  const { db, config, logger, chain, rates } = container;

  const pending = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM finance.payouts
      WHERE status IN ('QUEUED','RATE_LOCKED','WAITING_LIQUIDITY','RESERVED','BROADCASTED')
      ORDER BY created_at ASC
      LIMIT 25`,
  );

  for (const payout of pending.rows) {
    try {
      switch (payout.status) {
        case 'QUEUED':
        case 'WAITING_LIQUIDITY':
          await lockPayoutRate(db, config, rates, payout.id);
          break;

        case 'RATE_LOCKED':
          await reservePayoutLiquidity(db, config, payout.id);
          break;

        case 'RESERVED':
          await broadcastPayout(db, chain, payout.id);
          break;

        case 'BROADCASTED': {
          // Only settle once the chain actually confirms (SPEC 124.168).
          const row = await db.query<{ transaction_hash: string | null; gram_amount_atomic: string }>(
            'SELECT transaction_hash, gram_amount_atomic::text FROM finance.payouts WHERE id = $1',
            [payout.id],
          );
          const record = row.rows[0];
          if (!record) break;
          const status = await chain.getTransferStatus({
            idempotencyKey: `payout:${payout.id}`,
            txHash: record.transaction_hash,
            to: '',
            amountAtomic: BigInt(record.gram_amount_atomic ?? '0'),
          });
          if (status.state === 'CONFIRMED' && status.txHash) {
            await settlePayout(db, payout.id, { txHash: status.txHash });
          }
          break;
        }
      }
    } catch (e) {
      logger.warn('payout.stage_failed', {
        payoutId: payout.id,
        status: payout.status,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// --- entrypoint ------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const container = await createContainer({ service: 'worker' });
  const worker = await startWorker(
    container,
    Number.parseInt(process.env['WORKER_INTERVAL_MS'] ?? '5000', 10),
  );

  const shutdown = async (signal: string) => {
    container.logger.info('worker.shutdown', { signal });
    await worker.stop();
    await container.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Keep the process alive.
  await new Promise(() => {});
}
