/**
 * API entrypoint.
 *
 * Binds on 0.0.0.0 so the process is reachable from outside its container.
 */

import { createContainer } from '../../../packages/core/src/container.ts';
import { createHttpServer } from './http.ts';
import { buildRouter } from './routes.ts';
import { TokenBucketRateLimiter } from '../../../packages/core/src/rate-limit.ts';

const container = await createContainer({ service: 'api' });
const router = buildRouter(container);
const server = createHttpServer({
  router,
  logger: container.logger,
  trustProxy: process.env['TRUST_PROXY'] === 'true',
  // In-process counters: correct for one instance. A multi-instance deployment
  // must move this to Redis, or the effective limit multiplies by the instance
  // count (see packages/core/src/rate-limit.ts).
  rateLimiter: process.env['RATE_LIMIT_DISABLED'] === 'true'
    ? undefined
    : new TokenBucketRateLimiter(),
});

const { port, host } = container.config.app;
server.listen(port, host, () => {
  container.logger.info('api.listening', { port, host, env: container.config.app.env });
});

async function shutdown(signal: string): Promise<void> {
  container.logger.info('api.shutdown', { signal });
  // Stop accepting new connections, then let in-flight requests finish.
  server.close(() => undefined);
  await container.shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
