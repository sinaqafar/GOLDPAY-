/**
 * Migration runner.
 * SPEC 103771: migrations are small and versioned.
 * SPEC 117.91: each version records a checksum so an edited applied migration is
 * detected instead of silently diverging between environments.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConcreteDatabase } from './client.ts';
import { AppError } from '../../errors/src/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the .sql files live.
 *
 * Resolved relative to this module, which sits at a different depth once the
 * project is compiled into dist/ — so the same relative walk finds nothing
 * there. MIGRATIONS_DIR overrides it; otherwise both layouts are tried, with
 * the compiled one first since that is the production path.
 */
export const DEFAULT_MIGRATIONS_DIR =
  process.env['MIGRATIONS_DIR'] ?? join(HERE, '..', '..', '..', 'db', 'migrations');

/** Candidate locations, in the order they should be attempted. */
function candidateDirs(dir: string): string[] {
  return [
    dir,
    // Compiled: dist/packages/database/src -> repository root/db/migrations
    join(HERE, '..', '..', '..', '..', 'db', 'migrations'),
  ];
}

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  let resolved: string | null = null;
  for (const candidate of candidateDirs(dir)) {
    try {
      await readdir(candidate);
      resolved = candidate;
      break;
    } catch {
      // try the next layout
    }
  }
  if (!resolved) {
    throw new AppError(
      'MIGRATIONS_NOT_FOUND',
      'CONFIG',
      `no migrations directory found (looked in: ${candidateDirs(dir).join(', ')})`,
    );
  }

  const files = (await readdir(resolved)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const sql = await readFile(join(resolved, file), 'utf8');
    migrations.push({
      version: file.replace(/\.sql$/, ''),
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

async function ensureMigrationTable(db: ConcreteDatabase): Promise<void> {
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS system;
    CREATE TABLE IF NOT EXISTS system.schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  db: ConcreteDatabase,
  dir = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrateResult> {
  await ensureMigrationTable(db);
  const migrations = await loadMigrations(dir);

  const existing = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM system.schema_migrations',
  );
  const appliedMap = new Map(existing.rows.map((r) => [r.version, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const m of migrations) {
    const previous = appliedMap.get(m.version);
    if (previous !== undefined) {
      if (previous !== m.checksum) {
        throw new AppError(
          'MIGRATION_CHECKSUM_MISMATCH',
          'CONFIG',
          `migration ${m.version} was modified after being applied`,
          { details: { version: m.version } },
        );
      }
      skipped.push(m.version);
      continue;
    }

    // DDL runs as a multi-statement script; PostgreSQL DDL is transactional, so
    // a failure inside one migration leaves the schema untouched.
    await db.exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
    await db.query(
      'INSERT INTO system.schema_migrations(version, checksum) VALUES ($1, $2)',
      [m.version, m.checksum],
    );
    applied.push(m.version);
  }

  return { applied, skipped };
}
