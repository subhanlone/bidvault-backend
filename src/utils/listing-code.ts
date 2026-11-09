import crypto from 'node:crypto';

/**
 * A listing's public item number, `BV-<year>-<10 upper-case hex>`, the shape the item-number
 * search matches (modules/auctions/browse-query.ts). Side-effect-free so the seed scripts can use
 * the same generator as the app (FR-13: seed-demo had its own 6-hex copy the search never matched).
 */
export function generateListingCode(): string {
  const year = new Date().getFullYear();
  // BV-014: widened from randomBytes(3) (16.7M values -- ~50% collision odds by ~4,800
  // listings sharing a year prefix) to randomBytes(5) (1.1 x 10^12 values), which makes a
  // collision effectively impossible on its own. The retry in the listings routes is the actual
  // fix; this is just cheaper insurance against needing it.
  const suffix = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `BV-${year}-${suffix}`;
}
