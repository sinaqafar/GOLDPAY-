/**
 * Platform administration use cases.
 *
 * The rules that shape this file:
 *  - SPEC 119: manual treasury funding credits the treasury against EQUITY,
 *    never revenue, and is the only way GRAM enters the system.
 *  - Funding requires four eyes: one admin requests, a DIFFERENT admin
 *    approves. Only on approval does money move.
 *  - SPEC 119.58: a ledger imbalance is CRITICAL and freezes financial
 *    movement until a human clears it.
 *  - Every administrative act is written to the immutable audit log.
 */

import { randomUUID } from 'node:crypto';
import type { Database, TransactionContext } from '../../../database/src/client.ts';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  SecurityError,
} from '../../../errors/src/index.ts';
import { recordManualTreasuryFunding } from '../use-cases/payout.ts';
import { assertPermission, type AdminRole } from './rbac.ts';

export interface AdminActor {
  adminId: string;
  role: AdminRole;
}

const APPROVAL_TTL_MS = 24 * 3600 * 1000;

async function audit(
  tx: TransactionContext,
  params: {
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit.audit_logs
        (id, actor_type, actor_id, action, resource_type, resource_id, reason, metadata)
     VALUES ($1,'ADMIN',$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      randomUUID(),
      params.actorId,
      params.action,
      params.resourceType,
      params.resourceId ?? null,
      params.reason ?? null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
}

/* --- treasury funding (four eyes) ----------------------------------------- */

export interface FundingRequestInput {
  treasuryAccountId: string;
  amountAtomic: string;
  txHash: string;
  reason: string;
}

/**
 * Step 1 of 2. Records the INTENT to fund. No money moves here.
 */
export async function requestTreasuryFunding(
  db: Database,
  actor: AdminActor,
  input: FundingRequestInput,
): Promise<{ approvalId: string }> {
  assertPermission(actor.role, 'treasury:fund');

  if (!/^\d+$/.test(input.amountAtomic) || BigInt(input.amountAtomic) <= 0n) {
    throw new ValidationError('INVALID_FUNDING_AMOUNT', 'amount must be a positive integer string');
  }
  if (!input.txHash.trim()) {
    throw new ValidationError('MISSING_TX_HASH', 'the on-chain transaction hash is required');
  }
  if (!input.reason.trim()) {
    throw new ValidationError('MISSING_REASON', 'a reason is required for treasury funding');
  }

  const approvalId = randomUUID();
  await db.transaction(async (tx) => {
    const account = await tx.query('SELECT id FROM finance.treasury_accounts WHERE id = $1', [
      input.treasuryAccountId,
    ]);
    if (account.rows.length === 0) {
      throw new NotFoundError('treasury_account', input.treasuryAccountId);
    }

    await tx.query(
      `INSERT INTO core.admin_approvals
          (id, operation, payload, requested_by, status, reason, expires_at)
       VALUES ($1,'TREASURY_FUNDING',$2::jsonb,$3,'PENDING',$4,$5)`,
      [
        approvalId,
        JSON.stringify({
          treasuryAccountId: input.treasuryAccountId,
          amountAtomic: input.amountAtomic,
          txHash: input.txHash,
        }),
        actor.adminId,
        input.reason,
        new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      ],
    );

    await audit(tx, {
      actorId: actor.adminId,
      action: 'TREASURY_FUNDING_REQUESTED',
      resourceType: 'TREASURY',
      resourceId: input.treasuryAccountId,
      reason: input.reason,
      metadata: { approvalId, amount: input.amountAtomic, txHash: input.txHash },
    });
  });

  return { approvalId };
}

/**
 * Step 2 of 2. A different admin approves, and only then is the treasury
 * credited. The approval row is claimed with a conditional UPDATE so two
 * concurrent approvals cannot both execute the funding.
 */
export async function approveTreasuryFunding(
  db: Database,
  actor: AdminActor,
  approvalId: string,
): Promise<{ recorded: boolean }> {
  assertPermission(actor.role, 'treasury:approve');

  const payload = await db.transaction(async (tx) => {
    const found = await tx.query<{
      payload: Record<string, string>;
      requested_by: string;
      status: string;
      expires_at: string;
    }>(
      `SELECT payload, requested_by, status, expires_at
         FROM core.admin_approvals WHERE id = $1 AND operation = 'TREASURY_FUNDING' FOR UPDATE`,
      [approvalId],
    );
    const approval = found.rows[0];
    if (!approval) throw new NotFoundError('approval', approvalId);
    if (approval.status !== 'PENDING') {
      throw new ConflictError('APPROVAL_NOT_PENDING', `approval is already ${approval.status}`);
    }
    if (new Date(approval.expires_at).getTime() < Date.now()) {
      await tx.query(`UPDATE core.admin_approvals SET status = 'EXPIRED' WHERE id = $1`, [
        approvalId,
      ]);
      throw new ConflictError('APPROVAL_EXPIRED', 'this approval has expired');
    }
    // The heart of four-eyes. The database enforces it too, but failing here
    // gives a clear error instead of a constraint violation.
    if (approval.requested_by === actor.adminId) {
      throw new SecurityError(
        'FOUR_EYES_REQUIRED',
        'treasury funding must be approved by a different admin than the requester',
      );
    }

    const claimed = await tx.query(
      `UPDATE core.admin_approvals
          SET status = 'APPROVED', approved_by = $2, decided_at = NOW()
        WHERE id = $1 AND status = 'PENDING'`,
      [approvalId, actor.adminId],
    );
    if (claimed.rowCount !== 1) {
      throw new ConflictError('APPROVAL_RACE', 'this approval was decided concurrently');
    }

    await audit(tx, {
      actorId: actor.adminId,
      action: 'TREASURY_FUNDING_APPROVED',
      resourceType: 'TREASURY',
      resourceId: approval.payload['treasuryAccountId'] as string,
      metadata: { approvalId, requestedBy: approval.requested_by },
    });

    return approval.payload;
  });

  // The funding itself runs in its own transaction, and is idempotent on the
  // chain tx hash, so a crash between the two cannot double-credit.
  const result = await recordManualTreasuryFunding(db, {
    treasuryAccountId: payload['treasuryAccountId'] as string,
    amountAtomic: BigInt(payload['amountAtomic'] as string),
    txHash: payload['txHash'] as string,
    actorId: actor.adminId,
  });

  await db.query(`UPDATE core.admin_approvals SET status = 'EXECUTED' WHERE id = $1`, [approvalId]);
  return result;
}

export async function rejectApproval(
  db: Database,
  actor: AdminActor,
  approvalId: string,
  reason: string,
): Promise<void> {
  assertPermission(actor.role, 'treasury:approve');

  await db.transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE core.admin_approvals
          SET status = 'REJECTED', approved_by = $2, decided_at = NOW(), reason = $3
        WHERE id = $1 AND status = 'PENDING'`,
      [approvalId, actor.adminId, reason],
    );
    if (updated.rowCount !== 1) {
      throw new ConflictError('APPROVAL_NOT_PENDING', 'this approval is not pending');
    }
    await audit(tx, {
      actorId: actor.adminId,
      action: 'APPROVAL_REJECTED',
      resourceType: 'APPROVAL',
      resourceId: approvalId,
      reason,
    });
  });
}

/* --- financial freeze ------------------------------------------------------ */

export async function isFinanciallyFrozen(db: TransactionContext | Database): Promise<boolean> {
  const r = await db.query<{ financial_freeze: boolean }>(
    'SELECT financial_freeze FROM system.platform_state WHERE id = TRUE',
  );
  return r.rows[0]?.financial_freeze === true;
}

/**
 * Halt all financial movement. The worker checks this before advancing any
 * payout, so a freeze stops money leaving without stopping the process.
 */
export async function freezeFinancialOperations(
  db: Database,
  actor: AdminActor,
  reason: string,
): Promise<void> {
  assertPermission(actor.role, 'platform:freeze');
  if (!reason.trim()) {
    throw new ValidationError('MISSING_REASON', 'a freeze must record why it happened');
  }

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE system.platform_state
          SET financial_freeze = TRUE, freeze_reason = $1, frozen_by = $2,
              frozen_at = NOW(), updated_at = NOW()
        WHERE id = TRUE`,
      [reason, actor.adminId],
    );
    await audit(tx, {
      actorId: actor.adminId,
      action: 'FINANCIAL_FREEZE_ENABLED',
      resourceType: 'PLATFORM',
      reason,
    });
  });
}

