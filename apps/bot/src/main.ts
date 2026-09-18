/**
 * Telegram bot entrypoint.
 *
 * Runs in webhook mode when TELEGRAM_WEBHOOK_SECRET is set (production), and in
 * long-polling mode otherwise (local development).
 *
 * SPEC: the bot is a presentation layer only. It calls the same use cases the
 * API does and contains no financial logic of its own.
 */

import { createServer } from 'node:http';
import { createContainer } from '../../../packages/core/src/container.ts';
import { TelegramClient, NullTelegramClient, type TelegramPort } from '../../../packages/telegram/src/client.ts';
import { handleUpdate, type TelegramUpdate } from './handlers.ts';
import { safeEqual } from '../../../packages/crypto/src/index.ts';

const container = await createContainer({ service: 'bot' });
const { config, logger, db } = container;

const telegram: TelegramPort = config.telegram.botToken
  ? new TelegramClient(config.telegram.botToken)
  : new NullTelegramClient();

if (!config.telegram.botToken) {
  logger.warn('bot.no_token', { message: 'TELEGRAM_BOT_TOKEN is not set; running in no-op mode' });
}

const deps = { db, config, telegram };

async function processUpdate(update: TelegramUpdate): Promise<void> {
  try {
    await handleUpdate(deps, update);
  } catch (e) {
    // A handler failure must never take the bot process down.
    logger.error('bot.handler_failed', {
      updateId: update.update_id,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

if (config.telegram.webhookSecret) {
  // --- webhook mode --------------------------------------------------------
  const port = Number.parseInt(process.env['BOT_PORT'] ?? '3001', 10);

  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    // Telegram echoes the secret token; reject anything else outright.
    const token = req.headers['x-telegram-bot-api-secret-token'];
    if (typeof token !== 'string' || !safeEqual(token, config.telegram.webhookSecret as string)) {
      logger.warn('bot.webhook_rejected', { reason: 'bad secret token' });
      res.writeHead(403).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      // Acknowledge immediately: Telegram retries on a slow response, and a
      // duplicate update would mean duplicate work.
      res.writeHead(200).end();
      try {
        void processUpdate(JSON.parse(Buffer.concat(chunks).toString('utf8')) as TelegramUpdate);
      } catch {
        logger.warn('bot.bad_update_json');
      }
    });
  });

  server.listen(port, '0.0.0.0', () => logger.info('bot.webhook_listening', { port }));
} else if (config.telegram.botToken) {
  // --- long-polling mode ---------------------------------------------------
  let offset = 0;
  let running = true;

  const poll = async (): Promise<void> => {
    while (running) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${config.telegram.botToken}/getUpdates?timeout=25&offset=${offset}`,
        );
        const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
        for (const update of body.result ?? []) {
          offset = Math.max(offset, update.update_id + 1);
          await processUpdate(update);
        }
      } catch (e) {
        logger.warn('bot.poll_failed', { message: e instanceof Error ? e.message : String(e) });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  logger.info('bot.polling_started');
  process.on('SIGTERM', () => {
    running = false;
  });
  await poll();
} else {
  logger.info('bot.idle', { message: 'no token and no webhook secret; nothing to do' });
}
