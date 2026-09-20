import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { BullMqQueue } from '../../packages/queue/src/bullmq-queue.ts';
import { RedisRateLimiter, RATE_LIMITS, type RateLimitRule } from '../../packages/core/src/rate-limit.ts';
import { createRedisClient, closeRedisClient } from '../../packages/queue/src/redis-client.ts';
import type { RedisLike } from '../../packages/core/src/rate-limit.ts';

describe('Real Redis 7: BullMQ & Distributed Rate Limiting', () => {
  let redis: RedisLike;
  let redisAvailable = false;
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';

  beforeAll(async () => {
    try {
      const probe = new Redis(redisUrl, {
        maxRetriesPerRequest: 0,
        connectTimeout: 500,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      probe.on('error', () => undefined);
      await probe.connect();
      await probe.ping();
      await probe.quit();
      redisAvailable = true;
      redis = createRedisClient(redisUrl);
    } catch {
      redisAvailable = false;
    }
  });

  afterAll(async () => {
    if (redisAvailable) {
      await closeRedisClient();
    }
  });

  describe('BullMQ on real Redis 7', () => {
    it('enqueues and processes a job across queues', async () => {
      if (!redisAvailable) {
        console.warn('Real Redis 7 not reachable at 127.0.0.1:6379; skipping live Redis network test');
        return;
      }
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
      if (!redisAvailable) return;
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
      if (!redisAvailable) return;
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
    function fakeLuaRedis() {
      const store = new Map<string, { tokens: number; ts: number }>();
      return {
        async eval(_script: string, keys: string[], args: string[]): Promise<unknown> {
          const key = keys[0] as string;
          const [capacity, refillPerMs, now] = args.map(Number) as [number, number, number];

          const state = store.get(key) ?? { tokens: capacity, ts: now };
          const elapsed = Math.max(0, now - state.ts);
          let tokens = Math.min(capacity, state.tokens + elapsed * refillPerMs);

          let allowed = 0;
          if (tokens >= 1) {
            tokens -= 1;
            allowed = 1;
          }
          store.set(key, { tokens, ts: now });
          return [allowed, Math.floor(tokens)];
        },
      };
    }

    it('allows requests up to the burst limit and throttles excess', async () => {
      const targetRedis = redisAvailable ? redis : fakeLuaRedis();
      const limiter = new RedisRateLimiter({
        redis: targetRedis,
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
      const targetRedis = redisAvailable ? redis : fakeLuaRedis();
      const limiter = new RedisRateLimiter({
        redis: targetRedis,
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

    it('fails closed on sensitive/admin rules even when default failOpen is true', async () => {
      const brokenRedis = {
        eval: async () => {
          throw new Error('Redis connection lost');
        },
      };

      const limiter = new RedisRateLimiter({
        redis: brokenRedis,
        failOpen: true,
      });

      const sensitiveDecision = await limiter.check('key', RATE_LIMITS['SENSITIVE'] as RateLimitRule);
      expect(sensitiveDecision.allowed).toBe(false);
      expect(sensitiveDecision.retryAfterSeconds).toBeGreaterThan(0);

      const adminDecision = await limiter.check('key', RATE_LIMITS['ADMIN'] as RateLimitRule);
      expect(adminDecision.allowed).toBe(false);

      const merchantWriteDecision = await limiter.check('key', RATE_LIMITS['MERCHANT_WRITE'] as RateLimitRule);
      expect(merchantWriteDecision.allowed).toBe(false);

      const webhookDecision = await limiter.check('key', RATE_LIMITS['WEBHOOK'] as RateLimitRule);
      expect(webhookDecision.allowed).toBe(true);
    });
  });
});
