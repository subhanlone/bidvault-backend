/**
 * Makes a user-typed search term mean exactly what was typed when it is used with Prisma's
 * `contains` / `mode: 'insensitive'`.
 *
 * Prisma passes the term to Postgres as the LIKE/ILIKE pattern `%term%` without escaping it, and
 * in a pattern `%` matches any run of characters, `_` matches any single character and `\` is the
 * default escape character. Left alone, a search for `50%` also finds `50x`, and one for `a\b`
 * finds `ab`. Backslash is escaped first so the backslashes added for `%` and `_` are not doubled.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}
