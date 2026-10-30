/**
 * What a person agrees to, and tells us, when they become a seller (B5).
 *
 * Side-effect-free (no imports), like config/email.ts, so the request schemas -- which the OpenAPI
 * generator imports -- can use it without dragging in Prisma or the environment.
 */

/**
 * The version of the seller terms shown on the "Become a seller" form. The form sends back the
 * version it displayed, and the server refuses a different one (409), so nobody can be recorded as
 * having accepted wording they were never shown. Bump it whenever the terms text changes; accounts
 * keep the version they accepted.
 */
export const SELLER_TERMS_VERSION = '2026-10';

/** Pakistan's provinces and territories, as the location form offers them. */
export const SELLER_PROVINCES = [
  'Punjab',
  'Sindh',
  'Khyber Pakhtunkhwa',
  'Balochistan',
  'Islamabad Capital Territory',
  'Gilgit-Baltistan',
  'Azad Jammu and Kashmir',
] as const;

export type SellerProvince = (typeof SELLER_PROVINCES)[number];

export const SELLER_BIO_MAX = 280;
