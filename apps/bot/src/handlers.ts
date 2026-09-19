/**
 * Telegram bot command handlers — SPEC 03 (bot commands).
 *
 * Commands: start, menu, dashboard, invoice, payments, balance, payouts,
 * settlement, wallet, integrations, api, docs, settings, help.
 *
 * SPEC: conversation state lives in the database, never in process memory, so
 * a restart or a second instance cannot lose or corrupt it.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../../../packages/database/src/client.ts';
import type { Config } from '../../../packages/config/src/index.ts';
import {
  escapeHtml,
  type TelegramPort,
  type InlineKeyboardButton,
} from '../../../packages/telegram/src/client.ts';
import { Money } from '../../../packages/money/src/index.ts';
import { generateApiKey } from '../../../packages/crypto/src/index.ts';
import { isValidTonAddress } from '../../../packages/ton/src/adapter.ts';
import { createInvoice } from '../../../packages/core/src/use-cases/create-invoice.ts';

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { chat: { id: number } };
    data?: string;
  };
}

export interface BotDeps {
  db: Database;
  config: Config;
  telegram: TelegramPort;
}

/** Format an integer Toman amount with thousands separators. */
function toman(atomic: string | bigint): string {
  return `${BigInt(atomic).toLocaleString('en-US')} تومان`;
}

function gram(atomic: string | bigint): string {
  return `${Money.gram(atomic).format()} GRAM`;
}

export async function handleUpdate(deps: BotDeps, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(deps, update.callback_query);
  if (update.message?.text) return handleMessage(deps, update.message);
}

async function handleMessage(
  deps: BotDeps,
  message: NonNullable<TelegramUpdate['message']>,
): Promise<void> {
  const from = message.from;
  if (!from) return;

  const chatId = message.chat.id;
  const text = (message.text ?? '').trim();
  const user = await upsertUser(deps.db, from);

  // An active conversation (e.g. "send me the amount") takes precedence.
  const pending = await getConversation(deps.db, user.id);
  if (pending && !text.startsWith('/')) {
    await continueConversation(deps, { chatId, userId: user.id, state: pending, text });
    return;
  }

  const [rawCommand = ''] = text.split(/\s+/);
  const command = rawCommand.replace(/@.*$/, '').toLowerCase();

  switch (command) {
    case '/start':
      await onStart(deps, chatId, user.id, from.first_name ?? 'دوست عزیز');
      break;
    case '/menu':
    case '/dashboard':
    // SPEC 1464 lists /panel alongside /dashboard as an entry to the same view.
    case '/panel':
      await onMenu(deps, chatId, user.id);
      break;
    case '/invoice':
      await onInvoiceStart(deps, chatId, user.id);
      break;
    case '/balance':
      await onBalance(deps, chatId, user.id);
      break;
    case '/payments':
      await onPayments(deps, chatId, user.id);
      break;
    case '/payouts':
    case '/settlement':
      await onPayouts(deps, chatId, user.id);
      break;
    case '/wallet':
      await onWalletStart(deps, chatId, user.id);
      break;
    case '/api':
    case '/integrations':
    // SPEC 1464 / 117.17 — connecting external bots is done with the same
    // API credentials, so /bots lands on the same handler.
    case '/bots':
      await onApiKey(deps, chatId, user.id);
      break;
    case '/docs':
      await onDocs(deps, chatId);
      break;
    case '/settings':
      await onSettings(deps, chatId, user.id);
      break;
    case '/help':
      await onHelp(deps, chatId);
      break;
    default:
      await deps.telegram.sendMessage({
        chatId,
        text: 'دستور ناشناخته است. برای دیدن راهنما /help را بفرستید.',
      });
  }
}

async function handleCallback(
  deps: BotDeps,
  query: NonNullable<TelegramUpdate['callback_query']>,
): Promise<void> {
  const chatId = query.message?.chat.id;
  if (!chatId) return;
  const user = await upsertUser(deps.db, query.from);
  await deps.telegram.answerCallbackQuery(query.id);

  switch (query.data) {
    case 'balance':
      await onBalance(deps, chatId, user.id);
      break;
    case 'invoice':
      await onInvoiceStart(deps, chatId, user.id);
      break;
    case 'payouts':
      await onPayouts(deps, chatId, user.id);
      break;
    case 'wallet':
      await onWalletStart(deps, chatId, user.id);
      break;
    case 'menu':
      await onMenu(deps, chatId, user.id);
      break;
  }
}

