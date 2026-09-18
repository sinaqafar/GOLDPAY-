/**
 * HTTP routes — SPEC 117.60-117.70.
 *
 * Merchant-facing: /v1/invoices, /v1/payments, /v1/balances, /v1/payouts,
 * /v1/wallets, /v1/webhooks (inbound provider callback), /health/*.
 *
 * Hard rules honoured here:
 *  - no financial logic in the transport layer; routes only call use cases
 *  - every merchant resource is scoped to the authenticated tenant
 *  - the provider callback is verified, then re-verified against the provider
 */

import { randomUUID } from 'node:crypto';
import { Router, type RequestContext, type HttpResult } from './http.ts';
import { authenticateApiKey, authenticateTelegram, assertTenant } from './auth.ts';
import { registerAdminRoutes } from './admin-routes.ts';
import { readPageRequest, buildPage } from './pagination.ts';
import type { Container } from '../../../packages/core/src/container.ts';
import { createInvoice } from '../../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../../packages/core/src/use-cases/finalize-payment.ts';
import { runIdempotent, hashRequest } from '../../../packages/core/src/idempotency.ts';
import { isFeeMode } from '../../../packages/core/src/fees.ts';
import { assertSafeWebhookUrl } from '../../../packages/core/src/webhooks.ts';
import { generateApiKey } from '../../../packages/crypto/src/index.ts';
import { isValidTonAddress } from '../../../packages/ton/src/adapter.ts';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  IntegrationError,
} from '../../../packages/errors/src/index.ts';

