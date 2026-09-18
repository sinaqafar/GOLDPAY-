/**
 * QueuePort — SPEC 103755: the queue contract stays independent of BullMQ.
 *
 * The queue is a delivery mechanism, never the source of truth (SPEC 121.67).
 * PostgreSQL holds the ledger, balances and every state machine; Redis holds
 * only the intent to do work. Losing the whole queue must therefore be
 * survivable: the scheduler can rediscover outstanding work by scanning state,
 * because that state is in the database and not in a job payload.
 *
 * Two consequences the implementations must honour:
 *
 *   - A job payload carries identifiers, never secrets (SPEC 56.38) and never
 *     amounts that the handler could act on without re-reading the database.
 *     Re-reading is what makes a replayed job harmless.
 *   - Delivery is at-least-once. Every handler must already be idempotent, so
 *     a duplicate job is a no-op rather than a second payment.
 */

export const QUEUE_NAMES = [
  'payment.verification',
  'payment.release',
  'payout.selection',
  'payout.broadcast',
  'payout.reconciliation',
  'webhook.delivery',
  'notification.telegram',
  'reconciliation',
  'maintenance',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface JobOptions {
  /**
   * Stable id used for deduplication. Two enqueues with the same id produce one
   * job, which is how a retried producer avoids creating duplicate work.
   */
  jobId?: string;
  /** Delay before the job becomes available, in milliseconds. */
  delayMs?: number;
  /** Higher runs sooner. */
  priority?: number;
  attempts?: number;
  backoffMs?: number;
}

export interface Job<T = Record<string, unknown>> {
  id: string;
  name: QueueName;
  data: T;
  attempt: number;
}

export type JobHandler<T = Record<string, unknown>> = (job: Job<T>) => Promise<void>;

export interface QueuePort {
  readonly name: string;
  enqueue<T extends Record<string, unknown>>(
    queue: QueueName,
    data: T,
    options?: JobOptions,
  ): Promise<string>;
  /** Register a consumer. Implementations may run several concurrently. */
  process<T extends Record<string, unknown>>(
    queue: QueueName,
    handler: JobHandler<T>,
    options?: { concurrency?: number },
  ): Promise<void>;
  /** Pending job count, for health checks and dashboards. */
  depth(queue: QueueName): Promise<number>;
  close(): Promise<void>;
}
