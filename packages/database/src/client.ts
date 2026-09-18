/**
 * packages/database/client — one transaction manager for the whole system.
 *
 * SPEC 117.46: `transaction.run(async (tx) => { ... })` is the only financial
 * write boundary.
 * SPEC 4347 / 56.36: no HTTP call may happen inside a financial DB transaction —
 * side effects go through the outbox and run after COMMIT.
 *
 * Two drivers are supported behind one interface:
 *   `pglite:<dir>`   embedded PostgreSQL (local dev, tests, CI)
 *   `postgres://...` a real server via `pg` (staging, production)
 */

import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors/src/index.ts';

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

/** A handle that runs statements inside one transaction. */
export interface TransactionContext {
  readonly id: string;
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface Database {
  /** Run a statement outside any transaction (reads, migrations, maintenance). */
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  /** Run `fn` inside a single transaction; commits on return, rolls back on throw. */
  transaction<T>(fn: (tx: TransactionContext) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'pglite' | 'pg';
}

export interface TransactionOptions {
  /** SERIALIZABLE is used for the money-moving paths that must not interleave. */
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  /** Retries on 40001/40P01 (serialization failure / deadlock). */
  retries?: number;
}

export class DatabaseError extends AppError {
  constructor(message: string, cause?: unknown, details?: Record<string, unknown>) {
    super('DATABASE_ERROR', 'INTERNAL', message, { cause, details });
  }
}

/** Postgres error codes we treat as safely retryable. */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

function pgCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

export function isRetryableDbError(e: unknown): boolean {
  const code = pgCode(e);
  return code !== undefined && RETRYABLE_PG_CODES.has(code);
}

/**
 * Translate a database constraint violation into a domain error so callers can
 * branch on intent rather than on driver internals.
 */
export function translateDbError(e: unknown): unknown {
  const code = pgCode(e);
  const message = e instanceof Error ? e.message : String(e);

  if (message.includes('LEDGER_UNBALANCED')) {
    return new AppError('LEDGER_UNBALANCED', 'FINANCIAL', 'journal debits and credits differ', {
      cause: e,
    });
  }
  if (message.includes('IMMUTABLE_FINANCIAL_RECORD')) {
    return new AppError('IMMUTABLE_FINANCIAL_RECORD', 'FINANCIAL', 'financial history cannot be modified', {
      cause: e,
    });
  }
  if (code === '23505') {
    return new AppError('UNIQUE_VIOLATION', 'CONFLICT', 'a conflicting record already exists', {
      cause: e,
      details: { constraint: (e as { constraint?: string }).constraint },
    });
  }
  if (code === '23514') {
    const constraint = (e as { constraint?: string }).constraint;
    // A negative balance bucket is a hard financial invariant breach.
    const isBalance = typeof constraint === 'string' && constraint.includes('balances');
    return new AppError(
      isBalance ? 'NEGATIVE_BALANCE' : 'CHECK_VIOLATION',
      'FINANCIAL',
      isBalance ? 'balance bucket would go negative' : `check constraint failed: ${constraint ?? 'unknown'}`,
      { cause: e, details: { constraint } },
    );
  }
  if (code === '23503') {
    return new AppError('FOREIGN_KEY_VIOLATION', 'VALIDATION', 'referenced record does not exist', {
      cause: e,
    });
  }
  return e;
}

interface RawDriver {
  exec(sql: string): Promise<void>;
  query<R>(sql: string, params: readonly unknown[]): Promise<QueryResult<R>>;
  close(): Promise<void>;
  /** Reserve an exclusive connection for a transaction, if the driver pools. */
  reserve?(): Promise<{
    query<R>(sql: string, params: readonly unknown[]): Promise<QueryResult<R>>;
    release(): void;
  }>;
}

async function createPgliteDriver(dataDir: string): Promise<RawDriver> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir === 'memory' || dataDir === '' ? new PGlite() : new PGlite(dataDir);
  await db.waitReady;
  return {
    async exec(sql) {
      await db.exec(sql);
    },
    async query<R>(sql: string, params: readonly unknown[]) {
      const r = await db.query<R>(sql, params as unknown[]);
      // PGlite reports INSERT/UPDATE/DELETE counts in `affectedRows`; `rows` is
      // only populated by SELECT or RETURNING. Guarded-transition logic depends
      // on an accurate count, so prefer affectedRows whenever it is present.
      const affected = (r as { affectedRows?: number }).affectedRows;
      return {
        rows: r.rows,
        rowCount: r.rows.length > 0 ? r.rows.length : (affected ?? 0),
      };
    },
    async close() {
      await db.close();
    },
  };
}

async function createPgDriver(url: string, poolMax: number, ssl: boolean): Promise<RawDriver> {
  const pgModule = await import('pg');
  const Pool = pgModule.default?.Pool ?? (pgModule as unknown as { Pool: new (c: unknown) => unknown }).Pool;
  const pool = new (Pool as new (c: unknown) => {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    connect(): Promise<{
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
      release(): void;
    }>;
    end(): Promise<void>;
  })({
    connectionString: url,
    max: poolMax,
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
  });

  return {
    async exec(sql) {
      await pool.query(sql);
    },
    async query<R>(sql: string, params: readonly unknown[]) {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows as R[], rowCount: r.rowCount ?? (r.rows as R[]).length };
    },
    async reserve() {
      const client = await pool.connect();
      return {
        async query<R>(sql: string, params: readonly unknown[]) {
          const r = await client.query(sql, params as unknown[]);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? (r.rows as R[]).length };
        },
        release: () => client.release(),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

class DatabaseImpl implements Database {
  readonly driver: 'pglite' | 'pg';
  #raw: RawDriver;
  /** PGlite is single-connection, so transactions must be serialised in-process. */
  #lock: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(raw: RawDriver, driver: 'pglite' | 'pg') {
    this.#raw = raw;
    this.driver = driver;
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.#assertOpen();
    try {
      return await this.#raw.query<R>(sql, params);
    } catch (e) {
      throw translateDbError(e);
    }
  }

  /** Multi-statement DDL (migrations only). */
  async exec(sql: string): Promise<void> {
    this.#assertOpen();
    try {
      await this.#raw.exec(sql);
    } catch (e) {
      throw translateDbError(e);
    }
  }

  async transaction<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    this.#assertOpen();
    const retries = options.retries ?? 3;
    const isolation = options.isolation ?? 'READ COMMITTED';

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#runOnce(fn, isolation);
      } catch (e) {
        if (attempt < retries && isRetryableDbError(e)) {
          // Exponential backoff with jitter before retrying a serialization failure.
          const delay = Math.min(50 * 2 ** attempt, 500) + Math.floor(Math.random() * 25);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw translateDbError(e);
      }
    }
  }