export async function unfreezeFinancialOperations(
  db: Database,
  actor: AdminActor,
  reason: string,
): Promise<void> {
  // Deliberately narrower than freezing: many roles can stop the system in an
  // emergency, but only SUPER_ADMIN may start it moving again.
  assertPermission(actor.role, 'platform:unfreeze');

  await db.transaction(async (tx) => {
    // Refuse to resume while the ledger is still out of balance.
    const open = await tx.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM system.reconciliation_exceptions
        WHERE status <> 'RESOLVED' AND severity = 'CRITICAL'`,
    );
    if (Number.parseInt(open.rows[0]?.count ?? '0', 10) > 0) {
      throw new ConflictError(
        'CRITICAL_EXCEPTIONS_OPEN',
        'resolve all CRITICAL reconciliation exceptions before unfreezing',
      );
    }

    await tx.query(
      `UPDATE system.platform_state
          SET financial_freeze = FALSE, freeze_reason = NULL, frozen_by = NULL,
              frozen_at = NULL, updated_at = NOW()
        WHERE id = TRUE`,
    );
    await audit(tx, {
      actorId: actor.adminId,
      action: 'FINANCIAL_FREEZE_LIFTED',
      resourceType: 'PLATFORM',
      reason,
    });
  });
}

/* --- merchant lifecycle ---------------------------------------------------- */

export async function suspendMerchant(
  db: Database,
  actor: AdminActor,
  merchantId: string,
  reason: string,
): Promise<void> {
  assertPermission(actor.role, 'merchants:suspend');
  if (!reason.trim()) {
    throw new ValidationError('MISSING_REASON', 'a suspension must record why it happened');
  }

  await db.transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE core.merchants SET status = 'SUSPENDED', updated_at = NOW()
        WHERE id = $1 AND status = 'ACTIVE'`,
      [merchantId],
    );
    if (updated.rowCount !== 1) {
      throw new ConflictError('MERCHANT_NOT_ACTIVE', 'merchant is not ACTIVE');
    }
    await audit(tx, {
      actorId: actor.adminId,
      action: 'MERCHANT_SUSPENDED',
      resourceType: 'MERCHANT',
      resourceId: merchantId,
      reason,
    });
  });
}