// --- commands --------------------------------------------------------------

async function onStart(deps: BotDeps, chatId: number, userId: string, name: string): Promise<void> {
  const merchant = await getMerchant(deps.db, userId);

  if (!merchant) {
    const merchantId = randomUUID();
    await deps.db.query(
      `INSERT INTO core.merchants (id, user_id, name, status, default_fee_mode, auto_payout)
       VALUES ($1,$2,$3,'ACTIVE',$4,TRUE)`,
      [merchantId, userId, `${name}'s Shop`, deps.config.fees.defaultFeeMode],
    );
    await deps.telegram.sendMessage({
      chatId,
      text:
        `سلام ${escapeHtml(name)}! 👋\n\n` +
        `فروشگاه شما ساخته شد.\n\n` +
        `<b>چطور کار می‌کند؟</b>\n` +
        `۱. فاکتور تومانی می‌سازید\n` +
        `۲. مشتری پرداخت می‌کند\n` +
        `۳. بعد از ${deps.config.settlement.holdHours} ساعت، موجودی شما قابل برداشت می‌شود\n` +
        `۴. تسویه به‌صورت خودکار با GRAM روی شبکه TON انجام می‌شود\n\n` +
        `کارمزد پلتفرم: <b>${deps.config.fees.platformFeePercent.toPercentString()}</b>\n\n` +
        `اول کیف پول خود را ثبت کنید: /wallet`,
      replyMarkup: mainMenu(deps.config),
    });
    return;
  }

  await onMenu(deps, chatId, userId);
}

async function onMenu(deps: BotDeps, chatId: number, userId: string): Promise<void> {
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  await deps.telegram.sendMessage({
    chatId,
    text: `<b>${escapeHtml(merchant.name)}</b>\nوضعیت: ${merchant.status}\n\nیک گزینه را انتخاب کنید:`,
    replyMarkup: mainMenu(deps.config),
  });
}

async function onBalance(deps: BotDeps, chatId: number, userId: string): Promise<void> {
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  const r = await deps.db.query<{ available: string; pending: string; settling: string }>(
    `SELECT b.available::text, b.pending::text, b.settling::text
       FROM finance.balances b
       JOIN finance.ledger_accounts a ON a.id = b.account_id
      WHERE a.owner_type = 'MERCHANT' AND a.owner_id = $1`,
    [merchant.id],
  );
  const balance = r.rows[0] ?? { available: '0', pending: '0', settling: '0' };

  await deps.telegram.sendMessage({
    chatId,
    text:
      `<b>موجودی شما</b>\n\n` +
      `✅ قابل برداشت: <b>${toman(balance.available)}</b>\n` +
      `⏳ در انتظار (${deps.config.settlement.holdHours} ساعت): ${toman(balance.pending)}\n` +
      `🚀 در حال تسویه: ${toman(balance.settling)}\n\n` +
      `<i>تسویه به‌صورت خودکار انجام می‌شود و نیازی به درخواست نیست.</i>`,
  });
}

async function onPayments(deps: BotDeps, chatId: number, userId: string): Promise<void> {
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  const r = await deps.db.query<{
    status: string;
    verified_amount: string | null;
    release_at: string | null;
    created_at: string;
  }>(
    `SELECT status, verified_amount::text, release_at, created_at
       FROM core.payments WHERE merchant_id = $1
      ORDER BY created_at DESC LIMIT 10`,
    [merchant.id],
  );

  if (r.rows.length === 0) {
    await deps.telegram.sendMessage({ chatId, text: 'هنوز پرداختی ثبت نشده است.' });
    return;
  }

  const lines = r.rows.map((p) => {
    const icon = p.status === 'RELEASED' ? '✅' : p.status === 'VERIFIED' ? '⏳' : '⚠️';
    const amount = p.verified_amount ? toman(p.verified_amount) : '—';
    return `${icon} ${amount} · ${p.status}`;
  });

  await deps.telegram.sendMessage({
    chatId,
    text: `<b>آخرین پرداخت‌ها</b>\n\n${lines.join('\n')}`,
  });
}

