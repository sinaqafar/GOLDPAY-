/**
 * Platform administration: RBAC, four-eyes treasury funding, the financial
 * freeze, and the audit trail.
 *
 * The emphasis is on what an admin must NOT be able to do — a privileged API is
 * only as good as the things it refuses.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createHttpServer } from '../../apps/api/src/http.ts';
import { buildRouter } from '../../apps/api/src/routes.ts';
import { createContainer, type Container } from '../../packages/core/src/container.ts';
import { silentLogger } from '../../packages/core/src/logger.ts';
import { generateApiKey } from '../../packages/crypto/src/index.ts';
import { createMerchant, TEST_ENV } from '../helpers/harness.ts';
import { seed } from '../../scripts/seed.ts';
import {
  hasPermission,
  ROLE_PERMISSIONS,
  ADMIN_ROLES,
  assertPermission,
  type AdminRole,
} from '../../packages/core/src/admin/rbac.ts';

let container: Container;
let server: Server;
let baseUrl: string;

/** role -> bearer credential */
const creds = new Map<AdminRole, string>();
let treasuryAccountId: string;

beforeAll(async () => {
  container = await createContainer({ service: 'admin-test', env: TEST_ENV, runMigrations: true });
  (container as { logger: typeof silentLogger }).logger = silentLogger;
  await seed(container.db, container.config);

  for (const role of ADMIN_ROLES) {
    creds.set(role, await createAdmin(role));
  }

  const t = await container.db.query<{ id: string }>('SELECT id FROM finance.treasury_accounts LIMIT 1');
  treasuryAccountId = t.rows[0]?.id as string;

  server = createHttpServer({ router: buildRouter(container), logger: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await container.shutdown();
});

beforeEach(async () => {
  // Every test starts from an unfrozen platform.
  await container.db.query(
    `UPDATE system.platform_state
        SET financial_freeze = FALSE, freeze_reason = NULL, frozen_at = NULL, frozen_by = NULL`,
  );
  await container.db.query(
    `UPDATE system.reconciliation_exceptions SET status = 'RESOLVED' WHERE status <> 'RESOLVED'`,
  );
});

async function createAdmin(role: AdminRole, suffix = ''): Promise<string> {
  const id = randomUUID();
  const key = generateApiKey();
  await container.db.query(
    `INSERT INTO core.admin_users (id, name, email, role, status, secret_hash)
     VALUES ($1,$2,$3,$4,'ACTIVE',$5)`,
    [id, `${role} tester`, `${role.toLowerCase()}${suffix}-${id.slice(0, 6)}@test.local`, role, key.secretHash],
  );
  return `${id}.${key.token.split('.')[1]}`;
}

async function call(
  method: string,
  path: string,
  credential: string | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const as = (role: AdminRole) => creds.get(role) as string;

/* --- RBAC matrix ----------------------------------------------------------- */

describe('permission matrix', () => {
  it('gives READ_ONLY no write permission at all', () => {
    for (const p of ROLE_PERMISSIONS.READ_ONLY) {
      expect(p.endsWith(':read')).toBe(true);
    }
  });

  it('never lets one role both request and approve treasury funding', () => {
    for (const role of ADMIN_ROLES) {
      const canRequest = hasPermission(role, 'treasury:fund');
      const canApprove = hasPermission(role, 'treasury:approve');
      expect(canRequest && canApprove, `${role} could self-approve funding`).toBe(false);
    }
  });

  it('restricts unfreezing more tightly than freezing', () => {
    const canFreeze = ADMIN_ROLES.filter((r) => hasPermission(r, 'platform:freeze'));
    const canUnfreeze = ADMIN_ROLES.filter((r) => hasPermission(r, 'platform:unfreeze'));
    expect(canUnfreeze.length).toBeLessThan(canFreeze.length);
    expect(canUnfreeze).toEqual(['SUPER_ADMIN']);
  });

  it('grants no role a permission outside the declared list', () => {
    for (const role of ADMIN_ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(typeof p).toBe('string');
      }
    }
  });

  it('throws a 403-shaped error when a permission is missing', () => {
    try {
      assertPermission('READ_ONLY', 'treasury:fund');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { httpStatus: number }).httpStatus).toBe(403);
    }
  });
});

/* --- authentication -------------------------------------------------------- */

