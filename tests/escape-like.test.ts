/**
 * Postgres LIKE/ILIKE gives `%`, `_` and `\` special meaning, and Prisma's `contains` passes the
 * term through unchanged (checked against the query log: `'50%_off\\x'` went out as the
 * parameter `%50%_off\x%`). escapeLike makes a user-typed term mean exactly what was typed.
 */
import { describe, expect, it } from 'vitest';
import { escapeLike } from '../src/utils/escape-like.js';

describe('escapeLike', () => {
  it('prefixes %, _ and \\ with a backslash', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
  });

  it('escapes the backslash first so the escapes it adds are not doubled', () => {
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('leaves a term without special characters unchanged', () => {
    expect(escapeLike('plain Term 42')).toBe('plain Term 42');
  });

  it('returns an empty string unchanged', () => {
    expect(escapeLike('')).toBe('');
  });
});
