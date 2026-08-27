import { compare, hash } from '@node-rs/bcrypt';

/**
 * bcrypt work factor.
 *
 * Raised from 10, and the reason the implementation moved off pure-JS bcryptjs at the same
 * time: each step costs twice as much, and bcryptjs at cost 12 spends roughly a second of
 * single-threaded CPU per hash. On a login route that is a denial-of-service primitive rather
 * than a hardening measure — the native implementation does the same work in a few
 * milliseconds.
 */
export const PASSWORD_COST = 12;

/**
 * A real hash of a value nobody holds, compared against when no account matches the address.
 *
 * Without it, login answers a missing address before doing any bcrypt work at all, and the
 * timing difference alone confirms whether an account exists. Comparing against this instead
 * makes both paths do the same work. It must stay at PASSWORD_COST for that to hold — bcrypt
 * reads the cost out of the hash, so a stale one would leak the same fact by being fast.
 */
export const DUMMY_PASSWORD_HASH =
  '$2b$12$prfA8YLZXprToqex.GXjGOwAPYxgd1And79WMOfSJe3SDQP8RtSxG';

export async function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_COST);
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return compare(password, storedHash);
}

/**
 * Whether a stored hash was produced with a weaker cost than the current one.
 *
 * Reads the cost out of the modular-crypt prefix (`$2<variant>$<cost>$…`) rather than matching
 * the prefix as a string: `$2a$` and `$2b$` differ only in a length-overflow fix and are the
 * same work at the same cost, so treating a cost-12 `$2a$` hash as stale would rewrite it for
 * no benefit. An unparseable hash is left alone — it is not this function's job to decide what
 * an unrecognised format means.
 */
export function needsRehash(storedHash: string): boolean {
  const cost = /^\$2[abxy]\$(\d{2})\$/.exec(storedHash)?.[1];
  return cost !== undefined && Number(cost) < PASSWORD_COST;
}
