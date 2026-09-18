/**
 * In-memory QueuePort, for tests and single-process development.
 *
 * It models the behaviours that matter for correctness — job id deduplication,
 * delay, priority, retry with attempt counting, at-least-once delivery — so a
 * handler that is correct here is correct on BullMQ. What it deliberately does
 * NOT model is durability: nothing survives a restart, which is exactly why it
 * is not a production option.
 */

import { randomUUID } from 'node:crypto';
import type {
  QueuePort,
  QueueName,
  JobOptions,
  JobHandler,
  Job,
} from '../../core/src/ports/queue.ts';

interface Entry {
  id: string;
  queue: QueueName;
  data: Record<string, unknown>;
  availableAt: number;
  priority: number;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
}

export class InMemoryQueue implements QueuePort {
  readonly name = 'IN_MEMORY';
  #pending: Entry[] = [];
  #handlers = new Map<QueueName, JobHandler<never>>();
  #seenJobIds = new Set<string>();
  #dead: Entry[] = [];

  async enqueue<T extends Record<string, unknown>>(
    queue: QueueName,
    data: T,
    options: JobOptions = {},
  ): Promise<string> {
    const id = options.jobId ?? randomUUID();

    // Deduplicate exactly as BullMQ does on an explicit job id.
    if (options.jobId && this.#seenJobIds.has(options.jobId)) return options.jobId;
    this.#seenJobIds.add(id);

    this.#pending.push({
      id,
      queue,
      data,
      availableAt: Date.now() + (options.delayMs ?? 0),
      priority: options.priority ?? 0,
      attempts: 0,
      maxAttempts: options.attempts ?? 3,
      backoffMs: options.backoffMs ?? 0,
    });
    return id;
  }

  async process<T extends Record<string, unknown>>(
    queue: QueueName,
    handler: JobHandler<T>,
  ): Promise<void> {
    this.#handlers.set(queue, handler as unknown as JobHandler<never>);
  }

  async depth(queue: QueueName): Promise<number> {
    return this.#pending.filter((e) => e.queue === queue).length;
  }

  async close(): Promise<void> {
    this.#pending = [];
    this.#handlers.clear();
  }

  // ---- test controls ----

  /**
   * Run every job that is due, once. Returns how many were processed.
   * A failing job is retried until it exhausts its attempts, then dead-letters.
   */
  async drain(): Promise<number> {
    const now = Date.now();
    const due = this.#pending
      .filter((e) => e.availableAt <= now)
      .sort((a, b) => b.priority - a.priority || a.availableAt - b.availableAt);

    let processed = 0;
    for (const entry of due) {
      const handler = this.#handlers.get(entry.queue);
      if (!handler) continue;

      this.#pending = this.#pending.filter((e) => e !== entry);
      entry.attempts += 1;

      const job: Job = {
        id: entry.id,
        name: entry.queue,
        data: entry.data,
        attempt: entry.attempts,
      };

      try {
        await (handler as unknown as JobHandler)(job);
        processed += 1;
      } catch {
        if (entry.attempts >= entry.maxAttempts) {
          this.#dead.push(entry);
        } else {
          entry.availableAt = Date.now() + entry.backoffMs;
          this.#pending.push(entry);
        }
      }
    }
    return processed;
  }

  /** Jobs that exhausted their retries. */
  deadLettered(): readonly { id: string; queue: QueueName; attempts: number }[] {
    return this.#dead.map((e) => ({ id: e.id, queue: e.queue, attempts: e.attempts }));
  }
}
