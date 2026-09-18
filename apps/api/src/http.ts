/**
 * A small, explicit HTTP layer built on node:http.
 *
 * Why not a framework: signature verification requires the EXACT raw bytes of
 * the body (SPEC 7331/7332). Frameworks that parse JSON for you make that
 * subtly hard to guarantee, and a payment gateway should not be guessing about
 * which bytes were signed. Here the raw body is read once and both the parsed
 * value and the original string are carried on the request.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../packages/errors/src/index.ts';
import {
  ruleFor,
  type TokenBucketRateLimiter,
} from '../../../packages/core/src/rate-limit.ts';
import { createHash } from 'node:crypto';
import type { Logger } from '../../../packages/core/src/logger.ts';

export interface RequestContext {
  method: string;
  path: string;
  /**
   * The full request target: pathname plus query string.
   * This is what request signatures cover, so query parameters cannot be
   * altered in flight while a signature still verifies.
   */
  target: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
  rawBody: string;
  body: unknown;
  requestId: string;
  ip: string;
  /** Populated by authentication middleware. */
  auth?: {
    kind: 'API_KEY' | 'TELEGRAM' | 'ADMIN';
    merchantId?: string;
    userId?: string;
    roles?: string[];
  };
}

export interface HttpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<HttpResult> | HttpResult;

interface Route {
  method: string;
  /** Path pattern with `:name` segments. */
  pattern: string;
  segments: string[];
  handler: Handler;
}

const MAX_BODY_BYTES = 1_000_000; // 1 MB is far more than any legitimate request

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  del(p: string, h: Handler) { return this.add('DELETE', p, h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.#routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i] as string;
        const value = parts[i] as string;
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }

  /**
   * Which methods this path would accept.
   * SPEC 97.30: an unknown method on a known path is 405, not 404 — the
   * resource exists, the verb is wrong, and the caller deserves to know.
   */
  allowedMethods(path: string): string[] {
    const parts = path.split('/').filter(Boolean);
    const allowed = new Set<string>();
    for (const route of this.#routes) {
      if (route.segments.length !== parts.length) continue;
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i] as string;
        if (segment.startsWith(':')) continue;
        if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) allowed.add(route.method);
    }
    return [...allowed].sort();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError('PAYLOAD_TOO_LARGE', 'VALIDATION', 'request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface ServerOptions {
  router: Router;
  logger: Logger;
  /** Trust `x-forwarded-for` only behind a known proxy. */
  trustProxy?: boolean;
  /** Omit to disable rate limiting (tests, single-user development). */
  rateLimiter?: TokenBucketRateLimiter;
}

