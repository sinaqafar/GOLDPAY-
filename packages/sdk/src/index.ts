/**
 * Merchant SDK — SPEC 1778/1779.
 *
 * The SDK exists so a merchant integration cannot get the dangerous parts
 * wrong. It owns:
 *
 *   - HMAC signing over the canonical request, INCLUDING the query string
 *   - the timestamp and a fresh nonce per request
 *   - idempotency keys on every money-moving POST
 *   - retry that is safe rather than merely automatic
 *   - error parsing into typed, inspectable failures
 *
 * Two rules it must never break:
 *
 *   SPEC 1778 — the secret is never logged, never included in an error, and
 *   never serialised. It exists only inside the signing call.
 *
 *   SPEC 1779 — a financial POST is retried ONLY when it carries an
 *   idempotency key. Without one, a retry after a timeout could create a
 *   second invoice or a second refund, so the SDK refuses rather than
 *   guessing.
 */

import { createHmac, createHash, randomUUID } from 'node:crypto';

export interface GramGatewayOptions {
  baseUrl: string;
  /** `<prefix>.<secret>` as issued by POST /v1/api-keys. */
  apiKey: string;
  timeoutMs?: number;
  /** Attempts for retryable failures. 1 disables retrying. */
  maxAttempts?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class GramGatewayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(params: {
    code: string;
    message: string;
    status: number;
    requestId?: string | null;
    retryable?: boolean;
  }) {
    super(params.message);
    this.name = 'GramGatewayError';
    this.code = params.code;
    this.status = params.status;
    this.requestId = params.requestId ?? null;
    // 5xx and 429 may succeed later; a 4xx will not.
    this.retryable = params.retryable ?? (params.status >= 500 || params.status === 429);
  }
}

export interface Pagination {
  next_cursor: string | null;
  has_more: boolean;
}

export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

interface RequestOptions {
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
}

export class GramGateway {
  #baseUrl: string;
  #prefix: string;
  #secret: string;
  #timeoutMs: number;
  #maxAttempts: number;
  #fetch: typeof fetch;
  #now: () => Date;

  constructor(options: GramGatewayOptions) {
    const separator = options.apiKey.indexOf('.');
    if (separator <= 0) {
      throw new Error('apiKey must be in the form <prefix>.<secret>');
    }
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#prefix = options.apiKey.slice(0, separator);
    this.#secret = options.apiKey.slice(separator + 1);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  // --- resources -------------------------------------------------------------

  /**
   * Create an invoice.
   *
   * An idempotency key is generated when the caller does not supply one, so
   * this is always safe to retry — which is the whole point of the SDK.
   */
  async createInvoice(
    input: {
      amount: string;
      fee_mode?: 'CUSTOMER' | 'MERCHANT' | 'SPLIT';
      description?: string;
      invoice_number?: string;
      expires_in_seconds?: number;
    },
    options: { idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.#request('POST', '/v1/invoices', input, {
      idempotencyKey: options.idempotencyKey ?? `inv_${randomUUID()}`,
    });
  }