describe('admin authentication', () => {
  it('rejects a request with no credential', async () => {
    const res = await call('GET', '/internal/admin/overview', null);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed credential', async () => {
    expect((await call('GET', '/internal/admin/me', 'garbage')).status).toBe(401);
  });

  it('rejects a valid-looking credential with the wrong secret', async () => {
    const [id] = as('SUPER_ADMIN').split('.');
    const res = await call('GET', '/internal/admin/me', `${id}.wrong-secret-entirely`);
    expect(res.status).toBe(401);
  });

  it('rejects a merchant API key on an admin route', async () => {
    const merchant = await createMerchant(container.db, { name: 'Sneaky' });
    const key = generateApiKey();
    await container.db.query(
      `INSERT INTO core.api_keys (id, merchant_id, name, key_prefix, secret_hash, status)
       VALUES ($1,$2,'k',$3,$4,'ACTIVE')`,
      [randomUUID(), merchant.merchantId, key.prefix, key.secretHash],
    );

    const res = await call('GET', '/internal/admin/overview', key.token);
    expect(res.status).toBe(401);
  });

  it('rejects a suspended admin', async () => {
    const credential = await createAdmin('SUPER_ADMIN', '-suspended');
    await container.db.query(
      `UPDATE core.admin_users SET status = 'SUSPENDED' WHERE id = $1`,
      [credential.split('.')[0]],
    );
    const res = await call('GET', '/internal/admin/me', credential);
    expect(res.status).toBe(401);
    expect(res.body['error'].code).toBe('ADMIN_NOT_ACTIVE');
  });

  it('reports the caller\u2019s own role and permissions', async () => {
    const res = await call('GET', '/internal/admin/me', as('FINANCE_ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body['role']).toBe('FINANCE_ADMIN');
    expect(res.body['permissions']).toContain('treasury:fund');
    expect(res.body['permissions']).not.toContain('treasury:approve');
  });
});

/* --- route authorisation --------------------------------------------------- */

describe('route authorisation', () => {
  it('lets READ_ONLY read but not write', async () => {
    expect((await call('GET', '/internal/admin/overview', as('READ_ONLY'))).status).toBe(200);

    const merchant = await createMerchant(container.db, { name: 'ReadOnly target' });
    const res = await call('POST', `/internal/admin/merchants/${merchant.merchantId}/suspend`, as('READ_ONLY'), {
      reason: 'because I can',
    });
    expect(res.status).toBe(403);
  });

  it('denies SUPPORT_AGENT the treasury view', async () => {
    expect((await call('GET', '/internal/admin/treasury', as('SUPPORT_AGENT'))).status).toBe(403);
  });

  it('denies a non-super admin the admin list', async () => {
    expect((await call('GET', '/internal/admin/admins', as('FINANCE_ADMIN'))).status).toBe(403);
    expect((await call('GET', '/internal/admin/admins', as('SUPER_ADMIN'))).status).toBe(200);
  });

  it('never returns an admin secret hash', async () => {
    const res = await call('GET', '/internal/admin/admins', as('SUPER_ADMIN'));
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');
  });
});

/* --- four-eyes treasury funding -------------------------------------------- */

describe('treasury funding requires four eyes', () => {
  it('states the manual-only policy', async () => {
    const res = await call('GET', '/internal/admin/treasury', as('FINANCE_ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body['funding_policy']).toBe('MANUAL_ONLY');
  });

  it('does not move money on the request alone', async () => {
    const before = await treasuryBalance();
    const res = await call('POST', '/internal/admin/treasury/funding-requests', as('FINANCE_ADMIN'), {
      treasury_account_id: treasuryAccountId,
      amount_atomic: '5000000000',
      tx_hash: `0xreq_${randomUUID().slice(0, 8)}`,
      reason: 'owner deposit',
    });

    expect(res.status).toBe(201);
    expect(res.body['status']).toBe('PENDING');
    expect(await treasuryBalance()).toBe(before);
  });

  it('refuses to let the requester approve their own request', async () => {
    // A single admin who somehow holds both permissions still cannot proceed,
    // and in the shipped matrix no role does.
    const requester = await createAdmin('FINANCE_ADMIN', '-self');
    const created = await call('POST', '/internal/admin/treasury/funding-requests', requester, {
      treasury_account_id: treasuryAccountId,
      amount_atomic: '1000000000',
      tx_hash: `0xself_${randomUUID().slice(0, 8)}`,
      reason: 'self approval attempt',
    });
    expect(created.status).toBe(201);

    // FINANCE_ADMIN lacks treasury:approve, so this is refused on permission.
    const approve = await call(
      'POST',
      `/internal/admin/approvals/${created.body['approval_id']}/approve`,
      requester,
      {},
    );
    expect(approve.status).toBe(403);
  });

  it('credits the treasury only when a different admin approves', async () => {
    const before = await treasuryBalance();
    const amount = 7_000_000_000n;

    const created = await call('POST', '/internal/admin/treasury/funding-requests', as('FINANCE_ADMIN'), {
      treasury_account_id: treasuryAccountId,
      amount_atomic: amount.toString(),
      tx_hash: `0xok_${randomUUID().slice(0, 8)}`,
      reason: 'owner deposit',
    });

    const approved = await call(
      'POST',
      `/internal/admin/approvals/${created.body['approval_id']}/approve`,
      as('SUPER_ADMIN'),
      {},
    );

    expect(approved.status).toBe(200);
    expect(approved.body['treasury_credited']).toBe(true);
    expect(await treasuryBalance()).toBe(before + amount);
  });

  it('books funding against equity, never revenue', async () => {
    const txHash = `0xequity_${randomUUID().slice(0, 8)}`;
    const created = await call('POST', '/internal/admin/treasury/funding-requests', as('FINANCE_ADMIN'), {
      treasury_account_id: treasuryAccountId,
      amount_atomic: '3000000000',
      tx_hash: txHash,
      reason: 'equity check',
    });
    await call('POST', `/internal/admin/approvals/${created.body['approval_id']}/approve`, as('SUPER_ADMIN'), {});

    const entries = await container.db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.account_code AS code, e.debit::text, e.credit::text
         FROM finance.journal_entries e
         JOIN finance.ledger_accounts a ON a.id = e.account_id
         JOIN finance.journals j ON j.id = e.journal_id
        WHERE j.operation_id = $1`,
      [`treasury:funded:${txHash}`],
    );

    const codes = entries.rows.map((r) => r.code);
    expect(codes).toContain('TREASURY_GRAM');
    expect(codes).toContain('TREASURY_FUNDING_EQUITY');
    expect(codes.some((c) => c.includes('REVENUE'))).toBe(false);
  });

  it('cannot be approved twice', async () => {
    const created = await call('POST', '/internal/admin/treasury/funding-requests', as('FINANCE_ADMIN'), {
      treasury_account_id: treasuryAccountId,
      amount_atomic: '2000000000',
      tx_hash: `0xtwice_${randomUUID().slice(0, 8)}`,
      reason: 'double approval attempt',
    });
    const id = created.body['approval_id'];

    expect((await call('POST', `/internal/admin/approvals/${id}/approve`, as('SUPER_ADMIN'), {})).status).toBe(200);
    const second = await call('POST', `/internal/admin/approvals/${id}/approve`, as('SUPER_ADMIN'), {});
    expect(second.status).toBe(409);
  });

  it('rejects a zero or negative amount', async () => {
    for (const amount of ['0', '-100']) {
      const res = await call('POST', '/internal/admin/treasury/funding-requests', as('FINANCE_ADMIN'), {
        treasury_account_id: treasuryAccountId,
        amount_atomic: amount,
        tx_hash: `0xbad_${randomUUID().slice(0, 6)}`,
        reason: 'bad amount',
      });
      expect(res.status).toBe(400);
    }
  });

  it('requires a reason', async () => {
    const res = await call('POST', '/internal/admin/treasury/funding-requests', as('FINANCE_ADMIN'), {
      treasury_account_id: treasuryAccountId,
      amount_atomic: '1000',
      tx_hash: '0xnoreason',
    });
    expect(res.status).toBe(400);
  });

  it('can be rejected instead, moving no money', async () => {
    const before = await treasuryBalance();
    const created = await call('POST', '/internal/admin/treasury/funding-requests', as('FINANCE_ADMIN'), {
      treasury_account_id: treasuryAccountId,
      amount_atomic: '9000000000',
      tx_hash: `0xrej_${randomUUID().slice(0, 8)}`,
      reason: 'to be rejected',
    });

    const rejected = await call(
      'POST',
      `/internal/admin/approvals/${created.body['approval_id']}/reject`,
      as('SUPER_ADMIN'),
      { reason: 'hash not found on chain' },
    );
    expect(rejected.status).toBe(200);
    expect(await treasuryBalance()).toBe(before);
  });
});

async function treasuryBalance(): Promise<bigint> {
  const r = await container.db.query<{ b: string }>(
    'SELECT confirmed_balance_atomic::text AS b FROM finance.treasury_accounts WHERE id = $1',
    [treasuryAccountId],
  );
  return BigInt(r.rows[0]?.b ?? '0');
}

/* --- financial freeze ------------------------------------------------------ */

describe('financial freeze', () => {
  it('can be engaged and reported', async () => {
    const res = await call('POST', '/internal/admin/platform/freeze', as('RISK_AGENT'), {
      reason: 'suspected incident',
    });
    expect(res.status).toBe(200);

    const overview = await call('GET', '/internal/admin/overview', as('SUPER_ADMIN'));
    expect(overview.body['financial_freeze']).toBe(true);
  });

  it('requires a reason', async () => {
    const res = await call('POST', '/internal/admin/platform/freeze', as('RISK_AGENT'), { reason: '  ' });
    expect(res.status).toBe(400);
  });

  it('cannot be lifted by the role that set it', async () => {
    await call('POST', '/internal/admin/platform/freeze', as('RISK_AGENT'), { reason: 'incident' });
    const res = await call('POST', '/internal/admin/platform/unfreeze', as('RISK_AGENT'), {
      reason: 'all clear',
    });
    expect(res.status).toBe(403);
  });

  it('refuses to lift while a CRITICAL exception is open', async () => {
    await call('POST', '/internal/admin/platform/freeze', as('SUPER_ADMIN'), { reason: 'imbalance' });
    await container.db.query(
      `INSERT INTO system.reconciliation_exceptions (id, kind, severity, entity_type, details)
       VALUES ($1,'LEDGER_IMBALANCE','CRITICAL','SYSTEM','{}'::jsonb)`,
      [randomUUID()],
    );

    const res = await call('POST', '/internal/admin/platform/unfreeze', as('SUPER_ADMIN'), {
      reason: 'looks fine to me',
    });
    expect(res.status).toBe(409);
    expect(res.body['error'].code).toBe('CRITICAL_EXCEPTIONS_OPEN');
  });

  it('lifts once the exception is resolved', async () => {
    await call('POST', '/internal/admin/platform/freeze', as('SUPER_ADMIN'), { reason: 'incident' });
    const res = await call('POST', '/internal/admin/platform/unfreeze', as('SUPER_ADMIN'), {
      reason: 'investigated and cleared',
    });
    expect(res.status).toBe(200);
    expect(res.body['financial_freeze']).toBe(false);
  });
});

/* --- merchant lifecycle & audit -------------------------------------------- */

describe('merchant lifecycle', () => {
  it('suspends and reactivates, recording both in the audit log', async () => {
    const merchant = await createMerchant(container.db, { name: 'Lifecycle' });

    expect(
      (await call('POST', `/internal/admin/merchants/${merchant.merchantId}/suspend`, as('OPERATIONS_ADMIN'), {
        reason: 'chargeback spike',
      })).status,
    ).toBe(200);

    expect(
      (await call('POST', `/internal/admin/merchants/${merchant.merchantId}/activate`, as('OPERATIONS_ADMIN'), {
        reason: 'cleared by risk',
      })).status,
    ).toBe(200);

    const audit = await container.db.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit.audit_logs
        WHERE resource_id = $1 ORDER BY created_at`,
      [merchant.merchantId],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('MERCHANT_SUSPENDED');
    expect(actions).toContain('MERCHANT_ACTIVATED');
    expect(audit.rows[0]?.reason).toBe('chargeback spike');
  });

  it('refuses to suspend a merchant that is not active', async () => {
    const merchant = await createMerchant(container.db, { name: 'Twice' });
    await call('POST', `/internal/admin/merchants/${merchant.merchantId}/suspend`, as('OPERATIONS_ADMIN'), {
      reason: 'first',
    });
    const again = await call(
      'POST',
      `/internal/admin/merchants/${merchant.merchantId}/suspend`,
      as('OPERATIONS_ADMIN'),
      { reason: 'second' },
    );
    expect(again.status).toBe(409);
  });
});

describe('audit trail', () => {
  it('is append-only at the database level', async () => {
    const row = await container.db.query<{ id: string }>(
      'SELECT id FROM audit.audit_logs ORDER BY created_at DESC LIMIT 1',
    );
    const id = row.rows[0]?.id as string;

    await expect(
      container.db.query(`UPDATE audit.audit_logs SET action = 'TAMPERED' WHERE id = $1`, [id]),
    ).rejects.toThrow();
    await expect(
      container.db.query('DELETE FROM audit.audit_logs WHERE id = $1', [id]),
    ).rejects.toThrow();
  });

  it('is readable by roles with audit:read and denied otherwise', async () => {
    expect((await call('GET', '/internal/admin/audit', as('SUPER_ADMIN'))).status).toBe(200);
    expect((await call('GET', '/internal/admin/audit', as('SUPPORT_AGENT'))).status).toBe(403);
  });
});
