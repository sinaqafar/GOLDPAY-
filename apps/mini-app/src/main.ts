/**
 * Telegram Mini App server.
 *
 * Serves the static Mini App and proxies /v1/* to the API. Two reasons it is a
 * separate process from the API:
 *
 *  1. The API sets `x-frame-options: DENY` because it serves machines. Telegram
 *     must embed the Mini App in an iframe, so the two need different headers.
 *  2. The browser cannot reach the API host directly, so the proxy keeps all
 *     front-end calls on relative URLs.
 *
 * It holds no business logic and no database connection: every action goes
 * through the API, which performs the same authentication and authorisation as
 * for any other client.
 */

import { createServer, request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number.parseInt(process.env['MINI_APP_PORT'] ?? '3002', 10);
const API_HOST = process.env['API_HOST'] ?? '127.0.0.1';
const API_PORT = Number.parseInt(process.env['API_PORT'] ?? '3000', 10);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Development-only preview support.
 *
 * Outside Telegram there is no initData, so the Mini App cannot authenticate
 * and a developer sees only an error. When — and ONLY when — the app is running
 * in development AND an explicit Telegram user id has been supplied, the server
 * mints a correctly signed initData so the real UI can be exercised against the
 * real API.
 *
 * Both locks must be open, and both default to closed. In any other
 * environment the endpoint does not exist at all.
 */
const DEV_PREVIEW =
  process.env['APP_ENV'] === 'development' && Boolean(process.env['MINI_APP_DEV_USER']);

function mintDevInitData(): string {
  const token = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAdev',
    user: JSON.stringify({
      id: Number.parseInt(process.env['MINI_APP_DEV_USER'] as string, 10),
      first_name: 'Dev',
      username: 'dev',
    }),
  });
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secretKey).update(checkString).digest('hex'));
  return params.toString();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/__dev/init-data') {
    if (!DEV_PREVIEW) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ initData: mintDevInitData() }));
    return;
  }

  // --- API proxy -----------------------------------------------------------
  if (url.pathname.startsWith('/v1/')) {
    const upstream = httpRequest(
      {
        host: API_HOST,
        port: API_PORT,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          'content-type': upstreamRes.headers['content-type'] ?? 'application/json',
          'cache-control': 'no-store',
        });
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { code: 'API_UNREACHABLE', message: 'API unreachable' } }));
    });
    req.pipe(upstream);
    return;
  }

  // --- static files --------------------------------------------------------
  void (async () => {
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    // Resolve, then confirm the result is still inside PUBLIC_DIR: without this
    // a path like /../../.env would escape the served directory.
    const filePath = join(PUBLIC_DIR, normalize(requested).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      const content = await readFile(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // Telegram embeds the Mini App, so framing must be allowed for it while
        // still being denied to everyone else.
        'content-security-policy':
          "default-src 'self'; script-src 'self' https://telegram.org https://*.telegram.org; " +
          "style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; " +
          'frame-ancestors https://web.telegram.org https://*.telegram.org',
        'cache-control': requested === '/index.html' ? 'no-store' : 'public, max-age=300',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
  })();
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      service: 'mini-app',
      msg: 'mini_app.listening',
      port: PORT,
      apiTarget: `${API_HOST}:${API_PORT}`,
    }) + '\n',
  );
});

const shutdown = (signal: string) => {
  process.stdout.write(
    JSON.stringify({ level: 'info', service: 'mini-app', msg: 'shutdown', signal }) + '\n',
  );
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
