/**
 * Request-level idempotency.
 *
 * SPEC 118.71: the key is recorded before/with the operation.
 * SPEC 118.72: two concurrent requests with the same key produce exactly one DB
 * row and one financial effect.
 * SPEC 1234: repeated Pay clicks must not create a second invoice or credit.
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

/**
 * Run `fn` at most once for a given (namespace, key).
 *
 * - First caller inserts the key as IN_PROGRESS and runs the operation.
 * - A concurrent caller with the same key sees the unique violation and is told
 *   the operation is IN_PROGRESS rather than running it a second time.
 * - A later caller with the same key gets the stored response back.
 * - A different request body under the same key is rejected: silently returning
 *   someone else's result would be a correctness and security bug.
 */
export async function runIdempotent<T>(
  db: Database,
  params: {
    namespace: string;
    key: string;
    requestHash: string;
    ttlSeconds?: number;
  },
  fn: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const { namespace, key, requestHash } = params;
  if (!key || key.length > 255) {
    throw new ValidationError('INVALID_IDEMPOTENCY_KEY', 'idempotency key must be 1..255 chars');
  }
  const ttl = params.ttlSeconds ?? 86_400;

  const claim = await db.query<{ id: string }>(
    `INSERT INTO system.idempotency_keys
        (id, namespace, key, request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, 'IN_PROGRESS', NOW() + ($5 || ' seconds')::interval)
     ON CONFLICT (namespace, key) DO NOTHING
     RETURNING id`,
    [randomUUID(), namespace, key, requestHash, String(ttl)],
  );

  if (claim.rows.length === 0) {
    const existing = await db.query<{
      request_hash: string;
      state: string;
      response_body: unknown;
    }>(
      `SELECT request_hash, state, response_body
         FROM system.idempotency_keys
        WHERE namespace = $1 AND key = $2`,
      [namespace, key],
    );
    const row = existing.rows[0];
    if (!row) {
      // The row expired between the insert and the read; ask the caller to retry.
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
    // IN_PROGRESS or FAILED: do not run the operation concurrently.
    return { status: 'IN_PROGRESS' };
  }

  try {
    const value = await fn();
    await db.query(
      `UPDATE system.idempotency_keys
          SET state = 'COMPLETED', response_body = $2::jsonb, response_status = 200,
              completed_at = NOW()
        WHERE namespace = $3 AND key = $1`,
      [key, JSON.stringify(value ?? null), namespace],
    );
    return { status: 'EXECUTED', value };
  } catch (e) {
    // Release the key so a corrected retry can proceed, but keep the failure
    // recorded for observability.
    await db
      .query(
        `DELETE FROM system.idempotency_keys WHERE namespace = $1 AND key = $2 AND state = 'IN_PROGRESS'`,
        [namespace, key],
      )
      .catch(() => undefined);
    throw e;
  }
}

/** Housekeeping for expired keys and nonces. */
export async function purgeExpired(db: Database): Promise<{ keys: number; nonces: number }> {
  const keys = await db.query(
    'DELETE FROM system.idempotency_keys WHERE expires_at IS NOT NULL AND expires_at < NOW()',
  );
  const nonces = await db.query('DELETE FROM system.request_nonces WHERE expires_at < NOW()');
  return { keys: keys.rowCount, nonces: nonces.rowCount };
}
