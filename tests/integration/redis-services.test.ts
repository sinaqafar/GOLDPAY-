import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BullMqQueue } from '../../packages/queue/src/bullmq-queue.ts';
import { RedisRateLimiter, RATE_LIMITS, type RateLimitRule } from '../../packages/core/src/rate-limit.ts';
import { createRedisClient, closeRedisClient } from '../../packages/queue/src/redis-client.ts';
import type { RedisLike } from '../../packages/core/src/rate-limit.ts';

describe('Real Redis 7: BullMQ & Distributed Rate Limiting', () => {
  let redis: RedisLike;
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

  beforeAll(() => {
    redis = createRedisClient(redisUrl);
  });

  afterAll(async () => {
    await closeRedisClient();
  });

  describe('BullMQ on real Redis 7', () => {
    it('enqueues and processes a job across queues', async () => {
      const queue = new BullMqQueue({ redisUrl, prefix: `test-bmq-${Date.now()}` });
      const seen: string[] = [];

      await queue.process('webhook.delivery', async (job) => {
        seen.push((job.data as { id: string }).id);
      });

      await queue.enqueue('webhook.delivery', { id: 'evt-1' });

      for (let i = 0; i < 30; i++) {
        if (seen.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(seen).toEqual(['evt-1']);
      await queue.close();
    });

    it('deduplicates jobs when a deterministic jobId is used', async () => {
      const queue = new BullMqQueue({ redisUrl, prefix: `test-bmq-dedup-${Date.now()}` });
      let executions = 0;

      await queue.process('payout.selection', async () => {
        executions += 1;
      });

      await queue.enqueue('payout.selection', { payoutId: 'p-123' }, { jobId: 'payout-p-123' });
      await queue.enqueue('payout.selection', { payoutId: 'p-123' }, { jobId: 'payout-p-123' });

      for (let i = 0; i < 20; i++) {
        if (executions > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Give a moment to ensure no duplicate run happens
      await new Promise((r) => setTimeout(r, 300));
      expect(executions).toBe(1);
      await queue.close();
    });

    it('respects delayed jobs on Redis', async () => {
      const queue = new BullMqQueue({ redisUrl, prefix: `test-bmq-delay-${Date.now()}` });
      let executed = false;

      await queue.process('maintenance', async () => {
        executed = true;
      });

      await queue.enqueue('maintenance', { task: 'sweep' }, { delayMs: 10_000 });
      await new Promise((r) => setTimeout(r, 500));
      expect(executed).toBe(false);

      await queue.close();
    });
  });

  describe('RedisRateLimiter token bucket in Lua', () => {
    it('allows requests up to the burst limit and throttles excess', async () => {
      const limiter = new RedisRateLimiter({
        redis,
        prefix: `test-rl-${Date.now()}`,
      });

      const rule: RateLimitRule = { limit: 5, windowSeconds: 10, burst: 5 };
      const key = 'merchant-test-1';

      const results = [];
      for (let i = 0; i < 7; i++) {
        results.push(await limiter.check(key, rule));
      }

      const allowed = results.filter((r) => r.allowed);
      const blocked = results.filter((r) => !r.allowed);

      expect(allowed).toHaveLength(5);
      expect(blocked).toHaveLength(2);
      expect(blocked[0]?.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('enforces atomic concurrency in Lua with zero over-admission', async () => {
      const limiter = new RedisRateLimiter({
        redis,
        prefix: `test-rl-race-${Date.now()}`,
      });

      const rule: RateLimitRule = { limit: 10, windowSeconds: 60, burst: 10 };
      const key = 'concurrency-test';

      const promises = Array.from({ length: 25 }, () => limiter.check(key, rule));
      const decisions = await Promise.all(promises);

      const allowedCount = decisions.filter((d) => d.allowed).length;
      const blockedCount = decisions.filter((d) => !d.allowed).length;

      expect(allowedCount).toBe(10);
      expect(blockedCount).toBe(15);
    });

    it('fails open when Redis encounters an error and failOpen is true', async () => {
      const brokenRedis = {
        eval: async () => {
          throw new Error('Redis connection lost');
        },
      };

      const limiter = new RedisRateLimiter({
        redis: brokenRedis,
        failOpen: true,
      });

      const decision = await limiter.check('key', RATE_LIMITS['PUBLIC'] as RateLimitRule);
      expect(decision.allowed).toBe(true);
    });
  });
});