export async function activateMerchant(
  db: Database,
  actor: AdminActor,
  merchantId: string,
  reason: string,
): Promise<void> {
  assertPermission(actor.role, 'merchants:activate');

  await db.transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE core.merchants SET status = 'ACTIVE', updated_at = NOW()
        WHERE id = $1 AND status IN ('SUSPENDED','PENDING','REVIEW')`,
      [merchantId],
    );
    if (updated.rowCount !== 1) {
      throw new ConflictError('MERCHANT_NOT_ACTIVATABLE', 'merchant cannot be activated');
    }
    await audit(tx, {
      actorId: actor.adminId,
      action: 'MERCHANT_ACTIVATED',
      resourceType: 'MERCHANT',
      resourceId: merchantId,
      reason,
    });
  });
}

/* --- reconciliation exceptions --------------------------------------------- */

export async function resolveException(
  db: Database,
  actor: AdminActor,
  exceptionId: string,
  resolution: string,
): Promise<void> {
  assertPermission(actor.role, 'exceptions:resolve');
  if (!resolution.trim()) {
    throw new ValidationError('MISSING_RESOLUTION', 'describe how the exception was resolved');
  }

  await db.transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE system.reconciliation_exceptions
          SET status = 'RESOLVED', resolved_at = NOW()
        WHERE id = $1 AND status <> 'RESOLVED'`,
      [exceptionId],
    );
    if (updated.rowCount !== 1) {
      throw new ConflictError('EXCEPTION_NOT_OPEN', 'this exception is not open');
    }
    await audit(tx, {
      actorId: actor.adminId,
      action: 'EXCEPTION_RESOLVED',
      resourceType: 'EXCEPTION',
      resourceId: exceptionId,
      reason: resolution,
    });
  });
}
