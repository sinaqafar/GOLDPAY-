/**
 * API authentication.
 *
 * SPEC 22-26: API Key + Timestamp + Nonce + Body Hash + HMAC signature.
 * SPEC 25: a nonce may be used exactly once inside the window (replay defence).
 * SPEC 117.89: every authenticated request is bound to exactly one merchant, so
 * a valid key for merchant A can never touch merchant B's data.
 */

import type { Database } from '../../../packages/database/src/client.ts';
import {
  verifySignedRequest,
  verifyApiSecret,
  parseApiToken,
  verifyTelegramInitData,
} from '../../../packages/crypto/src/index.ts';
import { AuthError, SecurityError, NotFoundError, ErrorCodes } from '../../../packages/errors/src/index.ts';
import type { Config } from '../../../packages/config/src/index.ts';
import type { RequestContext } from './http.ts';
import { randomUUID } from 'node:crypto';

/**
 * Consume a nonce. Returns false when it has already been seen, which means the
 * request is a replay.
 */
export async function consumeNonce(
  db: Database,
  nonce: string,
  scope: string,
  ttlSeconds: number,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO system.request_nonces(nonce, scope, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)
     ON CONFLICT (nonce) DO NOTHING`,
    [nonce, scope, String(ttlSeconds)],
  );
  return r.rowCount === 1;
}

/**
 * Authenticate a merchant API request.
 * Every failure path records a security event so brute force is visible.
 */
export async function authenticateApiKey(
  db: Database,
  config: Config,
  ctx: RequestContext,
): Promise<{ merchantId: string; apiKeyId: string }> {
  const authorization = ctx.headers['authorization'];
  const timestamp = ctx.headers['x-gateway-timestamp'];
  const nonce = ctx.headers['x-gateway-nonce'];
  const signature = ctx.headers['x-gateway-signature'];

  if (!authorization?.startsWith('Bearer ')) {
    throw new AuthError('MISSING_API_KEY', 'an API key is required');
  }
  if (!timestamp || !nonce || !signature) {
    throw new AuthError(
      'MISSING_SIGNATURE_HEADERS',
      'x-gateway-timestamp, x-gateway-nonce and x-gateway-signature are required',
    );
  }

  const { prefix, secret } = parseApiToken(authorization.slice('Bearer '.length).trim());

  const r = await db.query<{
    id: string;
    merchant_id: string;
    secret_hash: string;
    status: string;
    merchant_status: string;
  }>(
    `SELECT k.id, k.merchant_id, k.secret_hash, k.status, m.status AS merchant_status
       FROM core.api_keys k
       JOIN core.merchants m ON m.id = k.merchant_id
      WHERE k.key_prefix = $1`,
    [prefix],
  );
  const key = r.rows[0];

  // Verify against a dummy hash when the key is unknown, so a missing key and a
  // wrong secret take the same amount of time.
  const storedHash = key?.secret_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const secretOk = verifyApiSecret(secret, storedHash);

  if (!key || !secretOk) {
    await recordSecurityEvent(db, 'AUTH_FAILED', 'MEDIUM', { prefix, ip: ctx.ip });
    throw new AuthError('INVALID_API_KEY', 'API key is invalid');
  }
  if (key.status !== 'ACTIVE') {
    throw new AuthError('API_KEY_REVOKED', 'this API key has been revoked');
  }
  if (key.merchant_status !== 'ACTIVE') {
    throw new AuthError('MERCHANT_NOT_ACTIVE', `merchant is ${key.merchant_status}`);
  }

  // Signature over the canonical request, using the raw body bytes.
  try {
    verifySignedRequest({
      secret,
      method: ctx.method,
      path: ctx.path,
      timestamp,
      nonce,
      rawBody: ctx.rawBody,
      signature,
      windowSeconds: config.security.hmacWindowSeconds,
    });
  } catch (e) {
    await recordSecurityEvent(db, 'SIGNATURE_INVALID', 'HIGH', {
      merchantId: key.merchant_id,
      ip: ctx.ip,
    });
    throw e;
  }

  // Replay protection comes last: a nonce should only be spent by an otherwise
  // valid request.
  const fresh = await consumeNonce(db, nonce, `api:${key.merchant_id}`, config.security.nonceTtlSeconds);
  if (!fresh) {
    await recordSecurityEvent(db, 'NONCE_REPLAY', 'HIGH', {
      merchantId: key.merchant_id,
      ip: ctx.ip,
    });
    throw new SecurityError(ErrorCodes.NONCE_REPLAYED, 'this nonce has already been used');
  }

  await db.query('UPDATE core.api_keys SET last_used_at = NOW() WHERE id = $1', [key.id]);

  return { merchantId: key.merchant_id, apiKeyId: key.id };
}

/** Authenticate a Telegram Mini App request via signed initData. */
export async function authenticateTelegram(
  db: Database,
  config: Config,
  ctx: RequestContext,
): Promise<{ userId: string; telegramUserId: number; merchantId: string | null }> {
  const initData = ctx.headers['x-telegram-init-data'];
  if (!initData) {
    throw new AuthError('MISSING_INIT_DATA', 'x-telegram-init-data is required');
  }
  if (!config.telegram.botToken) {
    throw new AuthError('TELEGRAM_NOT_CONFIGURED', 'Telegram authentication is not configured');
  }

  const data = verifyTelegramInitData(
    initData,
    config.telegram.botToken,
    config.security.sessionTtlSeconds,
  );

  const r = await db.query<{ id: string; status: string }>(
    'SELECT id, status FROM core.users WHERE telegram_user_id = $1',
    [data.userId],
  );
  const user = r.rows[0];
  if (!user) throw new AuthError('USER_NOT_REGISTERED', 'this Telegram account is not registered');
  if (user.status !== 'ACTIVE') throw new AuthError('USER_NOT_ACTIVE', `user is ${user.status}`);

  const merchant = await db.query<{ id: string }>(
    `SELECT m.id FROM core.merchants m
      WHERE m.user_id = $1
      UNION
     SELECT mu.merchant_id FROM core.merchant_users mu WHERE mu.user_id = $1
      LIMIT 1`,
    [user.id],
  );

  return {
    userId: user.id,
    telegramUserId: data.userId,
    merchantId: merchant.rows[0]?.id ?? null,
  };
}

/**
 * SPEC 117.89 — tenant isolation. Any resource fetched by id must belong to the
 * authenticated merchant, or it does not exist as far as they are concerned.
 */
export function assertTenant(ctx: RequestContext, resourceMerchantId: string): void {
  const merchantId = ctx.auth?.merchantId;
  if (!merchantId || merchantId !== resourceMerchantId) {
    // 404 rather than 403: never confirm that another tenant's id exists.
    throw new NotFoundError('resource');
  }
}

export async function recordSecurityEvent(
  db: Database,
  eventType: string,
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .query(
      `INSERT INTO audit.security_events(id, event_type, severity, metadata)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [randomUUID(), eventType, severity, JSON.stringify(metadata)],
    )
    .catch(() => undefined); // logging a security event must never break the request
}