export function createHttpServer(options: ServerOptions): Server {
  const { router, logger } = options;
  const rateLimiter = options.rateLimiter;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((e) => {
      logger.error('http.unhandled', { message: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } }));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = headerValue(req, 'x-request-id') ?? randomUUID();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const send = (result: HttpResult) => {
      // SPEC 101329/101331 — every response carries its request_id, inside the
      // envelope as well as in the header, so a caller can quote one id when
      // reporting a problem.
      const payload = result.body === undefined ? '' : JSON.stringify(withEnvelope(result.body, requestId));
      res.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
        'x-request-id': requestId,
        // Conservative defaults: this API serves machines, not browsers.
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        ...result.headers,
      });
      res.end(payload);
      logger.info('http.request', {
        method: req.method,
        path: url.pathname,
        status: result.status,
        ms: Date.now() - started,
        requestId,
      });
    };

    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const match = router.match(method, url.pathname);
      if (!match) {
        // Distinguish "no such resource" from "wrong verb" (SPEC 97.30).
        const allowed = router.allowedMethods(url.pathname);
        if (allowed.length > 0) {
          send({
            status: 405,
            headers: { allow: allowed.join(', ') },
            body: {
              error: {
                code: 'METHOD_NOT_ALLOWED',
                message: `${method} is not allowed on this path`,
                retryable: false,
              },
            },
          });
          return;
        }
        send({
          status: 404,
          body: { error: { code: 'NOT_FOUND', message: 'route not found', retryable: false } },
        });
        return;
      }

      const rawBody = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
      let body: unknown = undefined;
      if (rawBody) {
        const contentType = headerValue(req, 'content-type') ?? '';
        // SPEC 97.31 — a JSON API must not silently accept a body it did not
        // parse. Guessing the type of a financial payload is not acceptable.
        if (!contentType.includes('application/json')) {
          send({
            status: 415,
            body: {
              error: {
                code: 'UNSUPPORTED_MEDIA_TYPE',
                message: 'content-type must be application/json',
                retryable: false,
              },
            },
          });
          return;
        }
        try {
          body = JSON.parse(rawBody);
        } catch {
          send({
            status: 400,
            body: {
              error: { code: 'INVALID_JSON', message: 'request body is not valid JSON', retryable: false },
            },
          });
          return;
        }
      }

      const ip = options.trustProxy
        ? (headerValue(req, 'x-forwarded-for')?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '')
        : (req.socket.remoteAddress ?? '');

      if (rateLimiter) {
        // Key on the credential where one exists, falling back to IP. Keying on
        // IP alone would let every caller behind one NAT share a single budget,
        // and would let a caller rotate IPs to escape the limit entirely.
        const credential = headerValue(req, 'authorization');
        const identity = credential ? `key:${sha256Short(credential)}` : `ip:${ip}`;
        const { name, rule } = ruleFor(method, url.pathname);
        const decision = rateLimiter.check(`${identity}:${name}`, rule);

        if (!decision.allowed) {
          logger.warn('http.rate_limited', { path: url.pathname, bucket: name, requestId });
          send({
            status: 429,
            headers: {
              'retry-after': String(decision.retryAfterSeconds),
              'x-ratelimit-limit': String(decision.limit),
              'x-ratelimit-remaining': '0',
            },
            body: {
              error: {
                code: 'RATE_LIMITED',
                message: 'too many requests',
                retryable: true,
              },
            },
          });
          return;
        }
      }

      const ctx: RequestContext = {
        method,
        path: url.pathname,
        target: url.pathname + (url.search || ''),
        query: url.searchParams,
        params: match.params,
        headers: req.headers as Record<string, string | undefined>,
        rawBody,
        body,
        requestId,
        ip,
      };

      send(await match.handler(ctx));
    } catch (e) {
      send(toErrorResponse(e, logger, requestId));
    }
  }
}

/**
 * Wrap a handler's body in the standard envelope (SPEC 101329/101331).
 *
 *   success →  { "data": …, "meta": { "request_id": … } }
 *   error   →  { "error": { code, message, request_id } }
 *
 * A body that already looks like an envelope is passed through with the id
 * added, so handlers that return `{ data, pagination }` keep their shape.
 */
function withEnvelope(body: unknown, requestId: string): unknown {
  if (body === null || typeof body !== 'object') {
    return { data: body, meta: { request_id: requestId } };
  }
  const record = body as Record<string, unknown>;

  if ('error' in record && typeof record['error'] === 'object' && record['error'] !== null) {
    return {
      ...record,
      error: { ...(record['error'] as Record<string, unknown>), request_id: requestId },
    };
  }

  if ('data' in record) {
    const meta = (record['meta'] as Record<string, unknown> | undefined) ?? {};
    return { ...record, meta: { ...meta, request_id: requestId } };
  }

  return { data: record, meta: { request_id: requestId } };
}

export function toErrorResponse(e: unknown, logger: Logger, requestId: string): HttpResult {
  if (e instanceof AppError) {
    // Expected, typed failures: surface the safe projection only.
    if (e.httpStatus >= 500) {
      logger.error('http.app_error', { code: e.code, message: e.message, requestId });
    } else {
      logger.warn('http.app_error', { code: e.code, message: e.message, requestId });
    }
    return { status: e.httpStatus, body: e.toPublicJSON() };
  }

  // Unexpected: never leak the message or stack to the caller.
  logger.error('http.unexpected_error', {
    message: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : undefined,
    requestId,
  });
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'internal error', retryable: true } },
  };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Short, non-reversible fingerprint of a credential, for rate-limit keying. */
function sha256Short(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
