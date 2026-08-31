/**
 * Keyset (cursor) pagination shared across the six list endpoints BV-029 covers.
 *
 * Cursor, not offset: these lists change while being read (a new bid, a new listing), and an
 * offset silently skips or repeats rows across pages when that happens. The cursor encodes
 * the last row's sort value plus a tiebreak id, since none of these sort fields (endTime,
 * createdAt, submittedAt) are unique on their own -- two rows can share the same instant.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 24;

export function parseLimit(raw: unknown, def = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

export interface DecodedCursor {
  /** ISO-8601 for the DateTime sort fields these endpoints all use. */
  sortValue: string;
  id: string;
}

/** A malformed or tampered cursor is treated as "no cursor" -- first page -- not an error. */
export function decodeCursor(raw: unknown): DecodedCursor | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      decoded && typeof decoded === 'object' &&
      typeof (decoded as DecodedCursor).sortValue === 'string' &&
      typeof (decoded as DecodedCursor).id === 'string'
    ) {
      return decoded as DecodedCursor;
    }
  } catch {
    // Malformed base64 or JSON -- fall through to undefined.
  }
  return undefined;
}

function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify({ sortValue, id })).toString('base64url');
}

/**
 * Slices a page fetched with `take: limit + 1` (the "fetch one extra" trick that answers
 * "is there a next page" without a second COUNT query) into the page itself plus the cursor
 * for the next one.
 */
export function slicePage<T>(
  rows: T[],
  limit: number,
  getSortValue: (row: T) => Date,
  getId: (row: T) => string,
): { pageRows: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(getSortValue(last).toISOString(), getId(last)) : null;
  return { pageRows, nextCursor };
}
