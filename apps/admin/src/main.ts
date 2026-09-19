/**
 * Admin panel server.
 *
 * Serves the built bundle and proxies `/internal/admin/*` to the API. It is a
 * separate process from the API for the same reason the Mini App is: the API
 * sends `x-frame-options: DENY` and no-store on everything, which is right for
 * a machine-facing API and wrong for serving an application shell.
 *
 * It holds no business logic, no database connection and no credentials. Every
 * action a panel user takes is an ordinary authenticated call to the admin API,
 * which enforces RBAC, four-eyes approval and audit exactly as it would for
 * curl (SPEC 121.71 — the UI is not the source of truth).
 */

import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number.parseInt(process.env['ADMIN_PORT'] ?? '3003', 10);
const API_HOST = process.env['API_HOST'] ?? '127.0.0.1';
const API_PORT = Number.parseInt(process.env['API_PORT'] ?? '3000', 10);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // --- admin API proxy -------------------------------------------------------
  if (url.pathname.startsWith('/internal/admin/')) {
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
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'API_UNREACHABLE', message: 'API unreachable' } }));
    });
    req.pipe(upstream);
    return;
  }

  // --- static files ----------------------------------------------------------
  void (async () => {
    // Single-page app: unknown paths fall back to the shell so a refresh on any
    // screen still works.
    const requested =
      url.pathname === '/' || !extname(url.pathname) ? '/index.html' : url.pathname;

    // Resolve, then confirm the result is still inside PUBLIC_DIR, or a path
    // like /../../.env would escape the served directory.
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
        // The admin panel must never be framed by anyone (SPEC 7281).
        'content-security-policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
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
      service: 'admin',
      msg: 'admin.listening',
      port: PORT,
      apiTarget: `${API_HOST}:${API_PORT}`,
    }) + '\n',
  );
});

const shutdown = (signal: string) => {
  process.stdout.write(
    JSON.stringify({ level: 'info', service: 'admin', msg: 'shutdown', signal }) + '\n',
  );
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