async function onPayouts(deps: BotDeps, chatId: number, userId: string): Promise<void> {
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  const r = await deps.db.query<{
    status: string;
    amount_toman: string;
    gram_amount_atomic: string | null;
    transaction_hash: string | null;
  }>(
    `SELECT status, amount_toman::text, gram_amount_atomic::text, transaction_hash
       FROM finance.payouts WHERE merchant_id = $1
      ORDER BY created_at DESC LIMIT 10`,
    [merchant.id],
  );

  if (r.rows.length === 0) {
    await deps.telegram.sendMessage({
      chatId,
      text: 'هنوز تسویه‌ای انجام نشده است.\n\n<i>پس از قابل برداشت شدن موجودی، تسویه خودکار آغاز می‌شود.</i>',
    });
    return;
  }

  const lines = r.rows.map((p) => {
    const icon =
      p.status === 'SETTLED' ? '✅' : p.status === 'WAITING_LIQUIDITY' ? '⏸' : p.status === 'FAILED' ? '❌' : '🚀';
    const g = p.gram_amount_atomic ? ` → ${gram(p.gram_amount_atomic)}` : '';
    return `${icon} ${toman(p.amount_toman)}${g}\n   ${p.status}${p.transaction_hash ? `\n   <code>${escapeHtml(p.transaction_hash.slice(0, 24))}…</code>` : ''}`;
  });

  await deps.telegram.sendMessage({ chatId, text: `<b>تسویه‌ها</b>\n\n${lines.join('\n\n')}` });
}

async function onInvoiceStart(deps: BotDeps, chatId: number, userId: string): Promise<void> {
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  await setConversation(deps.db, userId, 'AWAITING_INVOICE_AMOUNT', {});
  await deps.telegram.sendMessage({
    chatId,
    text: 'مبلغ فاکتور را به تومان بفرستید (فقط عدد صحیح، مثلاً 250000):',
  });
}

async function onWalletStart(deps: BotDeps, chatId: number, userId: string): Promise<void> {
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  const existing = await deps.db.query<{ address: string; status: string }>(
    `SELECT address, status FROM core.wallets WHERE merchant_id = $1 AND status <> 'REVOKED'
      ORDER BY created_at DESC LIMIT 1`,
    [merchant.id],
  );
  const current = existing.rows[0];

  await setConversation(deps.db, userId, 'AWAITING_WALLET_ADDRESS', {});
  await deps.telegram.sendMessage({
    chatId,
    text:
      (current
        ? `کیف پول فعلی:\n<code>${escapeHtml(current.address)}</code> (${current.status})\n\n`
        : '') +
      'آدرس کیف پول TON خود را برای دریافت GRAM بفرستید:\n\n' +
      '<i>⚠️ آدرس را با دقت بررسی کنید. ارسال به آدرس اشتباه قابل بازگشت نیست.</i>',
  });
}

async function onApiKey(deps: BotDeps, chatId: number, userId: string): Promise<void> {
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  const key = generateApiKey();
  await deps.db.query(
    `INSERT INTO core.api_keys (id, merchant_id, name, key_prefix, secret_hash, status)
     VALUES ($1,$2,'telegram',$3,$4,'ACTIVE')`,
    [randomUUID(), merchant.id, key.prefix, key.secretHash],
  );

  await deps.telegram.sendMessage({
    chatId,
    text:
      `<b>کلید API جدید</b>\n\n<code>${escapeHtml(key.token)}</code>\n\n` +
      `⚠️ این کلید فقط همین یک بار نمایش داده می‌شود. آن را در جای امنی ذخیره کنید.`,
  });
}

async function onDocs(deps: BotDeps, chatId: number): Promise<void> {
  await deps.telegram.sendMessage({
    chatId,
    text:
      `<b>مستندات API</b>\n\n` +
      `آدرس پایه: <code>${escapeHtml(deps.config.app.appUrl)}</code>\n\n` +
      `هر درخواست باید این هدرها را داشته باشد:\n` +
      `• <code>Authorization: Bearer &lt;key&gt;</code>\n` +
      `• <code>X-Gateway-Timestamp</code>\n` +
      `• <code>X-Gateway-Nonce</code>\n` +
      `• <code>X-Gateway-Signature</code>\n\n` +
      `امضا = HMAC-SHA256 روی:\n<code>METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nSHA256(BODY)</code>`,
  });
}

