/**
 * packages/crypto — signatures, key hashing and replay protection.
 *
 * SPEC 22-26: API auth is API-Key + Timestamp + Nonce + Body-Hash + HMAC over a
 * strictly ordered canonical request.
 * SPEC 7331/7332: client and server hash the exact same RAW body.
 * All comparisons are constant-time to avoid timing oracles.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import { SecurityError, ErrorCodes, ValidationError } from '../../errors/src/index.ts';

/** Constant-time string comparison that never short-circuits on length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Hash both sides so differing lengths cannot leak via an early return.
  const ah = createHash('sha256').update(ab).digest();
  const bh = createHash('sha256').update(bb).digest();
  return timingSafeEqual(ah, bh);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * SPEC 7321-7323 — the canonical request string.
 * Fields are joined with '\n' in a fixed order so whitespace can never create
 * signature ambiguity.
 */
export function canonicalRequest(parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256,
  ].join('\n');
}

export function signRequest(secret: string, parts: Parameters<typeof canonicalRequest>[0]): string {
  return hmacSha256Hex(secret, canonicalRequest(parts));
}

export interface VerifyRequestInput {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  /** The exact bytes received, before any JSON parsing. */
  rawBody: string;
  signature: string;
  /** Allowed clock skew in seconds (SPEC 7324-7327). */
  windowSeconds: number;
  now?: Date;
}

/**
 * Verify an inbound signed request.
 * Throws a typed SecurityError; nonce replay is checked separately because it
 * requires a database round-trip.
 */
export function verifySignedRequest(input: VerifyRequestInput): void {
  const now = input.now ?? new Date();

  if (!/^\d{1,15}$/.test(input.timestamp)) {
    throw new SecurityError(ErrorCodes.TIMESTAMP_OUT_OF_WINDOW, 'malformed timestamp');
  }
  const ts = Number.parseInt(input.timestamp, 10);
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - ts);
  if (skew > input.windowSeconds) {
    throw new SecurityError(ErrorCodes.TIMESTAMP_OUT_OF_WINDOW, 'request timestamp is outside the allowed window', {
      skewSeconds: skew,
    });
  }

  if (!input.nonce || input.nonce.length < 8 || input.nonce.length > 128) {
    throw new SecurityError('INVALID_NONCE', 'nonce must be 8..128 characters');
  }

  const expected = signRequest(input.secret, {
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodySha256: sha256Hex(input.rawBody),
  });

  if (!safeEqual(expected, input.signature)) {
    throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'signature verification failed');
  }
}

/**
 * Verify an inbound provider webhook.
 * Signature is computed over `timestamp.rawBody` so a captured body cannot be
 * replayed later with a fresh timestamp.
 */
export function verifyWebhookSignature(params: {
  secret: string;
  rawBody: string;
  timestamp: string;
  signature: string;
  windowSeconds: number;
  now?: Date;
}): void {
  const now = params.now ?? new Date();
  if (!/^\d{1,15}$/.test(params.timestamp)) {
    throw new SecurityError(ErrorCodes.TIMESTAMP_OUT_OF_WINDOW, 'malformed webhook timestamp');
  }
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number.parseInt(params.timestamp, 10));
  if (skew > params.windowSeconds) {
    throw new SecurityError(ErrorCodes.TIMESTAMP_OUT_OF_WINDOW, 'webhook timestamp is outside the allowed window');
  }
  const expected = hmacSha256Hex(params.secret, `${params.timestamp}.${params.rawBody}`);
  if (!safeEqual(expected, params.signature)) {
    throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'webhook signature verification failed');
  }
}

/** Sign an outbound webhook to a merchant (SPEC 04 · Webhook headers). */
export function signOutboundWebhook(
  secret: string,
  rawBody: string,
  timestamp: number,
): { timestamp: string; signature: string } {
  const ts = String(timestamp);
  return { timestamp: ts, signature: hmacSha256Hex(secret, `${ts}.${rawBody}`) };
}

// ---------------------------------------------------------------------------
// API keys (SPEC 118.38 / 118.39): only a hash is stored and the plaintext
// secret is shown exactly once, at creation.
// ---------------------------------------------------------------------------

export interface GeneratedApiKey {
  /** Public, indexable identifier. */
  prefix: string;
  /** Full token handed to the merchant once: `<prefix>.<secret>`. */
  token: string;
  /** What gets persisted. */
  secretHash: string;
}

const SCRYPT_KEYLEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

export function generateApiKey(): GeneratedApiKey {
  const prefix = `gp_${randomBytes(6).toString('hex')}`;
  const secret = randomBytes(32).toString('base64url');
  return { prefix, token: `${prefix}.${secret}`, secretHash: hashApiSecret(secret) };
}

export function hashApiSecret(secret: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(secret, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyApiSecret(secret: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1] as string, 'base64');
    const expected = Buffer.from(parts[2] as string, 'base64');
    const derived = scryptSync(secret, salt, expected.length, SCRYPT_PARAMS);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function parseApiToken(token: string): { prefix: string; secret: string } {
  const idx = token.indexOf('.');
  if (idx <= 0 || idx === token.length - 1) {
    throw new ValidationError('MALFORMED_API_KEY', 'API key must be in the form <prefix>.<secret>');
  }
  return { prefix: token.slice(0, idx), secret: token.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Telegram Mini App initData (core.telegram.org/bots/webapps)
// ---------------------------------------------------------------------------

export interface TelegramInitData {
  userId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  authDate: number;
}

/**
 * Validate Telegram Mini App `initData`.
 * The secret key is HMAC("WebAppData", botToken) and the check string is the
 * sorted `key=value` pairs excluding `hash`.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86_400,
  now: Date = new Date(),
): TelegramInitData {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'initData is missing its hash');

  const pairs: string[] = [];
  for (const [k, v] of [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  const checkString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (!safeEqual(computed, hash)) {
    throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'initData signature is invalid');
  }

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) {
    throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'initData is missing auth_date');
  }
  const authDate = Number.parseInt(authDateRaw, 10);
  if (Math.floor(now.getTime() / 1000) - authDate > maxAgeSeconds) {
    throw new SecurityError(ErrorCodes.TIMESTAMP_OUT_OF_WINDOW, 'initData has expired');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'initData is missing user');
  let user: { id?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown };
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'initData user is not valid JSON');
  }
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id)) {
    throw new SecurityError(ErrorCodes.INVALID_SIGNATURE, 'initData user id is invalid');
  }

  return {
    userId: user.id,
    username: typeof user.username === 'string' ? user.username : undefined,
    firstName: typeof user.first_name === 'string' ? user.first_name : undefined,
    lastName: typeof user.last_name === 'string' ? user.last_name : undefined,
    authDate,
  };
}

export function randomNonce(): string {
  return randomBytes(16).toString('hex');
}
