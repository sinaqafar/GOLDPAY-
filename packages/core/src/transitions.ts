/**
 * State transition helpers.
 *
 * SPEC 118.52/118.53: a transition is a conditional UPDATE guarded by the
 * expected current state; `rows_affected = 0` means it did not happen.
 * SPEC 118.47/118.48: every transition is appended to an immutable log.
 */

import { randomUUID } from 'node:crypto';
import type { TransactionContext } from '../../database/src/client.ts';
import { StateTransitionError } from '../../errors/src/index.ts';

export interface TransitionRecord {
  entityType: string;
  entityId: string;
  fromState: string | null;
  event: string;
  toState: string;
  actorType?: 'SYSTEM' | 'MERCHANT' | 'ADMIN' | 'CUSTOMER' | 'WORKER' | 'PROVIDER';
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordTransition(
  tx: TransactionContext,
  record: TransitionRecord,
): Promise<void> {
  await tx.query(
    `INSERT INTO system.state_transitions
        (id, entity_type, entity_id, from_state, event, to_state, actor_type, actor_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      randomUUID(),
      record.entityType,
      record.entityId,
      record.fromState,
      record.event,
      record.toState,
      record.actorType ?? 'SYSTEM',
      record.actorId ?? null,
      JSON.stringify(record.metadata ?? {}),
    ],
  );
}

/**
 * Tables that may be driven by a guarded transition. Each must have `id`,
 * `status` and `updated_at` columns.
 */
const ALLOWED_TRANSITION_TABLES = new Set([
  'core.invoices',
  'core.payments',
  'core.merchants',
  'core.wallets',
  'finance.payouts',
]);

/**
 * Perform a guarded state transition.
 * The UPDATE only matches when the row is still in `fromState`, so two workers
 * racing on the same entity cannot both advance it.
 */
export async function transitionState(
  tx: TransactionContext,
  params: {
    table: string;
    entityType: string;
    entityId: string;
    fromState: string | readonly string[];
    toState: string;
    event: string;
    /** Extra `column = $n` assignments applied atomically with the transition. */
    extraSet?: Record<string, string | null>;
    actorType?: TransitionRecord['actorType'];
    actorId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  // The table name is interpolated, so it must be proven safe. Call sites are
  // all internal, but an allow-list means a future caller cannot turn this into
  // an injection point.
  if (!ALLOWED_TRANSITION_TABLES.has(params.table)) {
    throw new Error(`transitionState called with a non-allow-listed table: ${params.table}`);
  }

  const froms = Array.isArray(params.fromState) ? params.fromState : [params.fromState as string];

  const setParts: string[] = ["status = $1", 'updated_at = NOW()'];
  const values: unknown[] = [params.toState];
  let i = 2;

  for (const [column, value] of Object.entries(params.extraSet ?? {})) {
    // Column names come only from trusted call sites inside this package.
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
      throw new Error(`unsafe column name in transition: ${column}`);
    }
    setParts.push(`${column} = $${i}`);
    values.push(value);
    i++;
  }

  values.push(params.entityId);
  const idParam = i;
  i++;

  const fromPlaceholders = froms.map((_, idx) => `$${idParam + 1 + idx}`).join(',');
  values.push(...froms);

  const result = await tx.query(
    `UPDATE ${params.table}
        SET ${setParts.join(', ')}
      WHERE id = $${idParam}
        AND status IN (${fromPlaceholders})`,
    values,
  );

  if (result.rowCount === 0) {
    // SPEC 103951 — the entity was not in the expected state.
    throw new StateTransitionError(params.entityType, froms.join('|'), params.toState);
  }

  await recordTransition(tx, {
    entityType: params.entityType,
    entityId: params.entityId,
    fromState: froms.length === 1 ? (froms[0] as string) : froms.join('|'),
    event: params.event,
    toState: params.toState,
    actorType: params.actorType,
    actorId: params.actorId,
    metadata: params.metadata,
  });
}
