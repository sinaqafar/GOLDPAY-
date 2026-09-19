/**
 * QueuePort behaviour.
 *
 * These assert the contract every implementation must satisfy, so a handler
 * proven correct against the in-memory queue behaves the same on BullMQ.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryQueue } from '../../packages/queue/src/in-memory-queue.ts';
import { QUEUE_NAMES } from '../../packages/core/src/ports/queue.ts';

describe('QueuePort contract', () => {
  it('names every queue the specification lists', () => {
    expect(QUEUE_NAMES).toContain('payment.verification');
    expect(QUEUE_NAMES).toContain('payment.release');
    expect(QUEUE_NAMES).toContain('payout.selection');
    expect(QUEUE_NAMES).toContain('payout.broadcast');
    expect(QUEUE_NAMES).toContain('payout.reconciliation');
    expect(QUEUE_NAMES).toContain('webhook.delivery');
    expect(QUEUE_NAMES).toContain('notification.telegram');
    expect(QUEUE_NAMES).toContain('reconciliation');
    expect(QUEUE_NAMES).toContain('maintenance');
  });

  it('delivers an enqueued job to its handler', async () => {
    const queue = new InMemoryQueue();
    const seen: string[] = [];
    await queue.process('payout.broadcast', async (job) => {
      seen.push((job.data as { payoutId: string }).payoutId);
    });

    await queue.enqueue('payout.broadcast', { payoutId: 'p1' });
    await queue.drain();

    expect(seen).toEqual(['p1']);
  });

  it('collapses a duplicate enqueue on the same job id', async () => {
    // A producer that retries must not create a second unit of work.
    const queue = new InMemoryQueue();
    let calls = 0;
    await queue.process('payout.selection', async () => {
      calls += 1;
    });

    await queue.enqueue('payout.selection', { payoutId: 'p1' }, { jobId: 'payout:p1' });
    await queue.enqueue('payout.selection', { payoutId: 'p1' }, { jobId: 'payout:p1' });
    await queue.drain();

    expect(calls).toBe(1);
  });

  it('holds a delayed job until it is due', async () => {
    const queue = new InMemoryQueue();
    let calls = 0;
    await queue.process('maintenance', async () => {
      calls += 1;
    });

    await queue.enqueue('maintenance', {}, { delayMs: 60_000 });
    await queue.drain();
    expect(calls).toBe(0);
    expect(await queue.depth('maintenance')).toBe(1);
  });

  it('runs higher priority work first', async () => {
    const queue = new InMemoryQueue();
    const order: string[] = [];
    await queue.process('webhook.delivery', async (job) => {
      order.push((job.data as { tag: string }).tag);
    });

    await queue.enqueue('webhook.delivery', { tag: 'low' }, { priority: 1 });
    await queue.enqueue('webhook.delivery', { tag: 'high' }, { priority: 10 });
    await queue.drain();

    expect(order).toEqual(['high', 'low']);
  });

  it('retries a failing job and counts the attempt', async () => {
    const queue = new InMemoryQueue();
    const attempts: number[] = [];
    await queue.process('payment.verification', async (job) => {
      attempts.push(job.attempt);
      if (job.attempt < 3) throw new Error('transient');
    });

    await queue.enqueue('payment.verification', { paymentId: 'x' }, { attempts: 3 });
    await queue.drain();
    await queue.drain();
    await queue.drain();

    expect(attempts).toEqual([1, 2, 3]);
    expect(queue.deadLettered()).toHaveLength(0);
  });

  it('dead-letters a job that exhausts its retries', async () => {
    // Failing forever must not mean retrying forever.
    const queue = new InMemoryQueue();
    await queue.process('payout.reconciliation', async () => {
      throw new Error('permanently broken');
    });

    await queue.enqueue('payout.reconciliation', { payoutId: 'p1' }, { attempts: 2 });
    await queue.drain();
    await queue.drain();

    expect(queue.deadLettered()).toHaveLength(1);
    expect(queue.deadLettered()[0]?.attempts).toBe(2);
    expect(await queue.depth('payout.reconciliation')).toBe(0);
  });

  it('reports depth so a health check can see a backlog', async () => {
    const queue = new InMemoryQueue();
    await queue.enqueue('reconciliation', { a: 1 });
    await queue.enqueue('reconciliation', { b: 2 });
    expect(await queue.depth('reconciliation')).toBe(2);
  });
});
