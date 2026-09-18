/**
 * Minimal Telegram Bot API client.
 *
 * SPEC (v0.6 reference): notification failures must NEVER roll back finance.
 * `notifySafely` therefore swallows every error by design.
 */

import { IntegrationError } from '../../errors/src/index.ts';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
}

export interface SendMessageOptions {
  chatId: number | string;
  text: string;
  parseMode?: 'HTML' | 'MarkdownV2';
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
  disableWebPagePreview?: boolean;
}

export interface TelegramPort {
  sendMessage(options: SendMessageOptions): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<void>;
}

export class TelegramClient implements TelegramPort {
  #token: string;
  #timeoutMs: number;

  constructor(token: string, timeoutMs = 10_000) {
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  async sendMessage(options: SendMessageOptions): Promise<void> {
    await this.#call('sendMessage', {
      chat_id: options.chatId,
      text: options.text,
      parse_mode: options.parseMode ?? 'HTML',
      reply_markup: options.replyMarkup,
      disable_web_page_preview: options.disableWebPagePreview ?? true,
    });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.#call('answerCallbackQuery', { callback_query_id: id, text });
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.#call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  async #call(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
      if (!body.ok) {
        throw new IntegrationError('TELEGRAM_API_ERROR', body.description ?? 'Telegram rejected the call', {
          retryable: res.status >= 500 || res.status === 429,
        });
      }
      return body as Record<string, unknown>;
    } catch (e) {
      if (e instanceof IntegrationError) throw e;
      throw new IntegrationError('TELEGRAM_UNREACHABLE', 'Telegram API request failed', {
        retryable: true,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Send a notification that must never affect business outcomes.
 * A failed Telegram message is logged and forgotten — it cannot roll back a
 * committed payment or payout.
 */
export async function notifySafely(
  telegram: TelegramPort,
  options: SendMessageOptions,
  onError?: (e: unknown) => void,
): Promise<void> {
  try {
    await telegram.sendMessage(options);
  } catch (e) {
    onError?.(e);
  }
}

/** A no-op client for tests and for running without a bot token. */
export class NullTelegramClient implements TelegramPort {
  readonly sent: SendMessageOptions[] = [];
  async sendMessage(options: SendMessageOptions): Promise<void> {
    this.sent.push(options);
  }
  async answerCallbackQuery(): Promise<void> {}
  async setWebhook(): Promise<void> {}
}

/** Escape user-supplied text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
