/**
 * Outbound merchant webhooks.
 *
 * SPEC 04 / 117.59: HMAC-SHA256 signed, idempotent by Event ID, retried with
 * exponential backoff.
 * SPEC 4347: delivery happens AFTER the financial transaction commits — this
 * module is only ever driven by the outbox dispatcher.
 * SSRF protection: only https (in production) and no private/loopback hosts.
 */

import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Database } from '../../database/src/client.ts';
import { signOutboundWebhook, sha256Hex } from '../../crypto/src/index.ts';
import type { EventEnvelope } from './outbox.ts';
import { ValidationError } from '../../errors/src/index.ts';

/** Which internal events are visible to merchants, and under what name. */
const MERCHANT_EVENT_MAP: Record<string, string> = {
  'payment.verified': 'payment.paid',
  'payment.released': 'payment.releasable',
  'payout.queued': 'payout.queued',
  'payout.waiting_liquidity': 'payout.waiting_liquidity',
  'payout.broadcasted': 'payout.processing',
  'payout.confirmed': 'payout.completed',
  'payout.failed': 'payout.failed',
};

export function merchantEventName(internalType: string): string | null {
  return MERCHANT_EVENT_MAP[internalType] ?? null;
}

/** Reject URLs that point at internal infrastructure (SSRF defence). */
export async function assertSafeWebhookUrl(
  raw: string,
  allowedSchemes: readonly string[],
  options: { allowPrivate?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('INVALID_WEBHOOK_URL', 'webhook URL is not a valid URL');
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (!allowedSchemes.includes(scheme)) {
    throw new ValidationError(
      'INVALID_WEBHOOK_SCHEME',
      `webhook URL scheme must be one of: ${allowedSchemes.join(', ')}`,
    );
  }
  if (url.username || url.password) {
    throw new ValidationError('INVALID_WEBHOOK_URL', 'webhook URL must not embed credentials');
  }
  if (options.allowPrivate) return url;

  const host = url.hostname;
  const addresses: string[] = [];
  if (isIP(host)) {
    addresses.push(host);
  } else {
    try {
      const resolved = await lookup(host, { all: true });
      addresses.push(...resolved.map((r) => r.address));
    } catch {
      throw new ValidationError('WEBHOOK_HOST_UNRESOLVABLE', 'webhook host could not be resolved');
    }
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new ValidationError(
        'WEBHOOK_PRIVATE_HOST',
        'webhook URL must not resolve to a private or loopback address',
      );
    }
  }
  return url;
}

export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const parts = address.split('.').map((p) => Number.parseInt(p, 10));
    const [a, b] = parts as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // IPv4-mapped addresses must be checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1] as string);
    return false;
  }
  return true; // not an IP literal at all: refuse
}

export interface WebhookTarget {
  merchantId: string;
  url: string;
  secret: string;
}

/**
 * Register a delivery for every subscribed endpoint of the aggregate's merchant.
 * Uses the envelope id as the delivery's event id so redelivery is detectable
 * by the merchant.
 */
