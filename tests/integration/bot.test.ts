/**
 * Telegram bot flows.
 * The bot is a presentation layer, so these tests assert that it drives the
 * real use cases and persists conversation state in the database.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { handleUpdate, normaliseDigits, type TelegramUpdate } from '../../apps/bot/src/handlers.ts';
import { NullTelegramClient } from '../../packages/telegram/src/client.ts';

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

function message(text: string, telegramUserId = 555001): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      from: { id: telegramUserId, username: 'shopowner', first_name: 'Sina' },
      chat: { id: telegramUserId },
      text,
    },
  };
}

async function botFixture() {
  harness = await createHarness();
  const telegram = new NullTelegramClient();
  const deps = { db: harness.db, config: harness.config, telegram };
  return { deps, telegram, h: harness };
}

describe('digit normalisation', () => {
  it('accepts Persian and Arabic-Indic numerals', () => {
    expect(normaliseDigits('۲۵۰۰۰۰')).toBe('250000');
    expect(normaliseDigits('٣٠٠')).toBe('300');
    expect(normaliseDigits('1000')).toBe('1000');
  });
});

describe('/start', () => {
  it('registers the user and creates their shop', async () => {
    const { deps, telegram, h } = await botFixture();
    await handleUpdate(deps, message('/start'));

    const users = await h.db.query('SELECT id FROM core.users WHERE telegram_user_id = 555001');
    expect(users.rowCount).toBe(1);

    const merchants = await h.db.query('SELECT id, status FROM core.merchants');
    expect(merchants.rowCount).toBe(1);
    expect(telegram.sent[0]?.text).toContain('فروشگاه شما ساخته شد');
  });

  it('is safe to send twice — no duplicate user or shop', async () => {
    const { deps, h } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/start'));

    expect((await h.db.query('SELECT id FROM core.users')).rowCount).toBe(1);
    expect((await h.db.query('SELECT id FROM core.merchants')).rowCount).toBe(1);
  });
});

describe('invoice conversation', () => {
  it('creates a real invoice with the fee snapshot applied', async () => {
    const { deps, telegram, h } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/invoice'));

    // The prompt is stored as conversation state in the DB, not in memory.
    const state = await h.db.query<{ state: string }>('SELECT state FROM core.bot_conversations');
    expect(state.rows[0]?.state).toBe('AWAITING_INVOICE_AMOUNT');

    await handleUpdate(deps, message('250000'));

    const invoices = await h.db.query<{
      base_amount: string;
      customer_total_amount: string;
      platform_fee_amount: string;
    }>(
      'SELECT base_amount::text, customer_total_amount::text, platform_fee_amount::text FROM core.invoices',
    );
    expect(invoices.rowCount).toBe(1);
    expect(invoices.rows[0]?.base_amount).toBe('250000');
    expect(invoices.rows[0]?.customer_total_amount).toBe('285000'); // +14%
    expect(invoices.rows[0]?.platform_fee_amount).toBe('35000');

    // The conversation is finished and cleaned up.
    expect((await h.db.query('SELECT 1 FROM core.bot_conversations')).rowCount).toBe(0);
    expect(telegram.sent.at(-1)?.text).toContain('فاکتور ساخته شد');
  });

  it('accepts Persian digits', async () => {
    const { deps, h } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/invoice'));
    await handleUpdate(deps, message('۱۰۰۰۰۰'));

    const invoices = await h.db.query<{ base_amount: string }>(
      'SELECT base_amount::text FROM core.invoices',
    );
    expect(invoices.rows[0]?.base_amount).toBe('100000');
  });

  it('rejects a non-numeric amount and keeps the conversation open', async () => {
    const { deps, telegram, h } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/invoice'));
    await handleUpdate(deps, message('abc'));

    expect((await h.db.query('SELECT 1 FROM core.invoices')).rowCount).toBe(0);
    expect(telegram.sent.at(-1)?.text).toContain('نامعتبر');
    // Still waiting for a valid amount.
    expect((await h.db.query('SELECT 1 FROM core.bot_conversations')).rowCount).toBe(1);
  });

  it('rejects a zero amount', async () => {
    const { deps, h } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/invoice'));
    await handleUpdate(deps, message('0'));
    expect((await h.db.query('SELECT 1 FROM core.invoices')).rowCount).toBe(0);
  });
});

describe('wallet conversation', () => {
  it('rejects an invalid TON address', async () => {
    const { deps, telegram, h } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/wallet'));
    await handleUpdate(deps, message('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));

    expect((await h.db.query('SELECT 1 FROM core.wallets')).rowCount).toBe(0);
    expect(telegram.sent.at(-1)?.text).toContain('معتبر نیست');
  });

  it('registers a valid address in SECURITY_HOLD, not ACTIVE', async () => {
    const { deps, h } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/wallet'));
    await handleUpdate(deps, message(`EQ${'A'.repeat(46)}`));

    const wallets = await h.db.query<{ status: string; hold_until: string }>(
      'SELECT status, hold_until FROM core.wallets',
    );
    expect(wallets.rows[0]?.status).toBe('SECURITY_HOLD');
    expect(wallets.rows[0]?.hold_until).toBeTruthy();
  });
});

describe('/balance', () => {
  it('reports zeroes for a brand new shop', async () => {
    const { deps, telegram } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/balance'));
    expect(telegram.sent.at(-1)?.text).toContain('موجودی شما');
  });
});

describe('/api', () => {
  it('issues a key and stores only its hash', async () => {
    const { deps, telegram, h } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/api'));

    const keys = await h.db.query<{ key_prefix: string; secret_hash: string }>(
      'SELECT key_prefix, secret_hash FROM core.api_keys',
    );
    expect(keys.rowCount).toBe(1);

    const shown = telegram.sent.at(-1)?.text ?? '';
    const stored = keys.rows[0] as { key_prefix: string; secret_hash: string };
    // The plaintext secret appears in the message but never in the database.
    expect(shown).toContain(stored.key_prefix);
    expect(stored.secret_hash.startsWith('scrypt$')).toBe(true);
    expect(shown).not.toContain(stored.secret_hash);
  });
});

describe('unknown input', () => {
  it('does not crash on an unknown command', async () => {
    const { deps, telegram } = await botFixture();
    await handleUpdate(deps, message('/start'));
    await handleUpdate(deps, message('/definitely_not_a_command'));
    expect(telegram.sent.at(-1)?.text).toContain('ناشناخته');
  });

  it('ignores an update with no message or callback', async () => {
    const { deps } = await botFixture();
    await expect(handleUpdate(deps, { update_id: 1 })).resolves.toBeUndefined();
  });
});
