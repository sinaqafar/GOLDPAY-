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
import { notifyMerchant, type TelegramSender } from './notifications.ts';

export interface DispatchSummary {
  claimed: number;
  sent: number;
  failed: number;
  deliveriesScheduled: number;
  notificationsSent: number;
}

export async function dispatchOutbox(
  db: Database,
  logger: Logger,
  options: { batchSize?: number; telegram?: TelegramSender } = {},
): Promise<DispatchSummary> {
  const events = await claimBatch(db, { limit: options.batchSize ?? 50 });
  const summary: DispatchSummary = {
    claimed: events.length,
    sent: 0,
    failed: 0,
    deliveriesScheduled: 0,
    notificationsSent: 0,
  };

  for (const event of events) {
    try {
      summary.deliveriesScheduled += await scheduleMerchantDeliveries(db, event.envelope);

      // Notifications come after the webhook is scheduled and are best-effort
      // by design: notifyMerchant swallows its own failures, so a Telegram
      // outage cannot strand an event in the outbox (SPEC 5565).
      if (options.telegram) {
        const notified = await notifyMerchant(db, options.telegram, logger, event.envelope);
        if (notified) summary.notificationsSent += 1;
      }

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
