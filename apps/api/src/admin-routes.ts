/**
 * Internal admin API — SPEC 117.70: /internal/admin/*.
 *
 * Separate from the merchant API in every way that matters:
 *  - a different credential (admin key, not a merchant API key)
 *  - a different identity table (core.admin_users)
 *  - permission-checked per route, and audited on every write
 *
 * A merchant credential can never reach these routes, because authentication
 * resolves against a table merchants have no rows in.
 */

import { randomUUID } from 'node:crypto';
import type { Router, RequestContext } from './http.ts';
import type { Container } from '../../../packages/core/src/container.ts';
import { verifyApiSecret, parseApiToken } from '../../../packages/crypto/src/index.ts';
import { AuthError, ValidationError, SecurityError } from '../../../packages/errors/src/index.ts';
import {
  assertPermission,
  isAdminRole,
  ROLE_PERMISSIONS,
  type AdminRole,
} from '../../../packages/core/src/admin/rbac.ts';
import {
  requestTreasuryFunding,
  approveTreasuryFunding,
  rejectApproval,
  freezeFinancialOperations,
  unfreezeFinancialOperations,
  suspendMerchant,
  activateMerchant,
  resolveException,
  isFinanciallyFrozen,
  type AdminActor,
} from '../../../packages/core/src/admin/operations.ts';
import { verifyGlobalBalance } from '../../../packages/ledger/src/ledger-service.ts';
import type { Database } from '../../../packages/database/src/client.ts';

/**
 * Authenticate an admin from `Authorization: Bearer <prefix>.<secret>`.
 *
 * Uses the same hashing as merchant keys, but resolves against
 * core.admin_users. A dummy comparison runs when the admin is unknown so the
 * response time does not reveal whether a prefix exists.
 */
async function authenticateAdmin(db: Database, ctx: RequestContext): Promise<AdminActor> {
  const header = ctx.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    throw new AuthError('MISSING_ADMIN_KEY', 'an admin credential is required');
  }

  let parsed: { prefix: string; secret: string };
  try {
    parsed = parseApiToken(header.slice(7).trim());
  } catch {
    throw new AuthError('INVALID_ADMIN_KEY', 'malformed admin credential');
  }

  const r = await db.query<{ id: string; role: string; status: string; secret_hash: string }>(
    'SELECT id, role, status, secret_hash FROM core.admin_users WHERE id::text = $1 OR email = $1',
    [parsed.prefix],
  );
  const admin = r.rows[0];

  if (!admin?.secret_hash) {
    // Constant-ish work for an unknown admin.
    verifyApiSecret(parsed.secret, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    throw new AuthError('INVALID_ADMIN_KEY', 'admin credential is invalid');
  }
  if (!verifyApiSecret(parsed.secret, admin.secret_hash)) {
    throw new AuthError('INVALID_ADMIN_KEY', 'admin credential is invalid');
  }
  if (admin.status !== 'ACTIVE') {
    throw new AuthError('ADMIN_NOT_ACTIVE', `admin account is ${admin.status}`);
  }
  if (!isAdminRole(admin.role)) {
    throw new SecurityError('UNKNOWN_ROLE', 'admin has an unrecognised role');
  }

  await db.query('UPDATE core.admin_users SET last_login_at = NOW() WHERE id = $1', [admin.id]);
  return { adminId: admin.id, role: admin.role };
}

