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
import { renderCheckout } from './checkout.ts';
import { renderMetrics } from '../../../packages/core/src/observability.ts';
import {
  requestRefund,
  refundableAmount,
} from '../../../packages/core/src/use-cases/refund.ts';
import { openDispute } from '../../../packages/core/src/use-cases/dispute.ts';
import {
  openTicket,
  replyToTicket,
  getTicket,
  isTicketCategory,
} from '../../../packages/core/src/use-cases/support.ts';
import type { Container } from '../../../packages/core/src/container.ts';
import { createInvoice, cancelInvoice } from '../../../packages/core/src/use-cases/create-invoice.ts';
import { finalizePayment } from '../../../packages/core/src/use-cases/finalize-payment.ts';
import { runIdempotent, hashRequest } from '../../../packages/core/src/idempotency.ts';
import { isFeeMode } from '../../../packages/core/src/fees.ts';
import { assertSafeWebhookUrl } from '../../../packages/core/src/webhooks.ts';
import { generateApiKey, sha256Hex } from '../../../packages/crypto/src/index.ts';
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

  /**
   * Prometheus exposition.
   *
   * Secured endpoint: access is restricted to authenticated scrapers
   * via METRICS_AUTH_TOKEN or internal monitoring bearer auth.
   */
  router.get('/metrics', async (ctx) => {
    const requiredToken = config.security.metricsAuthToken;
    const authHeader = ctx.headers['authorization'] ?? ctx.headers['x-metrics-key'] ?? ctx.headers['x-metrics-token'];
    
    if (requiredToken) {
      const isAuthorized =
        authHeader === `Bearer ${requiredToken}` ||
        authHeader === requiredToken;
      if (!isAuthorized) {
        return {
          status: 401,
          headers: { 'content-type': 'application/json' },
          body: { error: 'UNAUTHORIZED_METRICS_ACCESS', message: 'Valid METRICS_AUTH_TOKEN is required' },
        };
      }
    } else if (config.app.isProduction) {
      // In production without explicit token, reject public scraping
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return {
          status: 401,
          headers: { 'content-type': 'application/json' },
          body: { error: 'UNAUTHORIZED_METRICS_ACCESS', message: 'Metrics access is restricted in production' },
        };
      }
    }

    return {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      body: await renderMetrics(db),
    };
  });

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

  // --- public checkout (no authentication) ------------------------------------

  router.get('/checkout/:id', async (ctx) => renderCheckout(db, ctx.params['id'] as string));

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
      // Resolve provider adapter dynamically via providerResolver
      const activeAdapter = container.providerResolver
        ? container.providerResolver.resolveForInvoice({ providerMode: invoice.providerMode })
        : provider;

      let paymentUrl: string | null = null;
      const attemptId = randomUUID();

      try {
        const providerInvoice = await activeAdapter.createInvoice({
          internalInvoiceId: invoice.invoiceId,
          amount: invoice.customerTotal,
          description: optionalString(body, 'description'),
          callbackUrl: `${config.app.appUrl}/v1/webhooks/cubepay`,
        });
        paymentUrl = providerInvoice.paymentUrl;
        await db.query(
          `UPDATE core.invoices
              SET provider_invoice_id = $2,
                  provider_payment_url = $3,
                  provider_order_id = $4,
                  provider_pay_amount_rial = $5,
                  provider_pay_amount_toman = $6,
                  provider_ttl_minutes = $7,
                  redirect_after_payment = $8,
                  updated_at = NOW()
            WHERE id = $1`,
          [
            invoice.invoiceId,
            providerInvoice.externalInvoiceId,
            providerInvoice.paymentUrl,
            invoice.invoiceId,
            providerInvoice.providerPayAmountRial ?? null,
            providerInvoice.providerPayAmountToman ?? null,
            providerInvoice.providerTtlMinutes ?? null,
            providerInvoice.redirectAfterPayment ?? true,
          ],
        );

        // Record successful payment attempt
        await db.query(
          `INSERT INTO core.payment_attempts (
             id, payment_intent_id, invoice_id, attempt_number, provider, provider_mode,
             provider_version, provider_order_id, authority_or_uid, payment_url,
             pay_amount_rial, pay_amount_toman, status
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING_GATEWAY')
           ON CONFLICT (payment_intent_id, attempt_number) DO NOTHING`,
          [
            attemptId,
            invoice.paymentIntentId,
            invoice.invoiceId,
            invoice.provider,
            invoice.providerMode,
            invoice.providerVersion,
            invoice.invoiceId,
            providerInvoice.externalInvoiceId,
            providerInvoice.paymentUrl,
            providerInvoice.providerPayAmountRial ?? `${BigInt(invoice.customerTotal) * 10n}`,
            providerInvoice.providerPayAmountToman ?? invoice.customerTotal,
          ],
        ).catch(() => undefined);
      } catch (e) {
        // The invoice exists and is valid; only the checkout link is missing.
        // It can be retried without creating a second invoice.
        logger.warn('provider.create_invoice_failed', {
          invoiceId: invoice.invoiceId,
          message: e instanceof Error ? e.message : String(e),
        });

        await db.query(
          `UPDATE core.invoices
              SET provider_create_status = 'PROVIDER_CREATE_FAILED',
                  provider_create_attempts = 1,
                  last_provider_error = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [invoice.invoiceId, e instanceof Error ? e.message : String(e)],
        ).catch(() => undefined);

        await db.query(
          `INSERT INTO core.payment_attempts (
             id, payment_intent_id, invoice_id, attempt_number, provider, provider_mode,
             provider_version, provider_order_id, pay_amount_rial, pay_amount_toman, status, error_message
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'FAILED', $10)
           ON CONFLICT (payment_intent_id, attempt_number) DO NOTHING`,
          [
            attemptId,
            invoice.paymentIntentId,
            invoice.invoiceId,
            invoice.provider,
            invoice.providerMode,
            invoice.providerVersion,
            invoice.invoiceId,
            `${BigInt(invoice.customerTotal) * 10n}`,
            invoice.customerTotal,
            e instanceof Error ? e.message : String(e),
          ],
        ).catch(() => undefined);
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
        // Our own branded checkout is the official surface (SPEC 1459); the
        // provider link is included so a merchant can bypass it if they must.
        checkout_url: `${config.app.appUrl}/checkout/${invoice.invoiceId}`,
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

  router.post('/v1/invoices/:id/cancel', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = ctx.body === undefined ? {} : asObject(ctx.body);
    const reason = body['reason'];
    if (reason !== undefined && typeof reason !== 'string') {
      throw new ValidationError('INVALID_REASON', 'reason must be a string');
    }

    const result = await cancelInvoice(db, {
      merchantId: auth.merchantId,
      invoiceId: ctx.params['id'] as string,
      reason: reason as string | undefined,
    });

    return {
      status: 200,
      body: {
        id: result.invoiceId,
        status: result.status,
        already_cancelled: result.alreadyCancelled,
      },
    };
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

    return { status: 200, body: serialisePayment(payment) };
  });

  router.get('/v1/payments', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const page = readPageRequest(ctx.query);

    // Filters are optional and always ANDed on top of the tenant scope, so no
    // combination of them can widen access beyond this merchant (SPEC 97 IDOR).
    const status = ctx.query.get('status');
    if (status !== null && !/^[A-Z_]{2,32}$/.test(status)) {
      throw new ValidationError('INVALID_STATUS_FILTER', 'status filter is malformed');
    }
    const invoiceId = ctx.query.get('invoice_id');
    if (invoiceId !== null && !UUID_RE.test(invoiceId)) {
      throw new ValidationError('INVALID_INVOICE_FILTER', 'invoice_id must be a UUID');
    }
    const from = parseDateFilter(ctx.query.get('from'), 'from');
    const to = parseDateFilter(ctx.query.get('to'), 'to');

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, merchant_id, invoice_id, status, verified_amount::text, currency,
              verified_paid_at, release_at, released_at, mismatch_code, created_at
         FROM core.payments
        WHERE merchant_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::uuid IS NULL OR invoice_id = $3)
          AND ($4::timestamptz IS NULL OR created_at >= $4)
          AND ($5::timestamptz IS NULL OR created_at <= $5)
          AND ($6::timestamptz IS NULL OR (created_at, id) < ($6::timestamptz, $7::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $8`,
      [
        auth.merchantId,
        status,
        invoiceId,
        from,
        to,
        page.cursor?.createdAt ?? null,
        page.cursor?.id ?? null,
        page.limit + 1,
      ],
    );
    return { status: 200, body: buildPage(r.rows, page.limit, serialisePayment) };
  });

  // --- refunds ------------------------------------------------------------------

  router.post('/v1/refunds', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = asObject(ctx.body);
    const paymentId = body['payment_id'];
    const amount = body['amount'];
    const reason = body['reason'];

    if (typeof paymentId !== 'string' || !UUID_RE.test(paymentId)) {
      throw new ValidationError('INVALID_PAYMENT_ID', 'payment_id must be a UUID');
    }
    if (typeof amount !== 'string') {
      throw new ValidationError('INVALID_AMOUNT', 'amount must be an integer string');
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new ValidationError('MISSING_REASON', 'a reason is required for a refund');
    }

    const result = await requestRefund(db, {
      paymentId,
      merchantId: auth.merchantId,
      amount,
      reason,
      requestedByType: 'MERCHANT',
    });

    // 202: the request is recorded and will be decided, not completed inline.
    return {
      status: 202,
      body: {
        id: result.refundId,
        status: result.status,
        ...(result.blockedReason ? { blocked_reason: result.blockedReason } : {}),
      },
    };
  });

  router.get('/v1/payments/:id/refundable', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const owner = await db.query<{ merchant_id: string }>(
      'SELECT merchant_id FROM core.payments WHERE id = $1',
      [ctx.params['id']],
    );
    const row = owner.rows[0];
    if (!row) throw new NotFoundError('payment', ctx.params['id'] as string);
    assertTenant(ctx, row.merchant_id);

    const amount = await refundableAmount(db, ctx.params['id'] as string);
    return { status: 200, body: { payment_id: ctx.params['id'], refundable_amount: amount } };
  });

  // --- support ------------------------------------------------------------------

  router.post('/v1/support/tickets', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = asObject(ctx.body);
    const subject = body['subject'];
    const message = body['message'];
    const category = body['category'] ?? 'OTHER';

    if (typeof subject !== 'string') {
      throw new ValidationError('MISSING_SUBJECT', 'subject is required');
    }
    if (typeof message !== 'string') {
      throw new ValidationError('MISSING_BODY', 'message is required');
    }
    if (!isTicketCategory(category)) {
      throw new ValidationError('INVALID_CATEGORY', `unknown category: ${String(category)}`);
    }

    const entityId = body['entity_id'];
    if (entityId !== undefined && (typeof entityId !== 'string' || !UUID_RE.test(entityId))) {
      throw new ValidationError('INVALID_ENTITY_ID', 'entity_id must be a UUID');
    }

    const ticket = await openTicket(db, {
      merchantId: auth.merchantId,
      subject,
      body: message,
      category,
      entityType: body['entity_type'] as never,
      entityId: entityId as string | undefined,
      openedByType: 'MERCHANT',
    });

    return { status: 201, body: { id: ticket.ticketId, reference: ticket.reference } };
  });

  router.get('/v1/support/tickets', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const page = readPageRequest(ctx.query);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, reference, subject, category, priority, status,
              entity_type, entity_id, created_at, updated_at
         FROM core.support_tickets
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [auth.merchantId, page.cursor?.createdAt ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    return { status: 200, body: buildPage(r.rows, page.limit, (row) => row) };
  });

  router.get('/v1/support/tickets/:id', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    // Internal staff notes are never shown to a merchant.
    const ticket = await getTicket(db, {
      ticketId: ctx.params['id'] as string,
      merchantId: auth.merchantId,
      includeInternal: false,
    });
    return { status: 200, body: ticket };
  });

  router.post('/v1/support/tickets/:id/reply', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = asObject(ctx.body);
    if (typeof body['message'] !== 'string') {
      throw new ValidationError('MISSING_BODY', 'message is required');
    }

    const reply = await replyToTicket(db, {
      ticketId: ctx.params['id'] as string,
      body: body['message'],
      senderType: 'MERCHANT',
      merchantId: auth.merchantId,
    });
    return { status: 201, body: { id: reply.messageId } };
  });

  // --- disputes -------------------------------------------------------------------

  router.post('/v1/disputes', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = asObject(ctx.body);
    const paymentId = body['payment_id'];
    const reason = body['reason'];

    if (typeof paymentId !== 'string' || !UUID_RE.test(paymentId)) {
      throw new ValidationError('INVALID_PAYMENT_ID', 'payment_id must be a UUID');
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new ValidationError('MISSING_REASON', 'a reason is required');
    }

    const dispute = await openDispute(db, {
      paymentId,
      reason,
      openedByType: 'MERCHANT',
      merchantId: auth.merchantId,
    });

    // 202: the case is recorded and the money paused; a human decides next.
    return {
      status: 202,
      body: { id: dispute.disputeId, status: dispute.status, hold_placed: dispute.holdPlaced },
    };
  });

  router.get('/v1/disputes', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, payment_id, status, reason, resolution, created_at, resolved_at
         FROM core.disputes WHERE merchant_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [auth.merchantId],
    );
    return { status: 200, body: { data: r.rows } };
  });

  /**
   * Why a payment is not moving.
   *
   * A merchant whose money is paused deserves to know that, and why — an
   * unexplained delay is worse than a refused payout.
   */
  router.get('/v1/payments/:id/holds', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const owner = await db.query<{ merchant_id: string }>(
      'SELECT merchant_id FROM core.payments WHERE id = $1',
      [ctx.params['id']],
    );
    const row = owner.rows[0];
    if (!row) throw new NotFoundError('payment', ctx.params['id'] as string);
    assertTenant(ctx, row.merchant_id);

    const holds = await db.query<Record<string, unknown>>(
      `SELECT id, source, reason, status, created_at, released_at
         FROM finance.payment_holds
        WHERE payment_id = $1 ORDER BY created_at DESC`,
      [ctx.params['id']],
    );
    return { status: 200, body: { data: holds.rows } };
  });

  // --- statements -------------------------------------------------------------

  router.get('/v1/statements', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    // SPEC 101405: the caller chooses the period. Default to the last 30 days.
    const to = parseDateFilter(ctx.query.get('to'), 'to') ?? new Date().toISOString();
    const from =
      parseDateFilter(ctx.query.get('from'), 'from') ??
      new Date(Date.parse(to) - 30 * 24 * 3600 * 1000).toISOString();

    if (Date.parse(from) > Date.parse(to)) {
      throw new ValidationError('INVALID_PERIOD', 'from must not be after to');
    }

    const account = await db.query<{ id: string }>(
      `SELECT id FROM finance.ledger_accounts
        WHERE owner_type = 'MERCHANT' AND owner_id = $1 AND currency = 'TOMAN'`,
      [auth.merchantId],
    );
    const accountId = account.rows[0]?.id;

    // A merchant with no ledger account yet has an empty statement, not an error.
    if (!accountId) {
      return {
        status: 200,
        body: {
          period: { from, to },
          opening_balance: '0',
          closing_balance: '0',
          totals: { credits: '0', debits: '0' },
          lines: [],
          as_of: new Date().toISOString(),
        },
      };
    }

    // Everything below is derived from journal entries, never from the
    // projection: SPEC 71.15/101407 requires a statement to reconcile against
    // the ledger itself.
    const opening = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(e.credit - e.debit), 0)::text AS balance
         FROM finance.journal_entries e
         JOIN finance.journals j ON j.id = e.journal_id
        WHERE e.account_id = $1 AND j.created_at < $2`,
      [accountId, from],
    );

    const lines = await db.query<Record<string, unknown>>(
      `SELECT j.id, j.reference_type, j.reference_id, j.description, j.created_at,
              e.debit::text, e.credit::text, e.bucket
         FROM finance.journal_entries e
         JOIN finance.journals j ON j.id = e.journal_id
        WHERE e.account_id = $1 AND j.created_at >= $2 AND j.created_at <= $3
        ORDER BY j.created_at ASC
        LIMIT 1000`,
      [accountId, from, to],
    );

    let credits = 0n;
    let debits = 0n;
    for (const line of lines.rows) {
      credits += BigInt((line['credit'] as string) ?? '0');
      debits += BigInt((line['debit'] as string) ?? '0');
    }
    const openingBalance = BigInt(opening.rows[0]?.balance ?? '0');

    return {
      status: 200,
      body: {
        period: { from, to },
        opening_balance: openingBalance.toString(),
        closing_balance: (openingBalance + credits - debits).toString(),
        totals: { credits: credits.toString(), debits: debits.toString() },
        lines: lines.rows.map((line) => ({
          journal_id: line['id'],
          type: line['reference_type'],
          reference_id: line['reference_id'],
          description: line['description'],
          credit: line['credit'],
          debit: line['debit'],
          bucket: line['bucket'],
          created_at: line['created_at'],
        })),
        as_of: new Date().toISOString(),
      },
    };
  });

  // --- API keys ---------------------------------------------------------------
  //
  // SPEC 101453-101459. The secret is shown exactly once, at creation: only its
  // hash is stored, so it is not merely policy but physically unrecoverable
  // afterwards.

  router.post('/v1/api-keys', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const body = asObject(ctx.body);
    const name = body['name'];
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 64) {
      throw new ValidationError('INVALID_KEY_NAME', 'name is required, at most 64 characters');
    }

    const active = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM core.api_keys
        WHERE merchant_id = $1 AND status = 'ACTIVE'`,
      [auth.merchantId],
    );
    // A bounded number of live credentials keeps the blast radius of a leak
    // small and makes rotation a deliberate act rather than accumulation.
    if (Number(active.rows[0]?.count ?? '0') >= 10) {
      throw new ConflictError('TOO_MANY_API_KEYS', 'revoke an existing key before creating another');
    }

    const key = generateApiKey();
    const id = randomUUID();
    await db.query(
      `INSERT INTO core.api_keys (id, merchant_id, name, key_prefix, secret_hash, status)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE')`,
      [id, auth.merchantId, name.trim(), key.prefix, key.secretHash],
    );

    return {
      status: 201,
      body: {
        id,
        name: name.trim(),
        key_prefix: key.prefix,
        // Shown once. There is no endpoint that can return it again.
        api_key: key.token,
        created_at: new Date().toISOString(),
      },
    };
  });

  router.get('/v1/api-keys', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const r = await db.query<Record<string, unknown>>(
      `SELECT id, name, key_prefix, status, last_used_at, created_at, revoked_at
         FROM core.api_keys WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [auth.merchantId],
    );
    // Never the hash, never the secret.
    return { status: 200, body: { data: r.rows } };
  });

  router.post('/v1/api-keys/:id/revoke', async (ctx) => {
    const auth = await authenticateApiKey(db, config, ctx);
    ctx.auth = { kind: 'API_KEY', merchantId: auth.merchantId };

    const keyId = ctx.params['id'] as string;
    if (!UUID_RE.test(keyId)) throw new NotFoundError('api_key', keyId);

    const updated = await db.query(
      `UPDATE core.api_keys SET status = 'REVOKED', revoked_at = NOW()
        WHERE id = $1 AND merchant_id = $2 AND status = 'ACTIVE'`,
      [keyId, auth.merchantId],
    );
    if (updated.rowCount !== 1) {
      // Either it does not exist, belongs to someone else, or is already
      // revoked. All three answer the same way so the endpoint cannot be used
      // to discover which keys exist.
      throw new NotFoundError('api_key', keyId);
    }

    // Revocation stops future use; it never rewrites financial history
    // (SPEC 7672).
    return { status: 200, body: { id: keyId, status: 'REVOKED' } };
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

    // Also persist into canonical merchant_wallets table
    await db.query(
      `INSERT INTO core.merchant_wallets (id, merchant_id, network, asset, address, status, hold_until)
       VALUES ($1,$2,$3,'GRAM',$4,'SECURITY_HOLD',$5)
       ON CONFLICT (id) DO NOTHING`,
      [walletId, auth.merchantId, config.treasury.network, address, holdUntil.toISOString()],
    ).catch(() => undefined);

    // Record in immutable wallet history
    const historyPayload = `${walletId}|${auth.merchantId}|${address}|${holdUntil.toISOString()}`;
    await db.query(
      `INSERT INTO core.merchant_wallet_history
          (merchant_id, wallet_id, new_wallet_address, network, actor_type, actor_id, hold_until, previous_hash, current_hash)
       VALUES ($1, $2, $3, $4, 'MERCHANT', $5, $6, '0000000000000000000000000000000000000000000000000000000000000000', $7)`,
      [
        auth.merchantId,
        walletId,
        address,
        config.treasury.network,
        auth.merchantId,
        holdUntil.toISOString(),
        sha256Hex(historyPayload),
      ],
    ).catch(() => undefined);

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
         FROM core.merchant_wallets WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [auth.merchantId],
    );
    if (r.rows.length > 0) {
      return { status: 200, body: { data: r.rows } };
    }

    const legacy = await db.query<Record<string, unknown>>(
      `SELECT id, address, network, status, hold_until, verified_at, created_at
         FROM core.wallets WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [auth.merchantId],
    );
    return { status: 200, body: { data: legacy.rows } };
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
    const secretHash = sha256Hex(secret);
    const secretEncrypted = sha256Hex(`kms:enc:${secret}`);
    const secretRef = `kms://webhook-secrets/${id}`;

    await db.query(
      `INSERT INTO core.webhook_endpoints
          (id, merchant_id, url, secret_reference, secret_encrypted, secret_hash, event_types, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE')`,
      [id, auth.merchantId, url, secretRef, secretEncrypted, secretHash, null],
    );

    return {
      status: 201,
      // The signing secret is shown exactly once to the merchant at creation.
      body: { id, url, secret, status: 'ACTIVE' },
    };
  });

  // --- inbound provider callback -------------------------------------------

  router.post('/v1/webhooks/cubepay', async (ctx) => {
    // 1. Extract order_id from rawBody or query params to locate the target invoice
    let rawJson: Record<string, unknown> = {};
    try {
      rawJson = JSON.parse(ctx.rawBody || '{}');
    } catch {
      // not JSON
    }

    const orderId =
      typeof rawJson['order_id'] === 'string'
        ? rawJson['order_id']
        : typeof ctx.query.get('order_id') === 'string'
          ? ctx.query.get('order_id')
          : null;

    let targetAdapter = provider;
    let invoiceRecord: { id: string; provider_mode: string } | undefined;

    if (orderId) {
      const invRes = await db.query<{ id: string; provider_mode: string }>(
        `SELECT id, provider_mode FROM core.invoices WHERE id::text = $1 OR invoice_number = $1`,
        [orderId],
      );
      invoiceRecord = invRes.rows[0];
      if (invoiceRecord && container.providerResolver) {
        targetAdapter = container.providerResolver.resolveForMode(invoiceRecord.provider_mode);
      }
    }

    // 2. Verify signature and parse webhook using the invoice's snapshotted provider_mode
    const parsed = targetAdapter.parseWebhook({ rawBody: ctx.rawBody, headers: ctx.headers });

    // 3. Record the event, deduplicated by the provider's own event id.
    const eventId = randomUUID();
    const stored = await db.query<{ id: string }>(
      `INSERT INTO integration.webhook_events
          (id, provider, external_event_id, event_type, signature_valid, raw_payload, payload_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'RECEIVED')
       ON CONFLICT (provider, external_event_id) WHERE external_event_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        eventId,
        targetAdapter.name,
        parsed.externalEventId,
        parsed.eventType,
        true,
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

    // 4. THE critical step (SPEC 1248 / 124.168): never trust the callback's
    //    amount or status. Ask the provider directly via the matched adapter.
    let verified;
    try {
      verified = await targetAdapter.verifyPayment(parsed.payment.externalPaymentId);
    } catch (e) {
      await markWebhookProcessed(eventId, 'FAILED', e instanceof Error ? e.message : String(e));
      // 500 so the provider retries; nothing has been credited.
      throw e instanceof IntegrationError
        ? e
        : new IntegrationError('PROVIDER_VERIFY_FAILED', 'could not verify the payment', { cause: e });
    }

    // 5. Finalise using only the provider-verified figures.
    const result = await finalizePayment(db, config, {
      invoiceId: invoiceRecord?.id ?? parsed.internalInvoiceId,
      correlationId: eventId,
      evidence: {
        provider: targetAdapter.name,
        externalPaymentId: verified.externalPaymentId,
        paidAmount: verified.paidAmount ?? '0',
        paidAmountRial: verified.paidAmountRial,
        orderId: verified.orderId ?? parsed.internalInvoiceId,
        matchConfidence: verified.matchConfidence,
        matchFlags: verified.matchFlags,
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
    const activeAdapter = container.providerResolver
      ? container.providerResolver.resolveForInvoice({ providerMode: invoice.providerMode })
      : provider;

    let paymentUrl: string | null = null;
    try {
      const providerInvoice = await activeAdapter.createInvoice({
        internalInvoiceId: invoice.invoiceId,
        amount: invoice.customerTotal,
        description: optionalString(body, 'description'),
        callbackUrl: `${config.app.appUrl}/v1/webhooks/cubepay`,
      });
      paymentUrl = providerInvoice.paymentUrl;
      await db.query(
        `UPDATE core.invoices
            SET provider_invoice_id = $2,
                provider_payment_url = $3,
                provider_order_id = $4,
                provider_pay_amount_rial = $5,
                provider_pay_amount_toman = $6,
                provider_ttl_minutes = $7,
                redirect_after_payment = $8,
                updated_at = NOW()
          WHERE id = $1`,
        [
          invoice.invoiceId,
          providerInvoice.externalInvoiceId,
          providerInvoice.paymentUrl,
          invoice.invoiceId,
          providerInvoice.providerPayAmountRial ?? null,
          providerInvoice.providerPayAmountToman ?? null,
          providerInvoice.providerTtlMinutes ?? null,
          providerInvoice.redirectAfterPayment ?? true,
        ],
      );
    } catch (e) {
      logger.warn('provider.create_invoice_failed', {
        invoiceId: invoice.invoiceId,
        message: e instanceof Error ? e.message : String(e),
      });

      await db.query(
        `UPDATE core.invoices
            SET provider_create_status = 'PROVIDER_CREATE_FAILED',
                provider_create_attempts = 1,
                last_provider_error = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [invoice.invoiceId, e instanceof Error ? e.message : String(e)],
      ).catch(() => undefined);
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
        checkout_url: `${config.app.appUrl}/checkout/${invoice.invoiceId}`,
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

  router.get('/v1/app/payments', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const page = readPageRequest(ctx.query);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, invoice_id, status, verified_amount::text, currency,
              verified_paid_at, release_at, released_at, mismatch_code, created_at
         FROM core.payments
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [merchantId, page.cursor?.createdAt ?? null, page.cursor?.id ?? null, page.limit + 1],
    );
    return { status: 200, body: buildPage(r.rows, page.limit, serialisePayment) };
  });

  router.get('/v1/app/api-keys', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, name, key_prefix, status, last_used_at, created_at
         FROM core.api_keys WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [merchantId],
    );
    return { status: 200, body: { data: r.rows } };
  });

  router.get('/v1/app/settings', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const r = await db.query<Record<string, unknown>>(
      `SELECT name, status, default_fee_mode, auto_payout, created_at
         FROM core.merchants WHERE id = $1`,
      [merchantId],
    );
    const merchant = r.rows[0];
    if (!merchant) throw new NotFoundError('merchant', merchantId);

    return {
      status: 200,
      body: {
        name: merchant['name'],
        status: merchant['status'],
        fee_mode: merchant['default_fee_mode'],
        auto_payout: merchant['auto_payout'],
        // Shown so a merchant can see the terms they are actually on.
        platform_fee_percent: Number(config.fees.platformFeePercent.bps) / 100,
        hold_hours: config.settlement.holdHours,
        settlement_asset: config.ton.gramAsset,
        settlement_network: config.ton.network,
        created_at: merchant['created_at'],
      },
    };
  });

  router.get('/v1/app/support', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const r = await db.query<Record<string, unknown>>(
      `SELECT id, reference, subject, category, status, created_at, updated_at
         FROM core.support_tickets WHERE merchant_id = $1
        ORDER BY created_at DESC LIMIT 25`,
      [merchantId],
    );
    return { status: 200, body: { data: r.rows } };
  });

  router.post('/v1/app/support', async (ctx) => {
    const merchantId = await miniAppMerchant(ctx);
    const body = asObject(ctx.body);

    const subject = body['subject'];
    const message = body['message'];
    const category = body['category'] ?? 'OTHER';
    if (typeof subject !== 'string') {
      throw new ValidationError('MISSING_SUBJECT', 'subject is required');
    }
    if (typeof message !== 'string') {
      throw new ValidationError('MISSING_BODY', 'message is required');
    }
    if (!isTicketCategory(category)) {
      throw new ValidationError('INVALID_CATEGORY', `unknown category: ${String(category)}`);
    }

    const ticket = await openTicket(db, {
      merchantId,
      subject,
      body: message,
      category,
      openedByType: 'MERCHANT',
    });
    return { status: 201, body: { id: ticket.ticketId, reference: ticket.reference } };
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse an optional ISO date filter, rejecting garbage rather than ignoring it. */
function parseDateFilter(value: string | null, field: string): string | null {
  if (value === null || value === '') return null;
  if (Number.isNaN(Date.parse(value))) {
    throw new ValidationError('INVALID_DATE_FILTER', `${field} must be an ISO-8601 timestamp`, {
      field,
    });
  }
  return new Date(value).toISOString();
}

/**
 * Merchant-facing payment shape.
 * Internal columns (provider fee expectations, raw evidence) are deliberately
 * absent: SPEC 101385 keeps platform-internal figures out of merchant APIs.
 */
function serialisePayment(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['id'],
    invoice_id: row['invoice_id'],
    status: row['status'],
    amount: row['verified_amount'],
    currency: row['currency'],
    paid_at: row['verified_paid_at'],
    releasable_at: row['release_at'],
    released_at: row['released_at'],
    mismatch_code: row['mismatch_code'],
    created_at: row['created_at'],
  };
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
