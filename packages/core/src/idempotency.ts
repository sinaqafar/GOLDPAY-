/**
 * Request-level idempotency with CAS lease reclamation and aggregate tracking.
 *
 * SPEC 118.71: the key is recorded before/with the operation.
 * SPEC 118.72: two concurrent requests with the same key produce exactly one DB
 * row and one financial effect.
 * SPEC 1234: repeated Pay clicks must not create a second invoice or credit.
 * SPEC v3.3: Stale IN_PROGRESS locks (>60s) automatically reclaimed with atomic CAS.
 * Retries never create orphan financial entities.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../../database/src/client.ts';
import { ConflictError, ValidationError } from '../../errors/src/index.ts';

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export type IdempotentOutcome<T> =
  | { status: 'EXECUTED'; value: T }
  | { status: 'REPLAYED'; value: T }
  | { status: 'IN_PROGRESS' };

export interface IdempotentRunOptions {
  namespace: string;
  key: string;
  requestHash: string;
  ttlSeconds?: number;
  leaseSeconds?: number;
  aggregateType?: string;
  aggregateId?: string;
}

export interface IdempotencyContext {
  setAggregate(type: string, id: string): Promise<void>;
  setProviderAttempt(attemptId: string): Promise<void>;
}

/**
 * Run `fn` at most once for a given (namespace, key) with lease management.
 */