export async function scheduleMerchantDeliveries(
  db: Database,
  envelope: EventEnvelope,
): Promise<number> {
  const externalType = merchantEventName(envelope.type);
  if (!externalType) return 0;

  const merchantId =
    typeof envelope.payload['merchant_id'] === 'string'
      ? (envelope.payload['merchant_id'] as string)
      : envelope.aggregateType === 'MERCHANT'
        ? envelope.aggregateId
        : null;
  if (!merchantId) return 0;

  const endpoints = await db.query<{ id: string; url: string; secret_reference: string }>(
    `SELECT id, url, secret_reference
       FROM core.webhook_endpoints
      WHERE merchant_id = $1 AND status = 'ACTIVE'
        AND (event_types IS NULL OR $2 = ANY(event_types))`,
    [merchantId, externalType],
  );
  if (endpoints.rows.length === 0) return 0;

  const body = JSON.stringify({
    id: envelope.id,
    type: externalType,
    created_at: envelope.occurredAt,
    data: envelope.payload,
  });

  let scheduled = 0;
  for (const endpoint of endpoints.rows) {
    const r = await db.query(
      `INSERT INTO integration.webhook_deliveries
          (id, endpoint_id, merchant_id, event_id, event_type, payload, payload_hash, status, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'PENDING',NOW())
       ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
      [randomUUID(), endpoint.id, merchantId, envelope.id, externalType, body, sha256Hex(body)],
    );
    scheduled += r.rowCount;
  }
  return scheduled;
}

export interface DeliveryOutcome {
  deliveryId: string;
  status: 'SENT' | 'RETRY' | 'DEAD';
  httpStatus?: number;
  error?: string;
}

/**
 * Attempt the pending deliveries.
 * A 2xx is success; 4xx (other than 408/429) is permanent and goes DEAD
 * immediately because retrying a rejected payload only wastes the endpoint.
 */
export async function dispatchWebhooks(
  db: Database,
  options: {
    batchSize?: number;
    timeoutMs: number;
    maxAttempts: number;
    allowedSchemes: readonly string[];
    allowPrivate?: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<DeliveryOutcome[]> {
  const batchSize = options.batchSize ?? 20;
  const doFetch = options.fetchImpl ?? fetch;

  const claimed = await db.transaction(async (tx) => {
    const r = await tx.query<{
      id: string;
      url: string;
      secret_reference: string;
      payload: unknown;
      event_id: string;
      event_type: string;
      attempts: number;
    }>(
      `SELECT d.id, e.url, e.secret_reference, d.payload, d.event_id, d.event_type, d.attempts
         FROM integration.webhook_deliveries d
         JOIN core.webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.status IN ('PENDING','RETRY')
          AND d.next_attempt_at <= NOW()
          AND e.status = 'ACTIVE'
        ORDER BY d.next_attempt_at ASC
        LIMIT $1
        FOR UPDATE OF d SKIP LOCKED`,
      [batchSize],
    );
    if (r.rows.length > 0) {
      await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = 'SENDING', attempts = attempts + 1, last_attempt_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [r.rows.map((row) => row.id)],
      );
    }
    return r.rows;
  });

  const outcomes: DeliveryOutcome[] = [];

  for (const delivery of claimed) {
    const attempts = delivery.attempts + 1;
    const body =
      typeof delivery.payload === 'string' ? delivery.payload : JSON.stringify(delivery.payload);

    try {
      await assertSafeWebhookUrl(delivery.url, options.allowedSchemes, {
        allowPrivate: options.allowPrivate,
      });

      const { timestamp, signature } = signOutboundWebhook(
        delivery.secret_reference,
        body,
        Math.floor(Date.now() / 1000),
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      let httpStatus: number;
      try {
        const res = await doFetch(delivery.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'GramGateway-Webhook/1',
            'X-Gateway-Event-Id': delivery.event_id,
            'X-Gateway-Event-Type': delivery.event_type,
            'X-Gateway-Event-Timestamp': timestamp,
            'X-Gateway-Event-Signature': signature,
            'X-Gateway-Delivery-Attempt': String(attempts),
          },
          body,
          signal: controller.signal,
          redirect: 'error', // a redirect could bypass the SSRF check
        });
        httpStatus = res.status;
        // Drain so the socket can be reused; the body itself is ignored.
        await res.text().catch(() => '');
      } finally {
        clearTimeout(timer);
      }

      if (httpStatus >= 200 && httpStatus < 300) {
        await db.query(
          `UPDATE integration.webhook_deliveries
              SET status = 'SENT', response_status = $2, delivered_at = NOW(), last_error = NULL
            WHERE id = $1`,
          [delivery.id, httpStatus],
        );
        outcomes.push({ deliveryId: delivery.id, status: 'SENT', httpStatus });
        continue;
      }

      const permanent = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429;
      outcomes.push(
        await recordFailure(db, delivery.id, attempts, options.maxAttempts, {
          httpStatus,
          error: `endpoint returned ${httpStatus}`,
          permanent,
        }),
      );
    } catch (e) {
      outcomes.push(
        await recordFailure(db, delivery.id, attempts, options.maxAttempts, {
          error: e instanceof Error ? e.message : String(e),
          // A URL that fails validation will never become valid on retry.
          permanent: e instanceof ValidationError,
        }),
      );
    }
  }

  return outcomes;
}

async function recordFailure(
  db: Database,
  deliveryId: string,
  attempts: number,
  maxAttempts: number,
  info: { httpStatus?: number; error: string; permanent: boolean },
): Promise<DeliveryOutcome> {
  const dead = info.permanent || attempts >= maxAttempts;
  if (dead) {
    await db.query(
      `UPDATE integration.webhook_deliveries
          SET status = 'DEAD', response_status = $2, last_error = $3
        WHERE id = $1`,
      [deliveryId, info.httpStatus ?? null, info.error.slice(0, 500)],
    );
    return { deliveryId, status: 'DEAD', httpStatus: info.httpStatus, error: info.error };
  }

  // Exponential backoff, capped at one hour.
  await db.query(
    `UPDATE integration.webhook_deliveries
        SET status = 'RETRY', response_status = $2, last_error = $3,
            next_attempt_at = NOW() + (LEAST(POWER(2, attempts)::int, 3600) || ' seconds')::interval
      WHERE id = $1`,
    [deliveryId, info.httpStatus ?? null, info.error.slice(0, 500)],
  );
  return { deliveryId, status: 'RETRY', httpStatus: info.httpStatus, error: info.error };
}