export function registerAdminRoutes(router: Router, container: Container): void {
  const { db } = container;

  const auth = async (ctx: RequestContext): Promise<AdminActor> => {
    const actor = await authenticateAdmin(db, ctx);
    ctx.auth = { kind: 'ADMIN', userId: actor.adminId };
    return actor;
  };

  const body = (ctx: RequestContext): Record<string, unknown> => {
    if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) {
      throw new ValidationError('INVALID_BODY', 'a JSON object body is required');
    }
    return ctx.body as Record<string, unknown>;
  };

  const str = (o: Record<string, unknown>, k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || !v.trim()) {
      throw new ValidationError('MISSING_FIELD', `${k} is required`);
    }
    return v.trim();
  };

  // --- who am I -------------------------------------------------------------

  router.get('/internal/admin/me', async (ctx) => {
    const actor = await auth(ctx);
    return {
      status: 200,
      body: {
        admin_id: actor.adminId,
        role: actor.role,
        permissions: ROLE_PERMISSIONS[actor.role],
      },
    };
  });

  // --- platform overview ----------------------------------------------------

  router.get('/internal/admin/overview', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'ledger:read');

    const [merchants, payouts, treasury, exceptions, balance, frozen] = await Promise.all([
      db.query<{ status: string; count: string }>(
        'SELECT status, COUNT(*)::text AS count FROM core.merchants GROUP BY status',
      ),
      db.query<{ status: string; count: string; total: string }>(
        `SELECT status, COUNT(*)::text AS count, COALESCE(SUM(amount_toman),0)::text AS total
           FROM finance.payouts GROUP BY status`,
      ),
      db.query<Record<string, unknown>>(
        `SELECT id, asset, network, confirmed_balance_atomic::text, safety_reserve_atomic::text
           FROM finance.treasury_accounts`,
      ),
      db.query<{ severity: string; count: string }>(
        `SELECT severity, COUNT(*)::text AS count FROM system.reconciliation_exceptions
          WHERE status <> 'RESOLVED' GROUP BY severity`,
      ),
      db.transaction((tx) => verifyGlobalBalance(tx)),
      isFinanciallyFrozen(db),
    ]);

    return {
      status: 200,
      body: {
        financial_freeze: frozen,
        ledger_balanced: balance.balanced,
        ledger_by_currency: balance.byCurrency,
        merchants: merchants.rows,
        payouts: payouts.rows,
        treasury: treasury.rows,
        open_exceptions: exceptions.rows,
      },
    };
  });

  // --- merchants ------------------------------------------------------------

  router.get('/internal/admin/merchants', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'merchants:read');

    const limit = Math.min(Number.parseInt(ctx.query.get('limit') ?? '50', 10) || 50, 200);
    const r = await db.query<Record<string, unknown>>(
      `SELECT m.id, m.name, m.status, m.default_fee_mode, m.created_at,
              COALESCE(b.available::text,'0') AS available,
              COALESCE(b.pending::text,'0')   AS pending,
              COALESCE(b.settling::text,'0')  AS settling
         FROM core.merchants m
         LEFT JOIN finance.ledger_accounts a
                ON a.owner_type = 'MERCHANT' AND a.owner_id = m.id
         LEFT JOIN finance.balances b ON b.account_id = a.id
        ORDER BY m.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return { status: 200, body: { data: r.rows } };
  });

  router.post('/internal/admin/merchants/:id/suspend', async (ctx) => {
    const actor = await auth(ctx);
    await suspendMerchant(db, actor, ctx.params['id'] as string, str(body(ctx), 'reason'));
    return { status: 200, body: { status: 'SUSPENDED' } };
  });

  router.post('/internal/admin/merchants/:id/activate', async (ctx) => {
    const actor = await auth(ctx);
    await activateMerchant(db, actor, ctx.params['id'] as string, str(body(ctx), 'reason'));
    return { status: 200, body: { status: 'ACTIVE' } };
  });

  // --- treasury (four eyes) -------------------------------------------------

  router.get('/internal/admin/treasury', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'treasury:read');

    const accounts = await db.query<Record<string, unknown>>(
      `SELECT id, asset, network, address, confirmed_balance_atomic::text,
              safety_reserve_atomic::text, updated_at
         FROM finance.treasury_accounts`,
    );
    const reserved = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_atomic),0)::text AS total
         FROM finance.liquidity_reservations WHERE status = 'ACTIVE'`,
    );
    const recent = await db.query<Record<string, unknown>>(
      `SELECT id, direction, amount_atomic::text, source, status, external_tx_hash, confirmed_at
         FROM finance.treasury_transactions ORDER BY detected_at DESC LIMIT 25`,
    );

    return {
      status: 200,
      body: {
        accounts: accounts.rows,
        active_reservations_atomic: reserved.rows[0]?.total ?? '0',
        recent_transactions: recent.rows,
        // Stated explicitly so no operator ever expects an auto-buy button.
        funding_policy: 'MANUAL_ONLY',
      },
    };
  });

  router.post('/internal/admin/treasury/funding-requests', async (ctx) => {
    const actor = await auth(ctx);
    const b = body(ctx);
    const result = await requestTreasuryFunding(db, actor, {
      treasuryAccountId: str(b, 'treasury_account_id'),
      amountAtomic: str(b, 'amount_atomic'),
      txHash: str(b, 'tx_hash'),
      reason: str(b, 'reason'),
    });
    return {
      status: 201,
      body: {
        approval_id: result.approvalId,
        status: 'PENDING',
        note: 'a different admin must approve before the treasury is credited',
      },
    };
  });

  router.get('/internal/admin/approvals', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'treasury:read');

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, operation, payload, requested_by, approved_by, status, reason,
              created_at, decided_at, expires_at
         FROM core.admin_approvals ORDER BY created_at DESC LIMIT 50`,
    );
    return { status: 200, body: { data: r.rows } };
  });

  router.post('/internal/admin/approvals/:id/approve', async (ctx) => {
    const actor = await auth(ctx);
    const result = await approveTreasuryFunding(db, actor, ctx.params['id'] as string);
    return {
      status: 200,
      body: { status: 'EXECUTED', treasury_credited: result.recorded },
    };
  });

  router.post('/internal/admin/approvals/:id/reject', async (ctx) => {
    const actor = await auth(ctx);
    await rejectApproval(db, actor, ctx.params['id'] as string, str(body(ctx), 'reason'));
    return { status: 200, body: { status: 'REJECTED' } };
  });

  // --- financial freeze -----------------------------------------------------

  router.post('/internal/admin/platform/freeze', async (ctx) => {
    const actor = await auth(ctx);
    await freezeFinancialOperations(db, actor, str(body(ctx), 'reason'));
    return { status: 200, body: { financial_freeze: true } };
  });

  router.post('/internal/admin/platform/unfreeze', async (ctx) => {
    const actor = await auth(ctx);
    await unfreezeFinancialOperations(db, actor, str(body(ctx), 'reason'));
    return { status: 200, body: { financial_freeze: false } };
  });

  // --- reconciliation exceptions -------------------------------------------

  router.get('/internal/admin/exceptions', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'exceptions:read');

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, kind, severity, entity_type, entity_id, details, status, created_at
         FROM system.reconciliation_exceptions
        WHERE status <> 'RESOLVED'
        ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                               WHEN 'MEDIUM' THEN 2 ELSE 3 END, created_at DESC
        LIMIT 100`,
    );
    return { status: 200, body: { data: r.rows } };
  });

  router.post('/internal/admin/exceptions/:id/resolve', async (ctx) => {
    const actor = await auth(ctx);
    await resolveException(db, actor, ctx.params['id'] as string, str(body(ctx), 'resolution'));
    return { status: 200, body: { status: 'RESOLVED' } };
  });

  // --- payouts --------------------------------------------------------------

  router.get('/internal/admin/payouts', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'payouts:read');

    const status = ctx.query.get('status');
    const params: unknown[] = [];
    let where = '';
    if (status) {
      params.push(status);
      where = 'WHERE p.status = $1';
    }
    const r = await db.query<Record<string, unknown>>(
      `SELECT p.id, p.merchant_id, m.name AS merchant_name, p.status,
              p.amount_toman::text, p.gram_amount_atomic::text, p.rate::text,
              p.destination_address, p.transaction_hash, p.failure_code, p.created_at
         FROM finance.payouts p
         JOIN core.merchants m ON m.id = p.merchant_id
         ${where}
        ORDER BY p.created_at DESC LIMIT 100`,
      params,
    );
    return { status: 200, body: { data: r.rows } };
  });

  // --- audit trail ----------------------------------------------------------

  router.get('/internal/admin/audit', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'audit:read');

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, actor_type, actor_id, action, resource_type, resource_id,
              reason, metadata, created_at
         FROM audit.audit_logs ORDER BY created_at DESC LIMIT 100`,
    );
    return { status: 200, body: { data: r.rows } };
  });

  // --- admin management -----------------------------------------------------

  router.get('/internal/admin/admins', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'admins:manage');

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, name, email, telegram_user_id, role, status, last_login_at, created_at
         FROM core.admin_users ORDER BY created_at DESC`,
    );
    // secret_hash is never selected, so it can never be returned.
    return { status: 200, body: { data: r.rows } };
  });

  router.post('/internal/admin/admins', async (ctx) => {
    const actor = await auth(ctx);
    assertPermission(actor.role, 'admins:manage');

    const b = body(ctx);
    const role = str(b, 'role');
    if (!isAdminRole(role)) {
      throw new ValidationError('INVALID_ROLE', `unknown role: ${role}`);
    }

    const { generateApiKey } = await import('../../../packages/crypto/src/index.ts');
    const credential = generateApiKey();
    const id = randomUUID();

    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO core.admin_users (id, name, email, role, status, secret_hash)
         VALUES ($1,$2,$3,$4,'ACTIVE',$5)`,
        [id, str(b, 'name'), str(b, 'email'), role, credential.secretHash],
      );
      await tx.query(
        `INSERT INTO audit.audit_logs
            (id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1,'ADMIN',$2,'ADMIN_CREATED','ADMIN',$3,$4::jsonb)`,
        [randomUUID(), actor.adminId, id, JSON.stringify({ role })],
      );
    });

    return {
      status: 201,
      body: {
        id,
        role,
        // Shown exactly once; only the hash is stored.
        credential: `${id}.${credential.token.split('.')[1]}`,
        warning: 'store this credential now; it cannot be retrieved again',
      },
    };
  });
}
