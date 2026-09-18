/**
 * A single shared Redis connection for non-queue use.
 *
 * BullMQ manages its own connections with settings it requires; this is for
 * everything else that needs Redis — currently the distributed rate limiter.
 * Reusing BullMQ's connection would risk one subsystem's settings breaking the
 * other, so they stay separate.
 *
 * `ioredis` ships as a BullMQ dependency, so this adds nothing new to install.
 */

import { Redis } from 'ioredis';
import type { RedisLike } from '../../core/src/rate-limit.ts';

let shared: Redis | null = null;

export function createRedisClient(url: string): RedisLike {
  if (!shared) {
    shared = new Redis(url, {
      // The limiter must not queue commands while disconnected: a request
      // waiting on a rate-limit check is a request not being served. Failing
      // fast lets the limiter fall open instead.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });

    // A limiter outage must never take the API down with it.
    shared.on('error', () => undefined);
  }

  const client = shared;
  return {
    async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
      return client.eval(script, keys.length, ...keys, ...args);
    },
  };
}

/** Close the shared connection, for graceful shutdown. */
export async function closeRedisClient(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => undefined);
    shared = null;
  }
}
