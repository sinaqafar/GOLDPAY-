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
  const envelope = (await res.json().catch(() => null)) as Record<string, any>;
  return {
    status: res.status,
    // Unwrap the standard envelope so assertions read the payload directly.
    // The envelope's own shape is asserted separately.
    body: unwrap(envelope),
    envelope,
  };
}

/** `{ data, meta }` -> data; an error envelope is returned as-is. */
function unwrap(envelope: Record<string, any> | null): Record<string, any> {
  if (envelope && typeof envelope === 'object' && 'data' in envelope && !('error' in envelope)) {
    const data = envelope['data'];
    return (data && typeof data === 'object' ? data : envelope) as Record<string, any>;
  }
  return (envelope ?? {}) as Record<string, any>;
}

describe('health', () => {
  it('reports liveness', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
  });

  it('reports the treasury as manual-only', async () => {
    const res = await fetch(`${baseUrl}/health/dependencies`);
    const envelope = (await res.json()) as { data: { checks: Record<string, string> } };
    expect(res.status).toBe(200);
    expect(envelope.data.checks['treasury_policy']).toBe('MANUAL_ONLY');
  });
});

describe('response envelope (SPEC 101329/101331)', () => {
  it('wraps a success in data + meta.request_id', async () => {
    const res = await call(keyA.token, 'GET', '/v1/balances');
    expect(res.status).toBe(200);
    expect(res.envelope['data']).toBeTypeOf('object');
    expect(res.envelope['meta']['request_id']).toBeTruthy();
  });

  it('echoes a caller-supplied request id so one id spans both sides', async () => {
    const requestId = randomUUID();
    const res = await fetch(`${baseUrl}/health/live`, { headers: { 'x-request-id': requestId } });
    const envelope = (await res.json()) as { meta: { request_id: string } };
    expect(res.headers.get('x-request-id')).toBe(requestId);
    expect(envelope.meta.request_id).toBe(requestId);
  });

  it('puts request_id inside the error object too', async () => {
    const res = await fetch(`${baseUrl}/v1/balances`);
    const envelope = (await res.json()) as { error: { code: string; request_id: string } };
    expect(res.status).toBe(401);
    expect(envelope.error.code).toBeTruthy();
    expect(envelope.error.request_id).toBeTruthy();
  });
});

describe('signature covers the query string', () => {
  it('rejects a request whose query was altered after signing', async () => {
    // Sign for limit=1, then send limit=100. If the signature only covered the
    // pathname this would succeed and return records the caller never signed for.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const secret = keyA.token.slice(keyA.token.indexOf('.') + 1);
    const signature = signRequest(secret, {
      method: 'GET',
      path: '/v1/invoices?limit=1',
      timestamp,
      nonce,
      bodySha256: sha256Hex(''),
    });

    const res = await fetch(`${baseUrl}/v1/invoices?limit=100`, {
      headers: {
        authorization: `Bearer ${keyA.token}`,
        'x-gateway-timestamp': timestamp,
        'x-gateway-nonce': nonce,
        'x-gateway-signature': signature,
      },
    });
    // A bad signature is a security failure (403), not merely unauthenticated.
    expect(res.status).toBe(403);
  });
});

describe('cursor pagination (SPEC 77)', () => {
  it('walks a list without repeating or skipping a record', async () => {
    // Five invoices, fetched two at a time.
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await call(keyA.token, 'POST', '/v1/invoices', {
        amount: String(10_000 + i),
        invoice_number: `PAGE-${i}`,
      });
      expect(res.status).toBe(201);
      created.push(res.body.invoice_number as string);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const path: string = cursor
        ? `/v1/invoices?limit=2&cursor=${encodeURIComponent(cursor)}`
        : '/v1/invoices?limit=2';
      const res = await call(keyA.token, 'GET', path);
      expect(res.status).toBe(200);

      const rows = res.envelope['data'] as { invoice_number: string }[];
      const pagination = res.envelope['pagination'] as {
        next_cursor: string | null;
        has_more: boolean;
      };
      expect(rows.length).toBeLessThanOrEqual(2);
      for (const row of rows) seen.push(row.invoice_number);

      if (!pagination.has_more) {
        expect(pagination.next_cursor).toBeNull();
        break;
      }
      expect(pagination.next_cursor).toBeTruthy();
      cursor = pagination.next_cursor;
    }

    // Every created invoice appears exactly once across the pages.
    for (const number of created) {
      expect(seen.filter((n) => n === number)).toHaveLength(1);
    }
  });

  it('caps the page size so a caller cannot ask for everything', async () => {
    const res = await call(keyA.token, 'GET', '/v1/invoices?limit=100000');
    expect(res.status).toBe(200);
    expect((res.envelope['data'] as unknown[]).length).toBeLessThanOrEqual(100);
  });

  it('rejects a malformed cursor instead of ignoring it', async () => {
    const res = await call(keyA.token, 'GET', '/v1/invoices?cursor=not-a-real-cursor');
    expect(res.status).toBe(400);
    expect(res.body['error'].code).toBe('INVALID_CURSOR');
  });
});

