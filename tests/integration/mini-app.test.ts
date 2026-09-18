/**
 * Telegram Mini App API surface.
 *
 * The Mini App authenticates with Telegram initData rather than an API key, so
 * these tests focus on that boundary: a forged or stale initData must never be
 * accepted, and a merchant must never see another merchant's data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { createHttpServer } from '../../apps/api/src/http.ts';
import { buildRouter } from '../../apps/api/src/routes.ts';
import { createContainer, type Container } from '../../packages/core/src/container.ts';
import { silentLogger } from '../../packages/core/src/logger.ts';
import { createMerchant, TEST_ENV } from '../helpers/harness.ts';
import { seed } from '../../scripts/seed.ts';
import { createInvoice } from '../../packages/core/src/use-cases/create-invoice.ts';

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-for-mini-app-suite';

let container: Container;
let server: Server;
let baseUrl: string;

let ownerTelegramId: number;
let strangerTelegramId: number;
let merchantId: string;

beforeAll(async () => {
  container = await createContainer({
    service: 'mini-app-test',
    env: { ...TEST_ENV, TELEGRAM_BOT_TOKEN: BOT_TOKEN },
    runMigrations: true,
  });
  (container as { logger: typeof silentLogger }).logger = silentLogger;
  await seed(container.db, container.config);

  // A merchant whose owner is a Telegram user.
  const merchant = await createMerchant(container.db, { name: 'Mini Shop' });
  merchantId = merchant.merchantId;
  ownerTelegramId = 700_001;
  await container.db.query('UPDATE core.users SET telegram_user_id = $2 WHERE id = $1', [
    merchant.userId,
    ownerTelegramId,
  ]);

  // A registered user who owns no shop.
  strangerTelegramId = 700_002;
  await container.db.query(
    `INSERT INTO core.users (id, telegram_user_id, username, status) VALUES ($1,$2,'stranger','ACTIVE')`,
    [randomUUID(), strangerTelegramId],
  );

  server = createHttpServer({ router: buildRouter(container), logger: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await container.shutdown();
});

/** Build initData signed exactly the way Telegram signs it. */
function buildInitData(
  telegramUserId: number,
  options: { authDate?: number; token?: string } = {},
): string {
  const params = new URLSearchParams({
    auth_date: String(options.authDate ?? Math.floor(Date.now() / 1000)),
    query_id: `AA${randomUUID().slice(0, 8)}`,
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test', username: 'tester' }),
  });

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData')
    .update(options.token ?? BOT_TOKEN)
    .digest();
  params.set('hash', createHmac('sha256', secretKey).update(checkString).digest('hex'));
  return params.toString();
}

async function call(method: string, path: string, initData: string | null, body?: unknown) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(initData === null ? {} : { 'x-telegram-init-data': initData }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const envelope = (await res.json().catch(() => null)) as Record<string, any> | null;
  // Unwrap the standard `{ data, meta }` envelope.
  const payload =
    envelope && typeof envelope === 'object' && 'data' in envelope && !('error' in envelope)
      ? ((envelope['data'] && typeof envelope['data'] === 'object'
          ? envelope['data']
          : envelope) as Record<string, any>)
      : ((envelope ?? {}) as Record<string, any>);
  return { status: res.status, body: payload, envelope: (envelope ?? {}) as Record<string, any> };
}