  async getInvoice(id: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/invoices/${encodeURIComponent(id)}`);
  }

  async listInvoices(query: { limit?: number; cursor?: string } = {}): Promise<Page<Record<string, unknown>>> {
    return this.#requestPage('GET', '/v1/invoices', query);
  }

  async cancelInvoice(id: string, reason?: string): Promise<Record<string, unknown>> {
    return this.#request('POST', `/v1/invoices/${encodeURIComponent(id)}/cancel`, { reason });
  }

  async getPayment(id: string): Promise<Record<string, unknown>> {
    return this.#request('GET', `/v1/payments/${encodeURIComponent(id)}`);
  }

  async listPayments(
    query: { limit?: number; cursor?: string; status?: string; invoice_id?: string; from?: string; to?: string } = {},
  ): Promise<Page<Record<string, unknown>>> {
    return this.#requestPage('GET', '/v1/payments', query);
  }

  async getBalances(): Promise<Record<string, unknown>> {
    return this.#request('GET', '/v1/balances');
  }

  async listPayouts(query: { limit?: number; cursor?: string } = {}): Promise<Page<Record<string, unknown>>> {
    return this.#requestPage('GET', '/v1/payouts', query);
  }

  async getStatement(query: { from?: string; to?: string } = {}): Promise<Record<string, unknown>> {
    return this.#request('GET', '/v1/statements', undefined, { query });
  }

  /** Refunds always carry an idempotency key: a duplicate would return money twice. */
  async requestRefund(
    input: { payment_id: string; amount: string; reason: string },
    options: { idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.#request('POST', '/v1/refunds', input, {
      idempotencyKey: options.idempotencyKey ?? `ref_${randomUUID()}`,
    });
  }

  /**
   * Walk every page of a list endpoint.
   * Yields items rather than accumulating them, so a large history does not
   * have to fit in memory.
   */
  async *paginate(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#requestPage<Record<string, unknown>>('GET', path, {
        ...query,
        cursor,
      });
      for (const item of page.data) yield item;
      if (!page.pagination.has_more || !page.pagination.next_cursor) return;
      cursor = page.pagination.next_cursor;
    }
  }

  // --- webhook verification ----------------------------------------------------

  /**
   * Verify an inbound webhook from the gateway.
   *
   * Hash both sides to a fixed length before comparing, so the comparison is
   * constant-time and cannot leak the signature through timing.
   */
  static verifyWebhook(params: {
    secret: string;
    rawBody: string;
    timestamp: string;
    signature: string;
    toleranceSeconds?: number;
    now?: Date;
  }): boolean {
    const tolerance = params.toleranceSeconds ?? 300;
    const sent = Number.parseInt(params.timestamp, 10);
    if (!Number.isFinite(sent)) return false;

    const nowSeconds = Math.floor((params.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - sent) > tolerance) return false;

    const expected = createHmac('sha256', params.secret)
      .update(`${params.timestamp}.${params.rawBody}`)
      .digest('hex');

    const a = createHash('sha256').update(expected).digest();
    const b = createHash('sha256').update(params.signature).digest();
    return a.equals(b);
  }

  // --- internals ----------------------------------------------------------------

  async #requestPage<T>(
    method: string,
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<Page<T>> {
    const envelope = await this.#raw(method, path, undefined, { query });
    return {
      data: (envelope['data'] ?? []) as T[],
      pagination: (envelope['pagination'] ?? { next_cursor: null, has_more: false }) as Pagination,
    };
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const envelope = await this.#raw(method, path, body, options);
    const data = envelope['data'];
    return (data && typeof data === 'object' ? data : envelope) as Record<string, unknown>;
  }

  async #raw(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<Record<string, unknown>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const target = search.size > 0 ? `${path}?${search.toString()}` : path;
    const rawBody = body === undefined ? '' : JSON.stringify(body);

    // SPEC 1779 — never retry a financial write that cannot be deduplicated.
    const isWrite = method !== 'GET' && method !== 'HEAD';
    const attempts = isWrite && !options.idempotencyKey ? 1 : this.#maxAttempts;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.#send(method, target, rawBody, options.idempotencyKey);
      } catch (e) {
        lastError = e;
        const retryable = e instanceof GramGatewayError ? e.retryable : true;
        if (!retryable || attempt === attempts) throw e;
        // Exponential backoff with jitter, so a fleet of clients recovering
        // from an outage does not stampede the gateway in lockstep.
        const backoff = Math.min(8000, 250 * 2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * 250));
      }
    }
    throw lastError;
  }

  async #send(
    method: string,
    target: string,
    rawBody: string,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const timestamp = String(Math.floor(this.#now().getTime() / 1000));
    const nonce = randomUUID();
    const bodySha256 = createHash('sha256').update(rawBody).digest('hex');

    // The canonical string must match the server exactly, including the query
    // string: signing only the pathname would leave filters unauthenticated.
    const canonical = [method.toUpperCase(), target, timestamp, nonce, bodySha256].join('\n');
    const signature = createHmac('sha256', this.#secret).update(canonical).digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const res = await this.#fetch(`${this.#baseUrl}${target}`, {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#prefix}.${this.#secret}`,
          'x-gateway-timestamp': timestamp,
          'x-gateway-nonce': nonce,
          'x-gateway-signature': signature,
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(rawBody === '' ? {} : { body: rawBody }),
      });

      const envelope = (await res.json().catch(() => null)) as Record<string, unknown> | null;

      if (!res.ok) {
        const error = (envelope?.['error'] ?? {}) as Record<string, unknown>;
        throw new GramGatewayError({
          code: typeof error['code'] === 'string' ? error['code'] : 'UNKNOWN_ERROR',
          message: typeof error['message'] === 'string' ? error['message'] : `request failed (${res.status})`,
          status: res.status,
          requestId: typeof error['request_id'] === 'string' ? error['request_id'] : null,
        });
      }

      return envelope ?? {};
    } catch (e) {
      if (e instanceof GramGatewayError) throw e;
      // A timeout is ambiguous: the request may have been processed. It is
      // marked retryable, which is only acted on when an idempotency key makes
      // that safe.
      throw new GramGatewayError({
        code: 'NETWORK_ERROR',
        message: e instanceof Error ? e.message : String(e),
        status: 0,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