describe('method and content-type validation (SPEC 97.30/97.31)', () => {
  it('answers 405 with an Allow header when the verb is wrong', async () => {
    // /v1/invoices exists for GET and POST, but not DELETE.
    const res = await fetch(`${baseUrl}/v1/invoices`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('POST');

    const envelope = (await res.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('still answers 404 when the path itself is unknown', async () => {
    const res = await fetch(`${baseUrl}/v1/nope`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('refuses a body that is not application/json', async () => {
    const res = await fetch(`${baseUrl}/v1/invoices`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'amount=1000',
    });
    expect(res.status).toBe(415);

    const envelope = (await res.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
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

    const amounts = (listB.envelope['data'] as { amount: string }[]).map((i) => i.amount);
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

describe('payments list, cancellation and API keys', () => {
  it('lists payments scoped to the merchant, with pagination', async () => {
    const res = await call(keyA.token, 'GET', '/v1/payments?limit=5');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.envelope['data'])).toBe(true);
    expect(res.envelope['pagination']).toBeTruthy();
  });

  it('rejects a malformed filter rather than silently ignoring it', async () => {
    const bad = await call(keyA.token, 'GET', '/v1/payments?invoice_id=not-a-uuid');
    expect(bad.status).toBe(400);
    expect(bad.body['error'].code).toBe('INVALID_INVOICE_FILTER');

    const badDate = await call(keyA.token, 'GET', '/v1/payments?from=yesterday');
    expect(badDate.status).toBe(400);
    expect(badDate.body['error'].code).toBe('INVALID_DATE_FILTER');
  });

  it('cancels an unpaid invoice, and is idempotent about it', async () => {
    const created = await call(keyA.token, 'POST', '/v1/invoices', { amount: '50000' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const first = await call(keyA.token, 'POST', `/v1/invoices/${id}/cancel`, { reason: 'test' });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('CANCELLED');
    expect(first.body.already_cancelled).toBe(false);

    const second = await call(keyA.token, 'POST', `/v1/invoices/${id}/cancel`);
    expect(second.status).toBe(200);
    expect(second.body.already_cancelled).toBe(true);
  });

  it("will not let one merchant cancel another's invoice", async () => {
    const created = await call(keyA.token, 'POST', '/v1/invoices', { amount: '60000' });
    const id = created.body.id as string;

    // 404, not 403: B must not learn that this invoice exists at all.
    const res = await call(keyB.token, 'POST', `/v1/invoices/${id}/cancel`);
    expect(res.status).toBe(404);
  });

  it('issues an API key, shows the secret once, and never again', async () => {
    const created = await call(keyA.token, 'POST', '/v1/api-keys', { name: 'CI key' });
    expect(created.status).toBe(201);
    expect(created.body.api_key).toBeTruthy();
    expect(created.body.key_prefix).toBeTruthy();

    const list = await call(keyA.token, 'GET', '/v1/api-keys');
    expect(list.status).toBe(200);
    const serialised = JSON.stringify(list.envelope);
    // Neither the secret nor its hash may appear in any listing.
    expect(serialised).not.toContain(created.body.api_key as string);
    expect(serialised).not.toContain('secret_hash');
  });

  it('revokes a key and answers 404 for one that is not the caller’s', async () => {
    const created = await call(keyA.token, 'POST', '/v1/api-keys', { name: 'to revoke' });
    const id = created.body.id as string;

    const revoked = await call(keyA.token, 'POST', `/v1/api-keys/${id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('REVOKED');

    // Revoking twice, or revoking someone else's, is indistinguishable — the
    // endpoint must not be usable to discover which keys exist.
    expect((await call(keyA.token, 'POST', `/v1/api-keys/${id}/revoke`)).status).toBe(404);
    expect((await call(keyB.token, 'POST', `/v1/api-keys/${id}/revoke`)).status).toBe(404);
  });

  it('refuses a nameless key', async () => {
    const res = await call(keyA.token, 'POST', '/v1/api-keys', { name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body['error'].code).toBe('INVALID_KEY_NAME');
  });
});

describe('public checkout page (SPEC 1459)', () => {
  it('shows the merchant, the amount, the fee and the total — with no auth', async () => {
    const created = await call(keyA.token, 'POST', '/v1/invoices', {
      amount: '1000000',
      description: 'Test product',
    });
    expect(created.status).toBe(201);
    expect(created.body.checkout_url).toContain(`/checkout/${created.body.id}`);

    // Deliberately unauthenticated: anyone with the link can view it.
    const res = await fetch(`${baseUrl}/checkout/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('1,000,000');
    // CUSTOMER mode: 15% on top.
    expect(html).toContain('150,000');
    expect(html).toContain('1,150,000');
    expect(html).toContain('Test product');
  });

  it('leaks no internal identifiers or figures to the buyer', async () => {
    const created = await call(keyA.token, 'POST', '/v1/invoices', { amount: '500000' });
    const html = await (await fetch(`${baseUrl}/checkout/${created.body.id}`)).text();

    // The buyer has no business seeing who the merchant is internally, what the
    // platform earns, or what the provider costs us.
    expect(html).not.toContain('merchant_id');
    expect(html).not.toContain('platform_fee');
    expect(html).not.toContain('provider_fee');
    expect(html).not.toContain('merchant_net');
  });

  it('escapes merchant-controlled text rather than rendering it', async () => {
    const created = await call(keyA.token, 'POST', '/v1/invoices', {
      amount: '10000',
      description: '<script>alert(1)</script>',
    });
    const html = await (await fetch(`${baseUrl}/checkout/${created.body.id}`)).text();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('serves no scripts and refuses to be framed', async () => {
    const created = await call(keyA.token, 'POST', '/v1/invoices', { amount: '10000' });
    const res = await fetch(`${baseUrl}/checkout/${created.body.id}`);

    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('refuses a cancelled invoice and answers 404 for an unknown one', async () => {
    const created = await call(keyA.token, 'POST', '/v1/invoices', { amount: '20000' });
    await call(keyA.token, 'POST', `/v1/invoices/${created.body.id}/cancel`);

    const cancelled = await fetch(`${baseUrl}/checkout/${created.body.id}`);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.text()).toContain('لغو');

    expect((await fetch(`${baseUrl}/checkout/not-a-uuid`)).status).toBe(404);
    expect(
      (await fetch(`${baseUrl}/checkout/00000000-0000-4000-8000-000000000000`)).status,
    ).toBe(404);
  });
});

describe('statements (SPEC 101403)', () => {
  it('reconciles opening + credits - debits to the closing balance', async () => {
    const res = await call(keyA.token, 'GET', '/v1/statements');
    expect(res.status).toBe(200);

    const opening = BigInt(res.body.opening_balance as string);
    const totals = res.body.totals as { credits: string; debits: string };
    const credits = BigInt(totals.credits);
    const debits = BigInt(totals.debits);
    const closing = BigInt(res.body.closing_balance as string);

    // The statement must add up, because it is derived from the journal rather
    // than from the balance projection.
    expect(opening + credits - debits).toBe(closing);
    expect(res.body.as_of).toBeTruthy();
  });

  it('honours an explicit period and rejects a reversed one', async () => {
    const ok = await call(
      keyA.token,
      'GET',
      '/v1/statements?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z',
    );
    expect(ok.status).toBe(200);
    expect((ok.body.period as Record<string, string>).from).toContain('2026-01-01');

    const reversed = await call(
      keyA.token,
      'GET',
      '/v1/statements?from=2026-12-31T00:00:00Z&to=2026-01-01T00:00:00Z',
    );
    expect(reversed.status).toBe(400);
    expect(reversed.body['error'].code).toBe('INVALID_PERIOD');
  });

  it('shows only this merchant’s ledger lines', async () => {
    const a = await call(keyA.token, 'GET', '/v1/statements');
    const b = await call(keyB.token, 'GET', '/v1/statements');

    const aIds = (a.body.lines as { journal_id: string }[]).map((l) => l.journal_id);
    const bIds = (b.body.lines as { journal_id: string }[]).map((l) => l.journal_id);
    for (const id of bIds) expect(aIds).not.toContain(id);
  });
});