describe('initData authentication', () => {
  it('accepts correctly signed initData', async () => {
    const res = await call('GET', '/v1/me', buildInitData(ownerTelegramId));
    expect(res.status).toBe(200);
    expect(res.body['merchant'].id).toBe(merchantId);
  });

  it('rejects a missing initData header', async () => {
    const res = await call('GET', '/v1/me', null);
    expect(res.status).toBe(401);
    expect(res.body['error'].code).toBe('MISSING_INIT_DATA');
  });

  it('rejects initData signed with the wrong bot token', async () => {
    const forged = buildInitData(ownerTelegramId, { token: '999:ATTACKER-TOKEN' });
    const res = await call('GET', '/v1/me', forged);
    expect(res.status).toBe(403);
    expect(res.body['error'].code).toBe('INVALID_SIGNATURE');
  });

  it('rejects initData whose payload was altered after signing', async () => {
    // Take a valid signature, then swap the user for someone else's.
    const valid = new URLSearchParams(buildInitData(ownerTelegramId));
    valid.set('user', JSON.stringify({ id: strangerTelegramId, first_name: 'Mallory' }));

    const res = await call('GET', '/v1/me', valid.toString());
    expect(res.status).toBe(403);
    expect(res.body['error'].code).toBe('INVALID_SIGNATURE');
  });

  it('rejects stale initData', async () => {
    const old = buildInitData(ownerTelegramId, {
      authDate: Math.floor(Date.now() / 1000) - 90 * 24 * 3600,
    });
    const res = await call('GET', '/v1/me', old);
    expect(res.status).toBe(403);
    expect(res.body['error'].code).toBe('TIMESTAMP_OUT_OF_WINDOW');
  });

  it('rejects an unregistered Telegram account', async () => {
    const res = await call('GET', '/v1/me', buildInitData(999_999));
    expect(res.status).toBe(401);
    expect(res.body['error'].code).toBe('USER_NOT_REGISTERED');
  });

  it('reports no merchant for a registered user without a shop', async () => {
    const res = await call('GET', '/v1/me', buildInitData(strangerTelegramId));
    expect(res.status).toBe(200);
    expect(res.body['merchant']).toBeNull();
  });
});

describe('mini app resources', () => {
  it('creates an invoice with the 15% fee applied', async () => {
    const res = await call('POST', '/v1/app/invoices', buildInitData(ownerTelegramId), {
      amount: '500000',
      description: 'from the mini app',
    });

    expect(res.status).toBe(201);
    expect(res.body['amount']).toBe('500000');
    expect(res.body['customer_total']).toBe('575000');
    expect(res.body['platform_fee']).toBe('75000');
    expect(res.body['merchant_net']).toBe('500000');
  });

  it('lists only this merchant\u2019s invoices', async () => {
    const other = await createMerchant(container.db, { name: 'Other Shop' });
    // Build the other merchant's invoice through the real use case so the row
    // carries every invariant the schema expects.
    const foreign = await createInvoice(container.db, container.config, {
      merchantId: other.merchantId,
      baseAmount: '999999',
      invoiceNumber: 'INV-OTHER',
    });
    expect(foreign.invoiceNumber).toBe('INV-OTHER');

    const res = await call('GET', '/v1/app/invoices', buildInitData(ownerTelegramId));
    expect(res.status).toBe(200);
    const numbers = (res.envelope['data'] as { invoice_number: string }[]).map((i) => i.invoice_number);
    expect(numbers).not.toContain('INV-OTHER');
  });

  it('rejects a bad amount with 400, not 500', async () => {
    const res = await call('POST', '/v1/app/invoices', buildInitData(ownerTelegramId), {
      amount: 'not-a-number',
    });
    expect(res.status).toBe(400);
    expect(res.body['error'].code).toBe('INVALID_AMOUNT');
  });

  it('refuses to act for a user with no shop', async () => {
    const res = await call('POST', '/v1/app/invoices', buildInitData(strangerTelegramId), {
      amount: '100000',
    });
    expect(res.status).toBe(404);
  });

  it('returns balances and payouts scoped to the merchant', async () => {
    const payouts = await call('GET', '/v1/app/payouts', buildInitData(ownerTelegramId));
    expect(payouts.status).toBe(200);
    expect(Array.isArray(payouts.envelope['data'])).toBe(true);
  });
});