export async function runIdempotent<T>(
  db: Database,
  params: IdempotentRunOptions,
  fn: (context?: IdempotencyContext) => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const { namespace, key, requestHash } = params;
  if (!key || key.length > 255) {
    throw new ValidationError('INVALID_IDEMPOTENCY_KEY', 'idempotency key must be 1..255 chars');
  }
  const ttl = params.ttlSeconds ?? 86_400;
  const leaseSeconds = params.leaseSeconds ?? 60;
  const ownerToken = randomUUID();

  // Try to insert new claim in integration.idempotency_keys
  const claim = await db.query<{ id: string }>(
    `INSERT INTO integration.idempotency_keys
        (id, namespace, idempotency_key, request_hash, state, owner_token, lease_until, expires_at, aggregate_type, aggregate_id)
     VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5, NOW() + ($6 || ' seconds')::interval, NOW() + ($7 || ' seconds')::interval, $8, $9)
     ON CONFLICT (namespace, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      namespace,
      key,
      requestHash,
      ownerToken,
      String(leaseSeconds),
      String(ttl),
      params.aggregateType ?? null,
      params.aggregateId ?? null,
    ],
  );

  let hasAcquiredLock = claim.rows.length > 0;

  if (!hasAcquiredLock) {
    const existing = await db.query<{
      request_hash: string;
      state: string;
      response_body: unknown;
      owner_token: string | null;
      lease_until: string | null;
      aggregate_type: string | null;
      aggregate_id: string | null;
    }>(
      `SELECT request_hash, state, response_body, owner_token, lease_until::text,
              aggregate_type, aggregate_id
         FROM integration.idempotency_keys
        WHERE namespace = $1 AND idempotency_key = $2`,
      [namespace, key],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new ConflictError('IDEMPOTENCY_RACE', 'idempotency key state is indeterminate');
    }
    if (row.request_hash !== requestHash) {
      throw new ConflictError(
        'IDEMPOTENCY_KEY_REUSE',
        'this idempotency key was already used with a different request body',
      );
    }
    if (row.state === 'COMPLETED') {
      const body =
        typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body;
      return { status: 'REPLAYED', value: body as T };
    }

    // Check if the in-progress lease has expired (>60s) and can be reclaimed
    const isLeaseExpired = row.lease_until ? new Date(row.lease_until).getTime() <= Date.now() : false;

    if (isLeaseExpired || row.state === 'FAILED') {
      // Atomic CAS lease reclaim
      const reclaim = await db.query<{ id: string }>(
        `UPDATE integration.idempotency_keys
            SET owner_token = $1,
                lease_until = NOW() + ($4 || ' seconds')::interval,
                state = 'IN_PROGRESS'
          WHERE namespace = $2
            AND idempotency_key = $3
            AND (lease_until <= NOW() OR state = 'FAILED')
          RETURNING id`,
        [ownerToken, namespace, key, String(leaseSeconds)],
      );

      if (reclaim.rows.length > 0) {
        hasAcquiredLock = true;
      } else {
        return { status: 'IN_PROGRESS' };
      }
    } else {
      return { status: 'IN_PROGRESS' };
    }
  }

  // Also mirror into system.idempotency_keys for backward compatibility
  await db.query(
    `INSERT INTO system.idempotency_keys (id, namespace, key, request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, 'IN_PROGRESS', NOW() + ($5 || ' seconds')::interval)
     ON CONFLICT (namespace, key) DO UPDATE
        SET state = 'IN_PROGRESS', expires_at = EXCLUDED.expires_at`,
    [randomUUID(), namespace, key, requestHash, String(ttl)],
  ).catch(() => undefined);

  let currentAggregateType = params.aggregateType;
  let currentAggregateId = params.aggregateId;

  const context: IdempotencyContext = {
    async setAggregate(type: string, id: string): Promise<void> {
      currentAggregateType = type;
      currentAggregateId = id;
      await db.query(
        `UPDATE integration.idempotency_keys
            SET aggregate_type = $3, aggregate_id = $4
          WHERE namespace = $1 AND idempotency_key = $2 AND owner_token = $5`,
        [namespace, key, type, id, ownerToken],
      );
    },
    async setProviderAttempt(attemptId: string): Promise<void> {
      await db.query(
        `UPDATE integration.idempotency_keys
            SET provider_attempt_id = $3
          WHERE namespace = $1 AND idempotency_key = $2 AND owner_token = $4`,
        [namespace, key, attemptId, ownerToken],
      );
    },
  };

  try {
    const value = await fn(context);

    await db.query(
      `UPDATE integration.idempotency_keys
          SET state = 'COMPLETED',
              response_body = $3::jsonb,
              response_status = 200,
              completed_at = NOW(),
              lease_until = NULL
        WHERE namespace = $1 AND idempotency_key = $2 AND owner_token = $4`,
      [namespace, key, JSON.stringify(value ?? null), ownerToken],
    );

    await db.query(
      `UPDATE system.idempotency_keys
          SET state = 'COMPLETED', response_body = $2::jsonb, response_status = 200, completed_at = NOW()
        WHERE namespace = $3 AND key = $1`,
      [key, JSON.stringify(value ?? null), namespace],
    ).catch(() => undefined);

    return { status: 'EXECUTED', value };
  } catch (e) {
    // If an aggregate was created (e.g. invoice created), NEVER delete the idempotency row!
    // Instead mark state FAILED and expire lease so subsequent retries can resume on the existing aggregate.
    await db.query(
      `UPDATE integration.idempotency_keys
          SET state = 'FAILED',
              lease_until = NOW()
        WHERE namespace = $1 AND idempotency_key = $2 AND owner_token = $3`,
      [namespace, key, ownerToken],
    ).catch(() => undefined);

    throw e;
  }
}

/** Housekeeping for expired keys and nonces. */
export async function purgeExpired(db: Database): Promise<{ keys: number; nonces: number }> {
  const keys = await db.query(
    'DELETE FROM integration.idempotency_keys WHERE expires_at IS NOT NULL AND expires_at < NOW()',
  );
  await db.query('DELETE FROM system.idempotency_keys WHERE expires_at IS NOT NULL AND expires_at < NOW()').catch(() => undefined);
  const nonces = await db.query('DELETE FROM system.request_nonces WHERE expires_at < NOW()');
  return { keys: keys.rowCount, nonces: nonces.rowCount };
}
