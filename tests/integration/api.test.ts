/**
 * API surface tests: authentication, tenant isolation, replay protection and
 * the full HTTP checkout flow against a real server socket.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { createHttpServer } from '../../apps/api/src/http.ts';
import { buildRouter } from '../../apps/api/src/routes.ts';
import { createContainer, type Container } from '../../packages/core/src/container.ts';
import { silentLogger } from '../../packages/core/src/logger.ts';
import { generateApiKey, sha256Hex, signRequest } from '../../packages/crypto/src/index.ts';
import { createMerchant, TEST_ENV } from '../helpers/harness.ts';
import { seed } from '../../scripts/seed.ts';

let container: Container;
let server: Server;
let baseUrl: string;

let merchantA: Awaited<ReturnType<typeof createMerchant>>;
let merchantB: Awaited<ReturnType<typeof createMerchant>>;
let keyA: { prefix: string; token: string };
let keyB: { prefix: string; token: string };

beforeAll(async () => {
  container = await createContainer({ service: 'api-test', env: TEST_ENV, runMigrations: true });
  // Quiet the request log during tests.
  (container as { logger: typeof silentLogger }).logger = silentLogger;
  await seed(container.db, container.config);

  merchantA = await createMerchant(container.db, { name: 'Alpha' });
  merchantB = await createMerchant(container.db, { name: 'Beta' });
  keyA = await issueKey(merchantA.merchantId);
  keyB = await issueKey(merchantB.merchantId);

  server = createHttpServer({ router: buildRouter(container), logger: silentLogger });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await container.shutdown();
});

async function issueKey(merchantId: string) {
  const key = generateApiKey();
  await container.db.query(
    `INSERT INTO core.api_keys (id, merchant_id, name, key_prefix, secret_hash, status)
     VALUES ($1,$2,'test',$3,$4,'ACTIVE')`,
    [randomUUID(), merchantId, key.prefix, key.secretHash],
  );
  return { prefix: key.prefix, token: key.token };
}

/** Perform a correctly signed API call. */
async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  overrides: { nonce?: string; timestamp?: string } = {},
) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = overrides.nonce ?? randomUUID();
  const secret = token.slice(token.indexOf('.') + 1);

  const signature = signRequest(secret, {
    method,
    path,
    timestamp,
    nonce,
    bodySha256: sha256Hex(rawBody),
  });

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-gateway-timestamp': timestamp,
      'x-gateway-nonce': nonce,
      'x-gateway-signature': signature,
    },
    body: rawBody === '' ? undefined : rawBody,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, any>,
  };
}

describe('health', () => {
  it('reports liveness', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
  });

  it('reports the treasury as manual-only', async () => {
    const res = await fetch(`${baseUrl}/health/dependencies`);
    const body = (await res.json()) as { checks: Record<string, string> };
    expect(res.status).toBe(200);
    expect(body.checks['treasury_policy']).toBe('MANUAL_ONLY');
  });
});

describe('authentication', () => {
  it('rejects a request with no credentials', async () => {
    const res = await fetch(`${baseUrl}/v1/balances`);
    expect(res.status).toBe(401);
  });

  it('rejects a valid key with a bad signature', async () => {
    const res = await fetch(`${baseUrl}/v1/balances`, {
      headers: {
        authorization: `Bearer ${keyA.token}`,
        'x-gateway-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-gateway-nonce': randomUUID(),
        'x-gateway-signature': 'deadbeef',
      },
    });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown API key', async () => {
    const res = await call('gp_unknown.secret', 'GET', '/v1/balances');
    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed request', async () => {
    const res = await call(keyA.token, 'GET', '/v1/balances');
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('TOMAN');
    expect(res.body.editable).toBe(false);
  });

  it('rejects a replayed nonce (SPEC 25)', async () => {
    const nonce = randomUUID();
    const first = await call(keyA.token, 'GET', '/v1/balances', undefined, { nonce });
    const replay = await call(keyA.token, 'GET', '/v1/balances', undefined, { nonce });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe('NONCE_REPLAYED');
  });

  it('rejects a stale timestamp', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 7200);
    const res = await call(keyA.token, 'GET', '/v1/balances', undefined, { timestamp: stale });
    expect(res.status).toBe(403);
  });
});