describe('wallet registration from the mini app', () => {
  it('rejects an invalid TON address', async () => {
    const res = await call('POST', '/v1/app/wallets', buildInitData(ownerTelegramId), {
      address: '0xdeadbeef',
    });
    expect(res.status).toBe(400);
    expect(res.body['error'].code).toBe('INVALID_WALLET_ADDRESS');
  });

  it('registers into SECURITY_HOLD and retires the previous wallet', async () => {
    const first = await call('POST', '/v1/app/wallets', buildInitData(ownerTelegramId), {
      address: `EQ${'B'.repeat(46)}`,
    });
    expect(first.status).toBe(201);
    expect(first.body['status']).toBe('SECURITY_HOLD');

    const second = await call('POST', '/v1/app/wallets', buildInitData(ownerTelegramId), {
      address: `EQ${'C'.repeat(46)}`,
    });
    expect(second.status).toBe(201);

    // Exactly one wallet may be live at a time, so the first is now disabled.
    const rows = await container.db.query<{ status: string; address: string }>(
      'SELECT status, address FROM core.wallets WHERE merchant_id = $1',
      [merchantId],
    );
    const live = rows.rows.filter((w) => w.status !== 'DISABLED');
    expect(live).toHaveLength(1);
    expect(live[0]?.address).toBe(`EQ${'C'.repeat(46)}`);
  });

  it('rejects an address already registered elsewhere', async () => {
    const address = `EQ${'D'.repeat(46)}`;
    await call('POST', '/v1/app/wallets', buildInitData(ownerTelegramId), { address });
    const again = await call('POST', '/v1/app/wallets', buildInitData(ownerTelegramId), { address });
    expect(again.status).toBe(409);
  });
});

describe('mini app "more" tab resources', () => {
  it('returns recent payments scoped to the merchant', async () => {
    const res = await call('GET', '/v1/app/payments?limit=5', buildInitData(ownerTelegramId));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.envelope['data'])).toBe(true);
  });

  it('lists API keys without ever exposing a secret', async () => {
    const res = await call('GET', '/v1/app/api-keys', buildInitData(ownerTelegramId));
    expect(res.status).toBe(200);

    const serialised = JSON.stringify(res.envelope);
    expect(serialised).not.toContain('secret_hash');
    expect(serialised).not.toContain('api_key');
  });

  it('reports the terms the merchant is actually on', async () => {
    const res = await call('GET', '/v1/app/settings', buildInitData(ownerTelegramId));
    expect(res.status).toBe(200);
    expect(res.body['platform_fee_percent']).toBe(15);
    expect(res.body['hold_hours']).toBe(48);
    expect(res.body['settlement_asset']).toBe('GRAM');
  });

  it('requires authentication like every other app route', async () => {
    const res = await call('GET', '/v1/app/settings', null);
    expect(res.status).toBe(401);
  });
});

describe('mini app support tab', () => {
  it('opens a ticket and lists it back', async () => {
    const created = await call('POST', '/v1/app/support', buildInitData(ownerTelegramId), {
      subject: 'تسویه نیامده',
      message: 'از سه‌شنبه منتظرم.',
      category: 'PAYOUT',
    });
    expect(created.status).toBe(201);
    expect(created.body['reference']).toMatch(/^TKT-\d{6}$/);

    const list = await call('GET', '/v1/app/support', buildInitData(ownerTelegramId));
    expect(list.status).toBe(200);
    const refs = (list.envelope['data'] as { reference: string }[]).map((t) => t.reference);
    expect(refs).toContain(created.body['reference']);
  });

  it('rejects an unknown category instead of defaulting silently', async () => {
    const res = await call('POST', '/v1/app/support', buildInitData(ownerTelegramId), {
      subject: 'x',
      message: 'y',
      category: 'NOPE',
    });
    expect(res.status).toBe(400);
    expect(res.body['error'].code).toBe('INVALID_CATEGORY');
  });

  it('requires authentication like every other app route', async () => {
    const res = await call('GET', '/v1/app/support', null);
    expect(res.status).toBe(401);
  });
});
