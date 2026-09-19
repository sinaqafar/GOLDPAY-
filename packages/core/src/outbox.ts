/**
 * Transactional outbox.
 *
 * SPEC 118.73: state change + ledger + outbox commit together.
 * SPEC 4347: no HTTP inside a financial transaction — effects are enqueued here
 * and dispatched only after COMMIT.
 * SPEC 118.75: a worker must not trust a stale PROCESSING row forever.
 */

import { randomUUID } from 'node:crypto';
import type { TransactionContext, Database } from '../../database/src/client.ts';

export type OutboxEventType =
  | 'merchant.created'
  | 'merchant.activated'
  | 'invoice.created'
  | 'invoice.cancelled'
  | 'invoice.expired'
  | 'payment.detected'
  | 'payment.verified'
  | 'payment.released'
  | 'payment.refunded'
  | 'payout.created'
  | 'payout.queued'
  | 'payout.waiting_liquidity'
  | 'payout.broadcasted'
  | 'payout.confirmed'
  | 'payout.failed'
  | 'payout.unknown'
  | 'treasury.funded'
  | 'reconciliation.mismatch';

export interface OutboxEvent {
  id: string;
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/** SPEC 117.57 — the event envelope written into the outbox payload. */
export interface EventEnvelope {
  id: string;
  type: OutboxEventType;
  version: number;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  correlationId: string | null;
  causationId: string | null;
  actor: string;
  payload: Record<string, unknown>;
}

export async function enqueue(
  tx: TransactionContext,
  event: {
    eventType: OutboxEventType;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    correlationId?: string;
    causationId?: string;
    actor?: string;
    availableAt?: Date;
  },
): Promise<string> {
  const id = randomUUID();
  const envelope: EventEnvelope = {
    id,
    type: event.eventType,
    version: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
    actor: event.actor ?? 'SYSTEM',
    payload: event.payload,
  };

  await tx.query(
    `INSERT INTO system.outbox_events
        (id, event_type, aggregate_type, aggregate_id, payload, status, available_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6)`,
    [
      id,
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(envelope),
      (event.availableAt ?? new Date()).toISOString(),
    ],
  );
  return id;
}

export interface ClaimedEvent {
  id: string;
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId: string;
  envelope: EventEnvelope;
  attempts: number;
}

/**
 * Claim a batch of due events for dispatch.
 *
 * `FOR UPDATE SKIP LOCKED` (SPEC 118.55/118.56) lets several dispatchers run in
 * parallel without contending on the same rows. Rows stuck in PROCESSING beyond
 * `staleAfterMs` are reclaimed, which recovers from a crashed worker.
 */
export async function claimBatch(
  db: Database,
  options: { limit?: number; staleAfterMs?: number } = {},
): Promise<ClaimedEvent[]> {
  const limit = options.limit ?? 20;
  const staleAfterMs = options.staleAfterMs ?? 60_000;

  return db.transaction(async (tx) => {
    const r = await tx.query<{
      id: string;
      event_type: OutboxEventType;
      aggregate_type: string;
      aggregate_id: string;
      payload: unknown;
      attempts: number;
    }>(
      `WITH due AS (
         SELECT id FROM system.outbox_events
          WHERE (status IN ('PENDING','RETRY') AND available_at <= NOW())
             OR (status = 'PROCESSING' AND locked_at < NOW() - ($2 || ' milliseconds')::interval)
          ORDER BY available_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE system.outbox_events o
          SET status = 'PROCESSING', locked_at = NOW()
         FROM due
        WHERE o.id = due.id
       RETURNING o.id, o.event_type, o.aggregate_type, o.aggregate_id, o.payload, o.attempts`,
      [limit, String(staleAfterMs)],
    );

    return r.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      envelope: (typeof row.payload === 'string'
        ? JSON.parse(row.payload)
        : row.payload) as EventEnvelope,
      attempts: row.attempts,
    }));
  });
}

export async function markSent(db: Database, id: string): Promise<void> {
  await db.query(
    `UPDATE system.outbox_events
        SET status = 'SENT', processed_at = NOW(), locked_at = NULL
      WHERE id = $1 AND status = 'PROCESSING'`,
    [id],
  );
}

/** Exponential backoff, capped, with a dead-letter terminal state. */
export async function markFailed(
  db: Database,
  id: string,
  error: string,
  maxAttempts = 10,
): Promise<void> {
  await db.query(
    `UPDATE system.outbox_events
        SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= $3 THEN 'DEAD' ELSE 'RETRY' END,
            available_at = NOW() + (LEAST(POWER(2, attempts + 1), 3600) || ' seconds')::interval,
            last_error = $2,
            locked_at = NULL
      WHERE id = $1`,
    [id, error.slice(0, 1000), maxAttempts],
  );
}
