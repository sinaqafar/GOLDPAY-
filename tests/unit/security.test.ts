/**
 * Security tests — SPEC 117.86: signature verification, replay, treasury
 * manual-only guard, and SSRF protection on outbound webhooks.
 */

import { describe, it, expect } from 'vitest';
import {
  signRequest,
  verifySignedRequest,
  verifyWebhookSignature,
  signOutboundWebhook,
  generateApiKey,
  hashApiSecret,
  verifyApiSecret,
  parseApiToken,
  verifyTelegramInitData,
  sha256Hex,
} from '../../packages/crypto/src/index.ts';
import { createHmac } from 'node:crypto';
import { loadConfig, assertTreasuryManualOnly } from '../../packages/config/src/index.ts';
import { SecurityError, ConfigError } from '../../packages/errors/src/index.ts';
import { isPrivateAddress, assertSafeWebhookUrl } from '../../packages/core/src/webhooks.ts';
import { TEST_ENV } from '../helpers/harness.ts';

const SECRET = 'test-secret-value';

describe('request signing', () => {
  const base = {
    method: 'POST',
    path: '/v1/invoices',
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: 'nonce-1234',
    rawBody: '{"amount":"1000"}',
  };

  function signed(overrides: Partial<typeof base> = {}) {
    const parts = { ...base, ...overrides };
    return {
      ...parts,
      secret: SECRET,
      windowSeconds: 300,
      signature: signRequest(SECRET, {
        method: parts.method,
        path: parts.path,
        timestamp: parts.timestamp,
        nonce: parts.nonce,
        bodySha256: sha256Hex(parts.rawBody),
      }),
    };
  }

  it('accepts a correctly signed request', () => {
    expect(() => verifySignedRequest(signed())).not.toThrow();
  });

  it('rejects a tampered body even when the signature is otherwise valid', () => {
    const req = signed();
    req.rawBody = '{"amount":"999999999"}';
    expect(() => verifySignedRequest(req)).toThrow(SecurityError);
  });

  it('rejects a tampered path — a signature is not transferable between routes', () => {
    const req = signed();
    req.path = '/v1/payouts';
    expect(() => verifySignedRequest(req)).toThrow(SecurityError);
  });

  it('rejects a signature made with the wrong secret', () => {
    const req = signed();
    req.secret = 'a-different-secret';
    expect(() => verifySignedRequest(req)).toThrow(SecurityError);
  });

  it('rejects a stale timestamp outside the window', () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(() => verifySignedRequest(signed({ timestamp: old }))).toThrow(SecurityError);
  });

  it('rejects a timestamp from the future beyond the window', () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    expect(() => verifySignedRequest(signed({ timestamp: future }))).toThrow(SecurityError);
  });

  it('rejects a missing or too-short nonce', () => {
    expect(() => verifySignedRequest(signed({ nonce: 'x' }))).toThrow(SecurityError);
  });
});

describe('webhook signatures', () => {
  it('verifies an inbound provider webhook', () => {
    const rawBody = '{"event":"payment.paid"}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
    expect(() =>
      verifyWebhookSignature({ secret: SECRET, rawBody, timestamp, signature, windowSeconds: 300 }),
    ).not.toThrow();
  });

  it('rejects a replayed body carrying an old timestamp', () => {
    const rawBody = '{"event":"payment.paid"}';
    const timestamp = String(Math.floor(Date.now() / 1000) - 7200);
    const signature = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
    expect(() =>
      verifyWebhookSignature({ secret: SECRET, rawBody, timestamp, signature, windowSeconds: 300 }),
    ).toThrow(SecurityError);
  });

  it('binds the outbound signature to the timestamp, so it cannot be reused later', () => {
    const body = '{"id":"evt_1"}';
    const a = signOutboundWebhook(SECRET, body, 1_700_000_000);
    const b = signOutboundWebhook(SECRET, body, 1_700_000_001);
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('API keys', () => {
  it('never stores the plaintext secret and verifies correctly', () => {
    const key = generateApiKey();
    const { prefix, secret } = parseApiToken(key.token);
    expect(prefix).toBe(key.prefix);
    expect(key.secretHash).not.toContain(secret);
    expect(verifyApiSecret(secret, key.secretHash)).toBe(true);
    expect(verifyApiSecret('wrong-secret', key.secretHash)).toBe(false);
  });

  it('produces a different hash for the same secret each time (salted)', () => {
    const { token } = generateApiKey();
    const { secret } = parseApiToken(token);
    expect(hashApiSecret(secret)).not.toBe(hashApiSecret(secret));
  });
});

describe('Telegram initData', () => {
  const botToken = '123456:TEST-BOT-TOKEN';

  function buildInitData(authDate: number, userId = 42): string {
    const user = JSON.stringify({ id: userId, username: 'tester' });
    const pairs = [`auth_date=${authDate}`, `user=${user}`];
    const checkString = pairs.slice().sort().join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hash = createHmac('sha256', secretKey).update(checkString).digest('hex');
    const params = new URLSearchParams({ auth_date: String(authDate), user, hash });
    return params.toString();
  }

  it('accepts valid initData and extracts the user', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = verifyTelegramInitData(buildInitData(now), botToken);
    expect(result.userId).toBe(42);
  });

  it('rejects initData signed with a different bot token', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() => verifyTelegramInitData(buildInitData(now), 'other-token')).toThrow(SecurityError);
  });

  it('rejects expired initData', () => {
    const old = Math.floor(Date.now() / 1000) - 200_000;
    expect(() => verifyTelegramInitData(buildInitData(old), botToken)).toThrow(SecurityError);
  });
});

describe('treasury manual-only guard (SPEC 4340)', () => {
  const flags = ['AUTO_FUNDING', 'AUTO_BUY', 'AUTO_SWAP', 'AUTO_EXCHANGE', 'AUTO_BRIDGE'];

  it.each(flags)('refuses to start when %s is enabled', (flag) => {
    expect(() => loadConfig({ ...TEST_ENV, [flag]: 'true' })).toThrow(ConfigError);
    try {
      loadConfig({ ...TEST_ENV, [flag]: 'true' });
    } catch (e) {
      expect((e as ConfigError).code).toBe('FORBIDDEN_TREASURY_AUTOMATION');
    }
  });

  it('starts cleanly when every automation flag is false', () => {
    expect(() => loadConfig(TEST_ENV)).not.toThrow();
  });

  it('the standalone guard also rejects a hand-built config', () => {
    expect(() =>
      assertTreasuryManualOnly({
        network: 'TON_MAINNET',
        asset: 'GRAM',
        gramDecimals: 9,
        address: null,
        autoFunding: false,
        autoBuy: true,
        autoSwap: false,
        autoExchange: false,
        autoBridge: false,
        safetyReserveGramAtomic: 0n,
      }),
    ).toThrow(ConfigError);
  });
});

describe('outbound webhook SSRF protection', () => {
  it('classifies private and loopback addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('rejects the cloud metadata endpoint', async () => {
    await expect(assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data', ['https'])).rejects.toThrow();
  });

  it('rejects http when only https is allowed', async () => {
    await expect(assertSafeWebhookUrl('http://example.com/hook', ['https'])).rejects.toThrow();
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(
      assertSafeWebhookUrl('https://user:pass@example.com/hook', ['https']),
    ).rejects.toThrow();
  });
});