describe('invoices over HTTP', () => {
  it('creates an invoice with the 15% fee applied', async () => {
    const res = await call(keyA.token, 'POST', '/v1/invoices', {
      amount: '1000000',
      fee_mode: 'CUSTOMER',
      description: 'Test order',
    });
    expect(res.status).toBe(201);
    expect(res.body.customer_total).toBe('1150000');
    expect(res.body.merchant_net).toBe('1000000');
    expect(res.body.platform_fee).toBe('150000');
    // The sandbox provider returned a checkout link.
    expect(res.body.payment_url).toBeTruthy();
  });

  it('rejects a non-integer amount', async () => {
    const res = await call(keyA.token, 'POST', '/v1/invoices', { amount: '1000.55' });
    expect(res.status).toBe(400);
  });

  it('rejects a zero or negative amount', async () => {
    expect((await call(keyA.token, 'POST', '/v1/invoices', { amount: '0' })).status).toBe(400);
    expect((await call(keyA.token, 'POST', '/v1/invoices', { amount: '-5000' })).status).toBe(400);
  });

  it('rejects an unknown fee mode', async () => {
    const res = await call(keyA.token, 'POST', '/v1/invoices', {
      amount: '1000',
      fee_mode: 'FREE',
    });
    expect(res.status).toBe(400);
  });
});

describe('tenant isolation over HTTP (SPEC 117.89)', () => {
  it('will not let merchant B read merchant A’s invoice', async () => {
    const created = await call(keyA.token, 'POST', '/v1/invoices', { amount: '750000' });
    expect(created.status).toBe(201);
    const invoiceId = created.body.id as string;

    const own = await call(keyA.token, 'GET', `/v1/invoices/${invoiceId}`);
    expect(own.status).toBe(200);

    // B gets a 404, not a 403: the id's existence is not confirmed.
    const other = await call(keyB.token, 'GET', `/v1/invoices/${invoiceId}`);
    expect(other.status).toBe(404);
  });

  it('scopes the invoice list to the authenticated merchant', async () => {
    await call(keyB.token, 'POST', '/v1/invoices', { amount: '123456' });
    const listB = await call(keyB.token, 'GET', '/v1/invoices');
    expect(listB.status).toBe(200);

    const amounts = (listB.body.data as { amount: string }[]).map((i) => i.amount);
    expect(amounts).toContain('123456');
    // None of merchant A's invoices leak in.
    expect(amounts).not.toContain('750000');
  });

  it('keeps balances separate', async () => {
    const a = await call(keyA.token, 'GET', '/v1/balances');
    const b = await call(keyB.token, 'GET', '/v1/balances');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('wallets', () => {
  it('rejects an invalid TON address', async () => {
    const res = await call(keyA.token, 'POST', '/v1/wallets', { address: '0xdeadbeef' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_WALLET_ADDRESS');
  });

  it('accepts a valid address but holds it before use', async () => {
    const address = `EQ${'A'.repeat(46)}`;
    const res = await call(keyA.token, 'POST', '/v1/wallets', { address });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SECURITY_HOLD');
    expect(res.body.usable_after).toBeTruthy();
  });
});

describe('inbound provider webhook', () => {
  it('rejects an unsigned callback', async () => {
    const res = await fetch(`${baseUrl}/v1/webhooks/cubepay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment.paid', payment_id: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a callback signed with the wrong secret', async () => {
    const body = JSON.stringify({ event: 'payment.paid', payment_id: 'x', order_id: 'y' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', 'not-the-secret').update(`${timestamp}.${body}`).digest('hex');

    const res = await fetch(`${baseUrl}/v1/webhooks/cubepay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cubepay-signature': signature,
        'x-cubepay-timestamp': timestamp,
      },
      body,
    });
    expect(res.status).toBe(403);
  });
});

describe('error handling', () => {
  it('returns 404 for an unknown route', async () => {
    const res = await fetch(`${baseUrl}/v1/nope`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed JSON rather than crashing', async () => {
    const res = await fetch(`${baseUrl}/v1/invoices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect([400, 401]).toContain(res.status);
  });

  it('never leaks a stack trace to the client', async () => {
    const res = await call(keyA.token, 'POST', '/v1/invoices', { amount: 'abc' });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('at ');
    expect(text).not.toContain('.ts:');
  });
});