export function buildRouter(container: Container): Router {
  const { db, config, logger, provider } = container;
  const router = new Router();

  // --- health ---------------------------------------------------------------

  router.get('/health/live', () => ({ status: 200, body: { status: 'ok' } }));

  router.get('/health/ready', async () => {
    try {
      await db.query('SELECT 1');
      return { status: 200, body: { status: 'ready', driver: db.driver } };
    } catch {
      return { status: 503, body: { status: 'not_ready' } };
    }
  });

  router.get('/health/dependencies', async () => {
    const checks: Record<string, string> = {};
    try {
      await db.query('SELECT 1');
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'down';
    }
    // The treasury policy is part of system health: if it ever reports anything
    // other than manual-only, the deployment is unsafe.
    checks['treasury_policy'] =
      config.treasury.autoFunding ||
      config.treasury.autoBuy ||
      config.treasury.autoSwap ||
      config.treasury.autoExchange ||
      config.treasury.autoBridge
        ? 'UNSAFE'
        : 'MANUAL_ONLY';

    const healthy = checks['database'] === 'ok' && checks['treasury_policy'] === 'MANUAL_ONLY';
    return { status: healthy ? 200 : 503, body: { status: healthy ? 'ok' : 'degraded', checks } };
  });

  // --- invoices -------------------------------------------------------------

  router.post('/v1/invoices', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = asObject(ctx.body);
    const baseAmount = requireString(body, 'amount');
    const feeMode = body['fee_mode'];
    if (feeMode !== undefined && !isFeeMode(feeMode)) {
      throw new ValidationError('INVALID_FEE_MODE', 'fee_mode must be CUSTOMER, MERCHANT or SPLIT');
    }

    // An idempotency key makes a retried "create invoice" safe (SPEC 1234).
    const idempotencyKey = ctx.headers['idempotency-key'];

    const run = async () => {
      const invoice = await createInvoice(db, config, {
        merchantId: auth.merchantId,
        baseAmount,
        feeMode: feeMode as never,
        description: optionalString(body, 'description'),
        customerReference: optionalString(body, 'customer_reference'),
        expiresInSeconds: optionalInt(body, 'expires_in_seconds'),
      });

      // Create the provider checkout AFTER our own record exists and the
      // transaction has committed (SPEC 4347: no HTTP inside a financial tx).
      let paymentUrl: string | null = null;
      try {
        const providerInvoice = await provider.createInvoice({
          internalInvoiceId: invoice.invoiceId,
          amount: invoice.customerTotal,
          description: optionalString(body, 'description'),
          callbackUrl: `${config.app.appUrl}/v1/webhooks/cubepay`,
        });
        paymentUrl = providerInvoice.paymentUrl;
        await db.query(
          `UPDATE core.invoices SET provider_invoice_id = $2, provider_payment_url = $3, updated_at = NOW()
            WHERE id = $1`,
          [invoice.invoiceId, providerInvoice.externalInvoiceId, providerInvoice.paymentUrl],
        );
      } catch (e) {
        // The invoice exists and is valid; only the checkout link is missing.
        // It can be retried without creating a second invoice.
        logger.warn('provider.create_invoice_failed', {
          invoiceId: invoice.invoiceId,
          message: e instanceof Error ? e.message : String(e),
        });
      }

      return {
        id: invoice.invoiceId,
        invoice_number: invoice.invoiceNumber,
        amount: invoice.baseAmount,
        customer_total: invoice.customerTotal,
        platform_fee: invoice.platformFee,
        merchant_net: invoice.merchantNet,
        fee_mode: invoice.feeMode,
        status: invoice.status,
        expires_at: invoice.expiresAt,
        payment_url: paymentUrl,
      };
    };

    if (!idempotencyKey) return { status: 201, body: await run() };

    const outcome = await runIdempotent(
      db,
      {
        namespace: `invoices:${auth.merchantId}`,
        key: idempotencyKey,
        requestHash: hashRequest(ctx.body),
      },
      run,
    );
    if (outcome.status === 'IN_PROGRESS') {
      return {
        status: 409,
        body: { error: { code: 'REQUEST_IN_PROGRESS', message: 'this request is already being processed', retryable: true } },
      };
    }
    return { status: outcome.status === 'REPLAYED' ? 200 : 201, body: outcome.value };
  });

  router.get('/v1/invoices/:id', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, merchant_id, invoice_number, base_amount::text, customer_total_amount::text,
              platform_fee_amount::text, merchant_net_amount::text, fee_mode, status,
              expires_at, created_at, provider_payment_url
         FROM core.invoices WHERE id = $1`,
      [ctx.params['id']],
    );
    const invoice = r.rows[0];
    if (!invoice) throw new NotFoundError('invoice', ctx.params['id']);
    assertTenant(ctx, invoice['merchant_id'] as string);

    return { status: 200, body: serialiseInvoice(invoice) };
  });

  router.get('/v1/invoices', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    // Keyset pagination: stable while rows are being inserted (SPEC 77).
    const page = readPageRequest(ctx.query);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, merchant_id, invoice_number, base_amount::text, customer_total_amount::text,
              platform_fee_amount::text, merchant_net_amount::text, fee_mode, status,
              expires_at, created_at, provider_payment_url
         FROM core.invoices
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [auth.merchantId, page.cursor?.createdAt ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    return { status: 200, body: buildPage(r.rows, page.limit, serialiseInvoice) };
  });

  // --- payments -------------------------------------------------------------

  router.get('/v1/payments/:id', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, merchant_id, invoice_id, status, verified_amount::text, currency,
              verified_paid_at, release_at, released_at, mismatch_code
         FROM core.payments WHERE id = $1`,
      [ctx.params['id']],
    );
    const payment = r.rows[0];
    if (!payment) throw new NotFoundError('payment', ctx.params['id']);
    assertTenant(ctx, payment['merchant_id'] as string);

    return {
      status: 200,
      body: {
        id: payment['id'],
        invoice_id: payment['invoice_id'],
        status: payment['status'],
        amount: payment['verified_amount'],
        currency: payment['currency'],
        paid_at: payment['verified_paid_at'],
        releasable_at: payment['release_at'],
        released_at: payment['released_at'],
        mismatch_code: payment['mismatch_code'],
      },
    };
  });

  // --- balances -------------------------------------------------------------

  router.get('/v1/balances', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const r = await db.query<{
      available: string;
      pending: string;
      settling: string;
      review_hold: string;
    }>(
      `SELECT b.available::text, b.pending::text, b.settling::text, b.review_hold::text
         FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_type = 'MERCHANT' AND a.owner_id = $1`,
      [auth.merchantId],
    );
    const row = r.rows[0] ?? { available: '0', pending: '0', settling: '0', review_hold: '0' };

    return {
      status: 200,
      body: {
        currency: 'TOMAN',
        available: row.available,
        pending: row.pending,
        settling: row.settling,
        review_hold: row.review_hold,
        // Read-only by definition: a balance is a ledger projection, never an
        // editable number (SPEC 124.174).
        editable: false,
      },
    };
  });

  // --- payouts --------------------------------------------------------------

  router.get('/v1/payouts', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const page = readPageRequest(ctx.query);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, status, amount_toman::text, gram_amount_atomic::text, rate::text,
              destination_address, transaction_hash, created_at, confirmed_at, failure_code
         FROM finance.payouts
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [auth.merchantId, page.cursor?.createdAt ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    return { status: 200, body: buildPage(r.rows, page.limit, serialisePayout) };
  });

  router.get('/v1/payouts/:id', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, merchant_id, status, amount_toman::text, gram_amount_atomic::text, rate::text,
              destination_address, transaction_hash, created_at, confirmed_at, failure_code
         FROM finance.payouts WHERE id = $1`,
      [ctx.params['id']],
    );
    const payout = r.rows[0];
    if (!payout) throw new NotFoundError('payout', ctx.params['id']);
    assertTenant(ctx, payout['merchant_id'] as string);

    return { status: 200, body: serialisePayout(payout) };
  });

  // --- wallets --------------------------------------------------------------

  router.post('/v1/wallets', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = asObject(ctx.body);
    const address = requireString(body, 'address');

    // SPEC 1255: an invalid address must be rejected before it can ever be used
    // as a payout destination — funds sent to a bad address are unrecoverable.
    if (!isValidTonAddress(address)) {
      throw new ValidationError('INVALID_WALLET_ADDRESS', 'not a valid TON address');
    }

    const walletId = randomUUID();
    // A new wallet sits in SECURITY_HOLD before it can receive money.
    const holdUntil = new Date(Date.now() + 24 * 3600 * 1000);

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO core.wallets (id, merchant_id, network, asset, address, status, hold_until)
       VALUES ($1,$2,$3,'GRAM',$4,'SECURITY_HOLD',$5)
       ON CONFLICT (network, asset, address) DO NOTHING
       RETURNING id`,
      [walletId, auth.merchantId, config.treasury.network, address, holdUntil.toISOString()],
    );
    if (inserted.rows.length === 0) {
      throw new ConflictError('WALLET_ALREADY_REGISTERED', 'this address is already registered');
    }

    return {
      status: 201,
      body: {
        id: walletId,
        address,
        network: config.treasury.network,
        status: 'SECURITY_HOLD',
        usable_after: holdUntil.toISOString(),
      },
    };
  });

  router.get('/v1/wallets', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, address, network, status, hold_until, verified_at, created_at
         FROM core.wallets WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [auth.merchantId],
    );
    return { status: 200, body: { data: r.rows } };
  });

  // --- merchant webhook endpoints ------------------------------------------

  router.post('/v1/integrations/webhooks', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = asObject(ctx.body);
    const url = requireString(body, 'url');
    await assertSafeWebhookUrl(url, config.security.allowedWebhookSchemes, {
      allowPrivate: !config.app.isProduction,
    });

    const secret = generateApiKey().token; // used as the HMAC signing secret
    const id = randomUUID();
    await db.query(
      `INSERT INTO core.webhook_endpoints (id, merchant_id, url, secret_reference, event_types, status)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE')`,
      [id, auth.merchantId, url, secret, null],
    );

    return {
      status: 201,
      // The signing secret is shown exactly once.
      body: { id, url, secret, status: 'ACTIVE' },
    };
  });

  // --- inbound provider callback -------------------------------------------

  router.post('/v1/webhooks/cubepay', async (ctx) => {
    // 1. Verify the signature over the RAW bytes. An invalid signature is
    //    logged and rejected without touching any business state.
    const parsed = provider.parseWebhook({ rawBody: ctx.rawBody, headers: ctx.headers });

    // 2. Record the event, deduplicated by the provider's own event id.
    const eventId = randomUUID();
    const stored = await db.query<{ id: string }>(
      `INSERT INTO integration.webhook_events
          (id, provider, external_event_id, event_type, signature_valid, raw_payload, payload_hash, status)
       VALUES ($1,$2,$3,$4,TRUE,$5::jsonb,$6,'RECEIVED')
       ON CONFLICT (provider, external_event_id) WHERE external_event_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        eventId,
        provider.name,
        parsed.externalEventId,
        parsed.eventType,
        ctx.rawBody || '{}',
        hashRequest(ctx.rawBody),
      ],
    );
    if (stored.rows.length === 0) {
      // Already processed: acknowledge so the provider stops retrying.
      return { status: 200, body: { received: true, duplicate: true } };
    }

    if (!parsed.payment || !parsed.internalInvoiceId) {
      await markWebhookProcessed(eventId, 'PROCESSED');
      return { status: 200, body: { received: true, ignored: true } };
    }

    // 3. THE critical step (SPEC 1248 / 124.168): never trust the callback's
    //    amount or status. Ask the provider directly.
    let verified;
    try {
      verified = await provider.verifyPayment(parsed.payment.externalPaymentId);
    } catch (e) {
      await markWebhookProcessed(eventId, 'FAILED', e instanceof Error ? e.message : String(e));
      // 500 so the provider retries; nothing has been credited.
      throw e instanceof IntegrationError
        ? e
        : new IntegrationError('PROVIDER_VERIFY_FAILED', 'could not verify the payment', { cause: e });
    }

    // 4. Finalise using only the provider-verified figures.
    const result = await finalizePayment(db, config, {
      invoiceId: parsed.internalInvoiceId,
      correlationId: eventId,
      evidence: {
        provider: provider.name,
        externalPaymentId: verified.externalPaymentId,
        paidAmount: verified.paidAmount ?? '0',
        // null when the provider does not report a fee — that is recorded as
        // "estimated from config", never silently treated as zero.
        providerFeeAmount: verified.providerFeeAmount,
        status: verified.status,
        paidAt: verified.paidAt ?? new Date().toISOString(),
        raw: verified.raw,
      },
    });

    await markWebhookProcessed(eventId, 'PROCESSED');
    return { status: 200, body: { received: true, payment_status: result.status } };
  });

  async function markWebhookProcessed(id: string, status: string, error?: string): Promise<void> {
    await db.query(
      `UPDATE integration.webhook_events
          SET status = $2, processed_at = NOW(), error_code = $3
        WHERE id = $1`,
      [id, status, error?.slice(0, 200) ?? null],
    );
  }

  // --- Telegram Mini App ----------------------------------------------------

  router.get('/v1/me', async (ctx) => {
    const auth = await authenticateTelegram(db, config, ctx);
    ctx.auth = { kind: 'TELEGRAM', userId: auth.userId, merchantId: auth.merchantId ?? undefined };

    if (!auth.merchantId) {
      return { status: 200, body: { user_id: auth.userId, merchant: null } };
    }

    const merchant = await db.query<Record<string, unknown>>(
      'SELECT id, name, status, default_fee_mode, auto_payout FROM core.merchants WHERE id = $1',
      [auth.merchantId],
    );
    const balance = await db.query<Record<string, unknown>>(
      `SELECT b.available::text, b.pending::text, b.settling::text
         FROM finance.balances b
         JOIN finance.ledger_accounts a ON a.id = b.account_id
        WHERE a.owner_type = 'MERCHANT' AND a.owner_id = $1`,
      [auth.merchantId],
    );

    return {
      status: 200,
      body: {
        user_id: auth.userId,
        merchant: merchant.rows[0] ?? null,
        balance: balance.rows[0] ?? { available: '0', pending: '0', settling: '0' },
      },
    };
  });

  /**
   * Authenticate a Mini App request and require that the user actually owns a
   * shop. Mini App routes are the same use cases as the API key routes; only
   * the way the caller proves who they are differs.
   */
  async function miniAppMerchant(ctx: RequestContext): Promise<string> {
    const auth = await authenticateTelegram(db, config, ctx);
    ctx.auth = { kind: 'TELEGRAM', userId: auth.userId, merchantId: auth.merchantId ?? undefined };
    if (!auth.merchantId) {
      throw new NotFoundError('merchant');
    }
    return auth.merchantId;
  }

  router.get('/v1/app/invoices', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const page = readPageRequest(ctx.query);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, invoice_number, base_amount::text, customer_total_amount::text,
              platform_fee_amount::text, merchant_net_amount::text, fee_mode, status,
              expires_at, created_at, provider_payment_url
         FROM core.invoices
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [merchantId, page.cursor?.createdAt ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    return { status: 200, body: buildPage(r.rows, page.limit, serialiseInvoice) };
  });

  router.post('/v1/app/invoices', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);

    const body = asObject(ctx.body);
    const feeMode = body['fee_mode'];
    if (feeMode !== undefined && !isFeeMode(feeMode)) {
      throw new ValidationError('INVALID_FEE_MODE', 'fee_mode must be CUSTOMER, MERCHANT or SPLIT');
    }

    const invoice = await createInvoice(db, config, {
      merchantId,
      baseAmount: requireString(body, 'amount'),
      feeMode: feeMode as never,
      description: optionalString(body, 'description'),
    });

    // Checkout is attached after the financial transaction has committed.
    let paymentUrl: string | null = null;
    try {
      const providerInvoice = await provider.createInvoice({
        internalInvoiceId: invoice.invoiceId,
        amount: invoice.customerTotal,
        description: optionalString(body, 'description'),
        callbackUrl: `${config.app.appUrl}/v1/webhooks/cubepay`,
      });
      paymentUrl = providerInvoice.paymentUrl;
      await db.query(
        `UPDATE core.invoices SET provider_invoice_id = $2, provider_payment_url = $3, updated_at = NOW()
          WHERE id = $1`,
        [invoice.invoiceId, providerInvoice.externalInvoiceId, providerInvoice.paymentUrl],
      );
    } catch (e) {
      logger.warn('provider.create_invoice_failed', {
        invoiceId: invoice.invoiceId,
        message: e instanceof Error ? e.message : String(e),
      });
    }

    return {
      status: 201,
      body: {
        id: invoice.invoiceId,
        invoice_number: invoice.invoiceNumber,
        amount: invoice.baseAmount,
        customer_total: invoice.customerTotal,
        platform_fee: invoice.platformFee,
        merchant_net: invoice.merchantNet,
        fee_mode: invoice.feeMode,
        status: invoice.status,
        expires_at: invoice.expiresAt,
        payment_url: paymentUrl,
      },
    };
  });

  router.get('/v1/app/payouts', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const page = readPageRequest(ctx.query);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, status, amount_toman::text, gram_amount_atomic::text, rate::text,
              destination_address, transaction_hash, created_at, confirmed_at, failure_code
         FROM finance.payouts
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [merchantId, page.cursor?.createdAt ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    return { status: 200, body: buildPage(r.rows, page.limit, serialisePayout) };
  });

  router.get('/v1/app/wallets', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, address, network, status, hold_until, verified_at, created_at
         FROM core.wallets WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [merchantId],
    );
    return { status: 200, body: { data: r.rows } };
  });

  router.post('/v1/app/wallets', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const address = requireString(asObject(ctx.body), 'address');

    if (!isValidTonAddress(address)) {
      throw new ValidationError('INVALID_WALLET_ADDRESS', 'not a valid TON address');
    }

    const walletId = randomUUID();
    const holdUntil = new Date(Date.now() + 24 * 3600 * 1000);

    // Registering a new wallet retires the previous one, so a merchant always
    // has exactly one payout destination. Both steps share a transaction: a
    // half-applied change could leave the merchant with no active wallet.
    const created = await db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO core.wallets (id, merchant_id, network, asset, address, status, hold_until)
         VALUES ($1,$2,$3,'GRAM',$4,'SECURITY_HOLD',$5)
         ON CONFLICT (network, asset, address) DO NOTHING
         RETURNING id`,
        [walletId, merchantId, config.treasury.network, address, holdUntil.toISOString()],
      );
      if (inserted.rows.length === 0) return false;

      await tx.query(
        `UPDATE core.wallets SET status = 'DISABLED', updated_at = NOW()
          WHERE merchant_id = $1 AND id <> $2 AND status IN ('ACTIVE','SECURITY_HOLD')`,
        [merchantId, walletId],
      );
      return true;
    });

    if (!created) {
      throw new ConflictError('WALLET_ALREADY_REGISTERED', 'this address is already registered');
    }

    return {
      status: 201,
      body: {
        id: walletId,
        address,
        network: config.treasury.network,
        status: 'SECURITY_HOLD',
        usable_after: holdUntil.toISOString(),
      },
    };
  });

  // Internal administration lives on its own prefix with its own credential.
  registerAdminRoutes(router, container);

  return router;
}

// --- helpers ---------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('INVALID_BODY', 'a JSON object body is required');
  }
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ValidationError('MISSING_FIELD', `${key} is required`);
  }
  return v.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function optionalInt(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  throw new ValidationError('INVALID_FIELD', `${key} must be an integer`);
}

function serialiseInvoice(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['id'],
    invoice_number: row['invoice_number'],
    amount: row['base_amount'],
    customer_total: row['customer_total_amount'],
    platform_fee: row['platform_fee_amount'],
    merchant_net: row['merchant_net_amount'],
    fee_mode: row['fee_mode'],
    status: row['status'],
    expires_at: row['expires_at'],
    created_at: row['created_at'],
    payment_url: row['provider_payment_url'],
  };
}

function serialisePayout(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['id'],
    status: row['status'],
    amount_toman: row['amount_toman'],
    gram_amount: row['gram_amount_atomic'],
    rate: row['rate'],
    destination: row['destination_address'],
    transaction_hash: row['transaction_hash'],
    created_at: row['created_at'],
    confirmed_at: row['confirmed_at'],
    failure_code: row['failure_code'],
  };
}
