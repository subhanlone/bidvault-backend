import { z } from 'zod';

/**
 * Email validation, in exactly two flavours.
 *
 * There used to be two *disagreeing* rules: `POST /register` enforced the domain-shape
 * regex below, every other auth route enforced zod's `.email()`. Neither is a superset of
 * the other, so addresses existed that you could register with and then never log in with
 * — the account was created, verified, and permanently unusable, and login's only
 * explanation was "Invalid email address" for an address it had accepted minutes earlier.
 * (NEW-10 in TEST-FINDINGS.md.)
 *
 * The split that replaces it is by *purpose*, not by route:
 *
 *   strictEmail — for input that creates or updates a stored address. This is where a
 *                 data-quality gate belongs, so it is the strictest rule we have: an
 *                 address must satisfy zod's parser AND the domain-shape regex.
 *
 *   lookupEmail — for input that only identifies an existing account. Format checking here
 *                 cannot protect anything: the address is about to be looked up, and a
 *                 miss already returns "invalid credentials". All a strict rule can do at
 *                 this end is lock out a real user, so this accepts anything shaped like
 *                 an address and lets the database decide.
 *
 * The invariant that keeps the bug from coming back: **everything strictEmail accepts,
 * lookupEmail must also accept.** Anything you can sign up with, you can sign in with.
 */

// Requires a TLD-shaped domain and rejects consecutive, leading or trailing dots and
// hyphens in domain labels — all things zod's parser permits.
const DOMAIN_SHAPE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Shaped like an address and nothing more: a local part, an @, a domain, no whitespace.
// Deliberately looser than anything that could have produced a stored address.
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+$/;

const INVALID = 'Enter a valid email address';

// .trim() before .pipe() is load-bearing. String checks run in the order they are added,
// so z.email().trim() would format-check the untrimmed value and reject a pasted address
// with a stray space.
export const strictEmail = z
  .string()
  .trim()
  .max(254, INVALID) // RFC 5321 maximum for an address
  .pipe(z.email(INVALID))
  .refine((value) => DOMAIN_SHAPE.test(value), INVALID);

export const lookupEmail = z
  .string()
  .trim()
  .max(320, INVALID) // generous: must not reject anything already stored
  .regex(ADDRESS_SHAPE, INVALID);
