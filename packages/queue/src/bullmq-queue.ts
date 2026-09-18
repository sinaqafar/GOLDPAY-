/**
 * BullMQ implementation of QueuePort.
 *
 * Production settings that matter, per BullMQ's own going-to-production guide:
 *
 *   - Redis must run with `maxmemory-policy=noeviction`. If Redis evicts keys
 *     it will silently drop jobs, and a dropped payout job is money that never
 *     moves while every dashboard says the work was queued.
 *   - AOF persistence should be on, so a Redis restart does not lose queued
 *     work.
 *   - `maxRetriesPerRequest: null` lets workers survive a reconnect instead of
 *     erroring out mid-job.
 *
 * Even with all of that, the queue is not the source of truth. Jobs carry
 * identifiers only; handlers re-read the database and decide from committed
 * state, so a replayed or lost job cannot by itself corrupt anything.
 */

import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type {
  QueuePort,
  QueueName,
  JobOptions,
  JobHandler,
} from '../../core/src/ports/queue.ts';

export interface BullMqQueueOptions {
  redisUrl: string;
  /** Namespace so several environments can share one Redis safely. */
  prefix?: string;
  defaultAttempts?: number;
  defaultBackoffMs?: number;
}

export class BullMqQueue implements QueuePort {
  readonly name = 'BULLMQ';
  #connection: ConnectionOptions;
  #prefix: string;
  #queues = new Map<QueueName, Queue>();
  #workers: Worker[] = [];
  #defaultAttempts: number;
  #defaultBackoffMs: number;

  constructor(options: BullMqQueueOptions) {
    const url = new URL(options.redisUrl);
    this.#connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: url.password } : {}),
      ...(url.username ? { username: url.username } : {}),
      // Required for workers to survive a reconnect rather than throwing.
      maxRetriesPerRequest: null,
    };
    this.#prefix = options.prefix ?? 'gram';
    this.#defaultAttempts = options.defaultAttempts ?? 5;
    this.#defaultBackoffMs = options.defaultBackoffMs ?? 10_000;
  }

  #queue(name: QueueName): Queue {
    let queue = this.#queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.#connection, prefix: this.#prefix });
      this.#queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<T extends Record<string, unknown>>(
    queue: QueueName,
    data: T,
    options: JobOptions = {},
  ): Promise<string> {
    const jobOptions: JobsOptions = {
      attempts: options.attempts ?? this.#defaultAttempts,
      backoff: { type: 'exponential', delay: options.backoffMs ?? this.#defaultBackoffMs },
      // Keep a bounded history: enough to investigate, not enough to fill Redis.
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    };

    const job = await this.#queue(queue).add(queue, data, jobOptions);
    return String(job.id);
  }

  async process<T extends Record<string, unknown>>(
    queue: QueueName,
    handler: JobHandler<T>,
    options: { concurrency?: number } = {},
  ): Promise<void> {
    const worker = new Worker(
      queue,
      async (job) => {
        await handler({
          id: String(job.id),
          name: queue,
          data: job.data as T,
          attempt: job.attemptsMade + 1,
        });
      },
      {
        connection: this.#connection,
        prefix: this.#prefix,
        // Payout work is serialised elsewhere by row locks, so concurrency here
        // is about throughput, not correctness.
        concurrency: options.concurrency ?? 1,
      },
    );
    this.#workers.push(worker);
  }

  async depth(queue: QueueName): Promise<number> {
    const counts = await this.#queue(queue).getJobCounts('waiting', 'delayed', 'active');
    return (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0) + (counts['active'] ?? 0);
  }

  async close(): Promise<void> {
    await Promise.all(this.#workers.map((w) => w.close()));
    await Promise.all([...this.#queues.values()].map((q) => q.close()));
    this.#workers = [];
    this.#queues.clear();
  }
}
