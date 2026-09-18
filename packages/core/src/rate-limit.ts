/**
 * Rate limiting — SPEC 253 / 97.
 *
 * A fixed window is the wrong shape here: a caller can spend the whole budget
 * in the last instant of one window and the whole budget in the first instant
 * of the next, doubling the intended rate exactly at the boundary. This uses a
 * token bucket, which refills continuously, so the sustained rate is honoured
 * while a short burst is still allowed.
 *
 * Two implementations behind one interface:
 *
 *   TokenBucketRateLimiter  in-process, correct for a single instance
 *   RedisRateLimiter        shared, correct across a fleet
 *
 * The in-process one is NOT correct across several instances: with N of them
 * the effective limit is N times higher. Production runs Redis anyway for the
 * queue, so the composition root uses the shared limiter and keeps the local
 * one for tests and single-process development.
 *
 * Rate limiting is a courtesy control, never a security boundary. Authorisation
 * and the financial invariants must hold even when every request is allowed
 * through (SPEC 7245).
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still available in the current bucket. */
  remaining: number;
  /** Seconds until the caller may retry, when blocked. */
  retryAfterSeconds: number;
  limit: number;
}

export interface RateLimitRule {
  /** Sustained requests per window. */
  limit: number;
  windowSeconds: number;
  /**
   * Maximum burst above the sustained rate. Defaults to the limit itself,
   * which is a full window's worth.
   */
  burst?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketRateLimiter {
  #buckets = new Map<string, Bucket>();
  #now: () => number;
  #lastSweepMs = 0;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Consume one token for `key`.
   * Keys must be scoped by caller AND route class, so a merchant hammering one
   * endpoint cannot exhaust their budget for every other endpoint.
   */
  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = this.#now();
    const capacity = rule.burst ?? rule.limit;
    const refillPerMs = rule.limit / (rule.windowSeconds * 1000);

    this.#sweep(now);

    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: now };
      this.#buckets.set(key, bucket);
    }

    // Continuous refill, capped at capacity.
    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillMs = now;

    if (bucket.tokens < 1) {
      const needMs = (1 - bucket.tokens) / refillPerMs;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(needMs / 1000)),
        limit: rule.limit,
      };
    }

    bucket.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterSeconds: 0,
      limit: rule.limit,
    };
  }

  /** Drop buckets that have been idle long enough to be full again. */
  #sweep(now: number): void {
    if (now - this.#lastSweepMs < 60_000) return;
    this.#lastSweepMs = now;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.lastRefillMs > 600_000) this.#buckets.delete(key);
    }
  }

  reset(): void {
    this.#buckets.clear();
  }
}

/**
 * Per-route-class limits.
 *
 * Unauthenticated and credential-adjacent routes are tightest, because those
 * are what a brute-force attempt targets. Read endpoints are loosest.
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  /** Anonymous callers, identified only by IP. */
  PUBLIC: { limit: 60, windowSeconds: 60 },
  /** Authenticated merchant API. SPEC 253: 100 req/min. */
  MERCHANT: { limit: 100, windowSeconds: 60, burst: 120 },
  /** Creating money-moving resources. */
  MERCHANT_WRITE: { limit: 30, windowSeconds: 60 },
  /** Credential issuance and revocation. */
  SENSITIVE: { limit: 5, windowSeconds: 60 },
  /** Provider callbacks: generous, since the provider retries legitimately. */
  WEBHOOK: { limit: 300, windowSeconds: 60 },
  /** Admin operations. */
  ADMIN: { limit: 120, windowSeconds: 60 },
};

/** Pick the rule for a request. */
export function ruleFor(method: string, path: string): { name: string; rule: RateLimitRule } {
  if (path.startsWith('/v1/webhooks/')) return { name: 'WEBHOOK', rule: RATE_LIMITS['WEBHOOK'] as RateLimitRule };
  if (path.startsWith('/internal/admin')) return { name: 'ADMIN', rule: RATE_LIMITS['ADMIN'] as RateLimitRule };
  if (path.startsWith('/v1/api-keys')) return { name: 'SENSITIVE', rule: RATE_LIMITS['SENSITIVE'] as RateLimitRule };
  if (path.startsWith('/v1/wallets') && method !== 'GET') {
    return { name: 'SENSITIVE', rule: RATE_LIMITS['SENSITIVE'] as RateLimitRule };
  }
  if (method !== 'GET' && path.startsWith('/v1/')) {
    return { name: 'MERCHANT_WRITE', rule: RATE_LIMITS['MERCHANT_WRITE'] as RateLimitRule };
  }
  if (path.startsWith('/v1/')) return { name: 'MERCHANT', rule: RATE_LIMITS['MERCHANT'] as RateLimitRule };
  return { name: 'PUBLIC', rule: RATE_LIMITS['PUBLIC'] as RateLimitRule };
}

/**
 * The shape both limiters satisfy, so the HTTP layer does not care which it has.
 */
export interface RateLimiter {
  check(key: string, rule: RateLimitRule): RateLimitDecision | Promise<RateLimitDecision>;
}

/** Minimal Redis surface, so this package does not depend on a client library. */
export interface RedisLike {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * Token bucket in Redis, refilled in Lua.
 *
 * The whole read-refill-decrement must be atomic or two instances racing on the
 * same key would each see the pre-decrement value and both allow the request —
 * which is exactly the over-admission this limiter exists to prevent. A Lua
 * script runs as a single Redis operation, so the race cannot occur.
 */
const BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * refill_per_ms)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, ttl)

return { allowed, math.floor(tokens) }
`;

export class RedisRateLimiter implements RateLimiter {
  #redis: RedisLike;
  #prefix: string;
  #now: () => number;
  /** When Redis is unreachable: allow (open) or refuse (closed). */
  #failOpen: boolean;

  constructor(options: {
    redis: RedisLike;
    prefix?: string;
    now?: () => number;
    failOpen?: boolean;
  }) {
    this.#redis = options.redis;
    this.#prefix = options.prefix ?? 'rl';
    this.#now = options.now ?? (() => Date.now());
    // Rate limiting is a courtesy control, not a security boundary
    // (SPEC 7245): authorisation and the financial invariants hold regardless.
    // Refusing all traffic because the limiter is down would turn a Redis
    // blip into a full outage, so the default is to allow.
    this.#failOpen = options.failOpen ?? true;
  }

  async check(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const capacity = rule.burst ?? rule.limit;
    const refillPerMs = rule.limit / (rule.windowSeconds * 1000);
    const ttl = Math.ceil(rule.windowSeconds * 1000 * 2);

    try {
      const result = (await this.#redis.eval(
        BUCKET_SCRIPT,
        [`${this.#prefix}:${key}`],
        [String(capacity), String(refillPerMs), String(this.#now()), String(ttl)],
      )) as [number, number];

      const allowed = Number(result?.[0]) === 1;
      const remaining = Number(result?.[1] ?? 0);

      return {
        allowed,
        remaining: allowed ? remaining : 0,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(1 / (refillPerMs * 1000))),
        limit: rule.limit,
      };
    } catch {
      if (!this.#failOpen) {
        return { allowed: false, remaining: 0, retryAfterSeconds: 1, limit: rule.limit };
      }
      return { allowed: true, remaining: capacity, retryAfterSeconds: 0, limit: rule.limit };
    }
  }
}
