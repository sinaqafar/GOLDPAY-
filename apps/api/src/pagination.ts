/**
 * Cursor pagination — SPEC 77 (`{ data, pagination: { next_cursor, has_more } }`).
 *
 * Offset pagination is wrong for financial lists: rows are inserted constantly,
 * so page 2 of an OFFSET query can repeat or skip records that moved between
 * requests. A keyset cursor over `(created_at, id)` is stable — it describes a
 * position in the ordering rather than a count of rows to discard.
 *
 * `id` breaks ties, because two records can share a timestamp and a cursor that
 * is not unique can loop forever.
 */

import { ValidationError } from '../../../packages/errors/src/index.ts';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface Cursor {
  createdAt: string;
  id: string;
}

export interface PageRequest {
  limit: number;
  cursor: Cursor | null;
}

/** Opaque to the caller: base64url of `<iso>|<uuid>`. */
export function encodeCursor(createdAt: string | Date, id: string): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new ValidationError('INVALID_CURSOR', 'cursor is not a valid pagination token');
  }

  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) {
    throw new ValidationError('INVALID_CURSOR', 'cursor is not a valid pagination token');
  }

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !id) {
    throw new ValidationError('INVALID_CURSOR', 'cursor is not a valid pagination token');
  }
  return { createdAt, id };
}

/** Read `limit` and `cursor` from the query string, clamping the page size. */
export function readPageRequest(query: URLSearchParams): PageRequest {
  const rawLimit = Number.parseInt(query.get('limit') ?? String(DEFAULT_PAGE_SIZE), 10);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const rawCursor = query.get('cursor');
  return { limit, cursor: rawCursor ? decodeCursor(rawCursor) : null };
}

/**
 * Turn `limit + 1` fetched rows into a page.
 *
 * Fetching one extra row is how `has_more` is answered without a second COUNT
 * query — if the extra row exists there is another page, and it is dropped from
 * the response.
 */
export function buildPage<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  serialise: (row: T) => unknown,
): { data: unknown[]; pagination: { next_cursor: string | null; has_more: boolean } } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    data: page.map(serialise),
    pagination: {
      next_cursor:
        hasMore && last ? encodeCursor(last['created_at'] as string, last['id'] as string) : null,
      has_more: hasMore,
    },
  };
}
