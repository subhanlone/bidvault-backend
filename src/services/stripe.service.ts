import Stripe from 'stripe';
import { env } from '../config/env.js';

// The API version is pinned rather than left to whatever the installed SDK defaults to.
// `stripe` is declared as ^22.1.1, so a routine `npm install` could otherwise move the
// version this payment path talks to with no code change — and every webhook/response shape
// this file and its callers read is exactly what an API version governs.
// Pinned to the version the installed SDK's own types describe, so the runtime API and the
// compile-time shapes cannot disagree. Changing it is a deliberate act: bump both together.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-07-29.dahlia' });

/**
 * Money, at the Stripe boundary.
 *
 * The domain stores whole rupees everywhere -- Bid.amount, Auction.currentBid,
 * AuctionTransaction.finalAmount are all integer PKR, which is the right choice. Stripe
 * expects the smallest unit of the currency, and PKR is two-decimal, so the two disagree by
 * a factor of 100.
 *
 * That disagreement was the audit's one Critical finding (BV-001): `amount: tx.finalAmount`
 * charged PKR 50 for a PKR 5,000 sale while the books recorded the full 5,000. Named and used
 * on every side of every money-moving call in this codebase -- charges, transfers, refunds --
 * so the same conversion cannot drift out of sync between them.
 */
export const CURRENCY = 'pkr';
const MINOR_UNITS_PER_RUPEE = 100;

export function toMinorUnits(wholeRupees: number): number {
  return wholeRupees * MINOR_UNITS_PER_RUPEE;
}
