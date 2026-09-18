/**
 * Merchant notifications over Telegram — SPEC 5564-5570.
 *
 * Two rules govern everything here.
 *
 * 1. **A notification failure must never undo money.** Telegram being down,
 *    rate-limiting us, or the merchant having blocked the bot are all normal
 *    conditions. Every send is therefore swallowed: the caller is told nothing
 *    went wrong, because from a financial point of view nothing did
 *    (SPEC 5565/5566).
 *
 * 2. **The bot never computes financial state.** Message text is rendered from
 *    the event payload that the domain already committed, so a merchant can
 *    never be shown a number the ledger does not agree with (SPEC 5569/5570).
 */

import type { Database } from '../../database/src/client.ts';
import type { Logger } from './logger.ts';
import type { EventEnvelope, OutboxEventType } from './outbox.ts';

export interface TelegramSender {
  sendMessage(params: { chatId: number; text: string }): Promise<unknown>;
}

/** Only these events are worth interrupting a merchant for. */
const NOTIFIABLE: ReadonlySet<OutboxEventType> = new Set<OutboxEventType>([
  'payment.verified',
  'payment.released',
  'payout.queued',
  'payout.waiting_liquidity',
  'payout.broadcasted',
  'payout.confirmed',
  'payout.failed',
]);

export function isNotifiable(type: OutboxEventType): boolean {
  return NOTIFIABLE.has(type);
}

/** Group digits so large Toman figures are readable at a glance. */
function formatAmount(value: unknown): string {
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  if (raw === null || !/^-?\d+$/.test(raw)) return '—';
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** nanogram -> GRAM, trimmed. Integer arithmetic only. */
function formatGram(atomic: unknown): string {
  const raw = typeof atomic === 'string' ? atomic : null;
  if (raw === null || !/^\d+$/.test(raw)) return '—';
  const value = BigInt(raw);
  const whole = value / 1_000_000_000n;
  const frac = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Render the Persian message for an event, or null when it needs no message.
 * Pure: it reads the payload and nothing else.
 */
export function renderNotification(envelope: EventEnvelope): string | null {
  const p = envelope.payload as Record<string, unknown>;

  switch (envelope.type) {
    case 'payment.verified':
      return (
        `✅ <b>پرداخت تأیید شد</b>\n\n` +
        `مبلغ خالص شما: <b>${formatAmount(p['merchant_net'])}</b> تومان\n` +
        `این مبلغ پس از ۴۸ ساعت قابل تسویه می‌شود.`
      );

    case 'payment.released':
      return (
        `🔓 <b>موجودی آزاد شد</b>\n\n` +
        `مبلغ <b>${formatAmount(p['amount'])}</b> تومان اکنون قابل تسویه است.\n` +
        `تسویه به‌صورت خودکار در صف قرار می‌گیرد.`
      );

    case 'payout.queued':
      return (
        `⏳ <b>تسویه در صف قرار گرفت</b>\n\n` +
        `مبلغ: <b>${formatAmount(p['amount_toman'])}</b> تومان`
      );

    case 'payout.waiting_liquidity':
      return (
        `⌛️ <b>در انتظار نقدینگی</b>\n\n` +
        `تسویه شما ثبت شده و در نوبت است.\n` +
        `مبلغ شما محفوظ است و به‌محض تأمین GRAM ارسال می‌شود.`
      );

    case 'payout.broadcasted':
      return (
        `📤 <b>تراکنش ارسال شد</b>\n\n` +
        `مقدار: <b>${formatGram(p['gram_amount'])}</b> GRAM\n` +
        `در انتظار تأیید شبکه TON…`
      );

    case 'payout.confirmed':
      return (
        `🎉 <b>تسویه انجام شد</b>\n\n` +
        `مقدار: <b>${formatGram(p['gram_amount'])}</b> GRAM\n` +
        (typeof p['tx_hash'] === 'string' ? `کد تراکنش:\n<code>${p['tx_hash']}</code>` : '')
      );

    case 'payout.failed':
      return (
        `⚠️ <b>تسویه ناموفق بود</b>\n\n` +
        `موجودی شما به حالت «قابل تسویه» بازگشت و کم نشده است.\n` +
        `تیم پشتیبانی موضوع را بررسی می‌کند.`
      );

    default:
      return null;
  }
}

/**
 * Deliver the notification for one event.
 *
 * Returns whether a message was actually sent — useful for tests and metrics,
 * never for deciding anything financial.
 */
export async function notifyMerchant(
  db: Database,
  telegram: TelegramSender,
  logger: Logger,
  envelope: EventEnvelope,
): Promise<boolean> {
  try {
    if (!isNotifiable(envelope.type)) return false;

    const merchantId = (envelope.payload as Record<string, unknown>)['merchant_id'];
    if (typeof merchantId !== 'string') return false;

    const text = renderNotification(envelope);
    if (!text) return false;

    // The owner's Telegram id, via the merchant's user.
    const r = await db.query<{ telegram_user_id: string }>(
      `SELECT u.telegram_user_id::text
         FROM core.merchants m
         JOIN core.users u ON u.id = m.user_id
        WHERE m.id = $1`,
      [merchantId],
    );
    const chatId = r.rows[0]?.telegram_user_id;
    if (!chatId) return false;

    await telegram.sendMessage({ chatId: Number(chatId), text });
    return true;
  } catch (e) {
    // Swallowed deliberately. See rule 1 at the top of this file: a merchant
    // who does not receive a message is a support issue, but a payment rolled
    // back because Telegram was unreachable would be a financial bug.
    logger.warn('notification.failed', {
      eventId: envelope.id,
      type: envelope.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}