async function onSettings(deps: BotDeps, chatId: number, userId: string): Promise<void> {
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  await deps.telegram.sendMessage({
    chatId,
    text:
      `<b>تنظیمات</b>\n\n` +
      `نام: ${escapeHtml(merchant.name)}\n` +
      `حالت کارمزد: ${merchant.default_fee_mode}\n` +
      `تسویه خودکار: ${merchant.auto_payout ? 'فعال' : 'غیرفعال'}\n` +
      `دوره انتظار: ${deps.config.settlement.holdHours} ساعت\n` +
      `کارمزد پلتفرم: ${deps.config.fees.platformFeePercent.toPercentString()}`,
  });
}

async function onHelp(deps: BotDeps, chatId: number): Promise<void> {
  await deps.telegram.sendMessage({
    chatId,
    text:
      `<b>راهنما</b>\n\n` +
      `/menu — منوی اصلی\n` +
      `/dashboard — داشبورد\n` +
      `/invoice — ساخت فاکتور\n` +
      `/balance — موجودی\n` +
      `/payments — پرداخت‌ها\n` +
      `/payouts — تسویه‌ها\n` +
      `/settlement — وضعیت تسویه\n` +
      `/wallet — کیف پول TON\n` +
      `/api — کلید API\n` +
      `/integrations — اتصال‌ها\n` +
      `/bots — اتصال ربات‌های دیگر\n` +
      `/docs — مستندات\n` +
      `/settings — تنظیمات\n` +
      `/help — همین راهنما`,
  });
}

// --- conversations ---------------------------------------------------------

