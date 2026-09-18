/**
 * Structured JSON logging.
 *
 * SPEC 4329/4330: secrets, API keys, signatures and raw tokens must never be
 * logged. Known-sensitive keys are redacted defensively at the boundary rather
 * than relying on every call site to remember.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'signature',
  'hash',
  'initdata',
  'private',
  'mnemonic',
  'seed',
  'cookie',
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    out[k] = SENSITIVE.some((s) => lower.includes(s)) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(
  options: { level?: LogLevel; service?: string; bindings?: Record<string, unknown> } = {},
): Logger {
  const level = options.level ?? 'info';
  const threshold = LEVELS[level];
  const bindings = options.bindings ?? {};

  function emit(logLevel: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVELS[logLevel] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: logLevel,
      service: options.service ?? 'gateway',
      msg: message,
      ...bindings,
      ...(context ? (redact(context) as Record<string, unknown>) : {}),
    };
    const out = JSON.stringify(line);
    if (logLevel === 'error' || logLevel === 'warn') process.stderr.write(`${out}\n`);
    else process.stdout.write(`${out}\n`);
  }

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (extra) =>
      createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** A logger that records nothing, for tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
