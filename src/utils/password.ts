import { compare, hash } from '@node-rs/bcrypt';

/**
 * bcrypt work factor.
 *
 * Raised from 10. Each step doubles the work, so this is deliberately expensive: measured on
 * this machine a cost-12 comparison takes ~250ms, against ~63ms at cost 10. That cost is the
 * entire point on an offline-cracking timeline, and it is also a real serving cost, so both
 * halves are written down here rather than guessed at later.
 *
 * The native binding is NOT the reason this is affordable, and an earlier version of this
 * comment claimed it was — asserting bcryptjs cost roughly a second per hash while the native
 * implementation finished "in a few milliseconds". Measured back to back, cost 12 is ~250ms
 * native and ~296ms in pure JS: about 1.2x, not the orders of magnitude implied. @node-rs/bcrypt
 * is still worth keeping (it is faster, and it releases the thread to libuv rather than blocking
 * the event loop, which bcryptjs's sync path does not), but the honest margin is small enough
 * that it would not on its own justify a native dependency.
 *
 * The serving cost is what to watch. bcrypt runs on the libuv threadpool, four threads by
 * default, so this process tops out near 16 logins/second no matter how many cores it has, and
 * a burst of logins competes with every other threadpool user. The IP and per-address login
 * limiters in middleware/rate-limit.ts are what keep that from being reachable on purpose;
 * raising the cost again without raising UV_THREADPOOL_SIZE would lower that ceiling further.
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