async function continueConversation(
  deps: BotDeps,
  params: { chatId: number; userId: string; state: { state: string }; text: string },
): Promise<void> {
  const { chatId, userId, text } = params;
  const merchant = await requireMerchant(deps, chatId, userId);
  if (!merchant) return;

  switch (params.state.state) {
    case 'AWAITING_INVOICE_AMOUNT': {
      // Accept Persian and Arabic-Indic digits as well as ASCII.
      const normalised = normaliseDigits(text).replace(/[,\s]/g, '');
      if (!/^\d+$/.test(normalised) || BigInt(normalised) <= 0n) {
        await deps.telegram.sendMessage({
          chatId,
          text: 'مبلغ نامعتبر است. لطفاً فقط یک عدد صحیح مثبت بفرستید.',
        });
        return;
      }

      await clearConversation(deps.db, userId);
      const invoice = await createInvoice(deps.db, deps.config, {
        merchantId: merchant.id,
        baseAmount: normalised,
      });

      await deps.telegram.sendMessage({
        chatId,
        text:
          `<b>فاکتور ساخته شد</b>\n\n` +
          `شماره: <code>${escapeHtml(invoice.invoiceNumber)}</code>\n` +
          `مبلغ پایه: ${toman(invoice.baseAmount)}\n` +
          `پرداختی مشتری: <b>${toman(invoice.customerTotal)}</b>\n` +
          `سهم شما: ${toman(invoice.merchantNet)}\n` +
          `کارمزد: ${toman(invoice.platformFee)} (${invoice.feeMode})`,
      });
      return;
    }

    case 'AWAITING_WALLET_ADDRESS': {
      const address = text.trim();
      if (!isValidTonAddress(address)) {
        await deps.telegram.sendMessage({
          chatId,
          text: '❌ این آدرس TON معتبر نیست. دوباره تلاش کنید یا /menu را بفرستید.',
        });
        return;
      }

      await clearConversation(deps.db, userId);
      const holdUntil = new Date(Date.now() + 24 * 3600 * 1000);

      // Registering a new wallet retires the previous one, so only one payout
      // destination is ever active.
      await deps.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE core.wallets SET status = 'DISABLED', updated_at = NOW()
            WHERE merchant_id = $1 AND status = 'ACTIVE'`,
          [merchant.id],
        );
        await tx.query(
          `INSERT INTO core.wallets (id, merchant_id, network, asset, address, status, hold_until)
           VALUES ($1,$2,$3,'GRAM',$4,'SECURITY_HOLD',$5)
           ON CONFLICT (network, asset, address) DO NOTHING`,
          [randomUUID(), merchant.id, deps.config.treasury.network, address, holdUntil.toISOString()],
        );
      });

      await deps.telegram.sendMessage({
        chatId,
        text:
          `✅ کیف پول ثبت شد:\n<code>${escapeHtml(address)}</code>\n\n` +
          `⏳ به دلایل امنیتی، این آدرس تا ۲۴ ساعت آینده فعال می‌شود.`,
      });
      return;
    }

    default:
      await clearConversation(deps.db, userId);
  }
}

// --- persistence helpers ---------------------------------------------------

async function upsertUser(
  db: Database,
  from: { id: number; username?: string; first_name?: string; last_name?: string },
): Promise<{ id: string }> {
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM core.users WHERE telegram_user_id = $1',
    [from.id],
  );
  const found = existing.rows[0];
  if (found) return found;

  const id = randomUUID();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO core.users (id, telegram_user_id, username, first_name, last_name, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE')
     ON CONFLICT (telegram_user_id) DO NOTHING
     RETURNING id`,
    [id, from.id, from.username ?? null, from.first_name ?? null, from.last_name ?? null],
  );
  const row = inserted.rows[0];
  if (row) return row;

  const retry = await db.query<{ id: string }>(
    'SELECT id FROM core.users WHERE telegram_user_id = $1',
    [from.id],
  );
  return retry.rows[0] as { id: string };
}

interface MerchantRow {
  id: string;
  name: string;
  status: string;
  default_fee_mode: string;
  auto_payout: boolean;
}

async function getMerchant(db: Database, userId: string): Promise<MerchantRow | null> {
  const r = await db.query<MerchantRow>(
    `SELECT id, name, status, default_fee_mode, auto_payout
       FROM core.merchants WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

async function requireMerchant(
  deps: BotDeps,
  chatId: number,
  userId: string,
): Promise<MerchantRow | null> {
  const merchant = await getMerchant(deps.db, userId);
  if (!merchant) {
    await deps.telegram.sendMessage({ chatId, text: 'ابتدا /start را بفرستید.' });
    return null;
  }
  if (merchant.status !== 'ACTIVE') {
    await deps.telegram.sendMessage({
      chatId,
      text: `حساب شما در وضعیت ${merchant.status} است و امکان انجام عملیات وجود ندارد.`,
    });
    return null;
  }
  return merchant;
}

async function getConversation(
  db: Database,
  userId: string,
): Promise<{ state: string; data: Record<string, unknown> } | null> {
  const r = await db.query<{ state: string; data: unknown }>(
    `SELECT state, data FROM core.bot_conversations
      WHERE user_id = $1 AND expires_at > NOW()`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    state: row.state,
    data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>,
  };
}

async function setConversation(
  db: Database,
  userId: string,
  state: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO core.bot_conversations (user_id, state, data, expires_at)
     VALUES ($1,$2,$3::jsonb, NOW() + INTERVAL '15 minutes')
     ON CONFLICT (user_id) DO UPDATE
       SET state = EXCLUDED.state, data = EXCLUDED.data,
           expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
    [userId, state, JSON.stringify(data)],
  );
}

async function clearConversation(db: Database, userId: string): Promise<void> {
  await db.query('DELETE FROM core.bot_conversations WHERE user_id = $1', [userId]);
}

function mainMenu(config: Config): { inline_keyboard: InlineKeyboardButton[][] } {
  const rows: InlineKeyboardButton[][] = [
    [
      { text: '💰 موجودی', callback_data: 'balance' },
      { text: '🧾 فاکتور جدید', callback_data: 'invoice' },
    ],
    [
      { text: '🚀 تسویه‌ها', callback_data: 'payouts' },
      { text: '👛 کیف پول', callback_data: 'wallet' },
    ],
  ];
  if (config.telegram.miniAppUrl) {
    rows.push([{ text: '📱 داشبورد', web_app: { url: config.telegram.miniAppUrl } }]);
  }
  return { inline_keyboard: rows };
}

/** Convert Persian/Arabic-Indic digits to ASCII. */
export function normaliseDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (d) => {
    const code = d.charCodeAt(0);
    if (code >= 0x06f0) return String(code - 0x06f0);
    return String(code - 0x0660);
  });
}