  async #runOnce<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    isolation: NonNullable<TransactionOptions['isolation']>,
  ): Promise<T> {
    // Serialise transactions on drivers that expose a single connection.
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((r) => {
      release = r;
    });
    await previous.catch(() => undefined);

    const reserved = this.#raw.reserve ? await this.#raw.reserve() : null;
    const run = reserved
      ? <R>(sql: string, p: readonly unknown[]) => reserved.query<R>(sql, p)
      : <R>(sql: string, p: readonly unknown[]) => this.#raw.query<R>(sql, p);

    const id = randomUUID();
    let began = false;
    try {
      await run('BEGIN', []);
      began = true;
      await run(`SET TRANSACTION ISOLATION LEVEL ${isolation}`, []);

      const ctx: TransactionContext = {
        id,
        query: async <R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
          try {
            return await run<R>(sql, params);
          } catch (e) {
            throw translateDbError(e);
          }
        },
      };

      const result = await fn(ctx);
      await run('COMMIT', []);
      return result;
    } catch (e) {
      if (began) {
        // Rollback must never mask the original failure.
        await run('ROLLBACK', []).catch(() => undefined);
      }
      throw e;
    } finally {
      reserved?.release();
      release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#lock.catch(() => undefined);
    await this.#raw.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new DatabaseError('database connection is closed');
  }
}

export type ConcreteDatabase = DatabaseImpl;

export async function createDatabase(options: {
  url: string;
  poolMax?: number;
  ssl?: boolean;
}): Promise<DatabaseImpl> {
  const { url } = options;
  if (url.startsWith('pglite:')) {
    const dir = url.slice('pglite:'.length);
    return new DatabaseImpl(await createPgliteDriver(dir), 'pglite');
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return new DatabaseImpl(
      await createPgDriver(url, options.poolMax ?? 10, options.ssl ?? false),
      'pg',
    );
  }
  throw new DatabaseError(`unsupported DATABASE_URL scheme: ${url.split(':')[0]}`);
}
