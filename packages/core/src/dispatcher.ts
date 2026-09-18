/**
 * Outbox dispatcher — SPEC 118.73/118.74: events are published only after the
 * financial transaction has committed, and each is delivered at-least-once.
 *
 * The dispatcher turns internal domain events into merchant webhook deliveries.
 * Any failure here can never roll back money that is already committed.
 */

import type { Database } from '../../database/src/client.ts';
import { claimBatch, markSent, markFailed } from './outbox.ts';
import { scheduleMerchantDeliveries } from './webhooks.ts';
import type { Logger } from './logger.ts';

export interface DispatchSummary {
  claimed: number;
  sent: number;
  failed: number;
  deliveriesScheduled: number;
}

export async function dispatchOutbox(
  db: Database,
  logger: Logger,
  options: { batchSize?: number } = {},
): Promise<DispatchSummary> {
  const events = await claimBatch(db, { limit: options.batchSize ?? 50 });
  const summary: DispatchSummary = {
    claimed: events.length,
    sent: 0,
    failed: 0,
    deliveriesScheduled: 0,
  };

  for (const event of events) {
    try {
      summary.deliveriesScheduled += await scheduleMerchantDeliveries(db, event.envelope);
      await markSent(db, event.id);
      summary.sent += 1;
    } catch (e) {
      // The event stays in the outbox and is retried with backoff.
      const message = e instanceof Error ? e.message : String(e);
      logger.error('outbox.dispatch_failed', { eventId: event.id, type: event.eventType, message });
      await markFailed(db, event.id, message);
      summary.failed += 1;
    }
  }

  return summary;
}
