import crypto from 'node:crypto';
import type { Prisma, TransactionStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { hashPassword } from '../utils/password.js';

/**
 * Anonymise-in-place, not DELETE (BV-018).
 *
 * The account row is never removed -- Bid.buyerId (SetNull) and the RESTRICT on
 * AuctionTransaction.winnerId/sellerId both depend on it still existing, and every revenue
 * aggregate, dispute, and audit trail that references this user by id keeps working
 * unchanged. What changes is that name/email no longer identify a real person and the
 * password can never be used again.
 *
 * Matches how real auction platforms handle this (eBay: transaction, financial and dispute
 * records are retained after account closure "to comply with financial and legal retention
 * obligations") and the erasure-exception pattern in both GDPR Art. 17(3) and Pakistan's
 * draft Personal Data Protection Bill 2023 (s.26) -- an erasure obligation does not require
 * destroying records a legal obligation requires keeping; anonymising the identity while
 * retaining the transaction is the standard reconciliation of the two.
 */

const DELETED_NAME = 'Deleted User';

/** Every anonymized account's address ends with this, and no other account's can: register
 * refuses the reserved `.invalid` TLD (config/email.ts). So it is how a deleted account is
 * recognised. */
const ANONYMIZED_EMAIL_SUFFIX = '@bidvault.invalid';

export function isAnonymized(user: { email: string }): boolean {
  return user.email.endsWith(ANONYMIZED_EMAIL_SUFFIX);
}

/** Prisma filter for accounts that have not been anonymized. */
export const notAnonymized: Prisma.UserWhereInput = { NOT: { email: { endsWith: ANONYMIZED_EMAIL_SUFFIX } } };

export interface DeleteGuardResult {
  allowed: boolean;
  reason?: string;
}

/** A sale still waiting for the buyer to pay. */
const AWAITING_PAYMENT: TransactionStatus[] = ['PENDING', 'FAILED'];
/** A sale paid for but not finished: not yet shipped, not yet received, or disputed. */
const IN_FULFILMENT: TransactionStatus[] = ['COMPLETED', 'SHIPPED', 'DISPUTED'];

/**
 * Mirrors eBay's own precondition for closing an account: no active listings, no
 * bids/purchases/sales still in progress, nothing unpaid. In this schema that means, on either
 * side of a sale:
 *   - no ACTIVE auction, and no listing still waiting for review (it could otherwise be approved
 *     and sold with nobody behind it);
 *   - no bid on an auction that is still running (the bidder could win it);
 *   - no sale that is not finished: waiting for payment, paid but not shipped, shipped but not
 *     received, or disputed. The other party is still owed something on every one of these.
 * Finished history (DELIVERED, REFUNDED, VOIDED, a closed auction, a past bid) blocks nothing.
 */
export async function checkAccountDeletable(userId: string): Promise<DeleteGuardResult> {
  const eitherSide = { OR: [{ winnerId: userId }, { sellerId: userId }] };
  const [activeAuctions, listingsInReview, liveBids, awaitingPayment, inFulfilment] = await Promise.all([
    prisma.auction.count({ where: { sellerId: userId, status: 'ACTIVE' } }),
    prisma.listing.count({ where: { sellerId: userId, status: 'PENDING' } }),
    prisma.bid.count({ where: { buyerId: userId, auction: { status: 'ACTIVE' } } }),
    prisma.auctionTransaction.count({ where: { status: { in: AWAITING_PAYMENT }, ...eitherSide } }),
    prisma.auctionTransaction.count({ where: { status: { in: IN_FULFILMENT }, ...eitherSide } }),
  ]);

  if (activeAuctions > 0) {
    return { allowed: false, reason: 'You have an active auction. It must end before your account can be deleted.' };
  }
  if (listingsInReview > 0) {
    return { allowed: false, reason: 'You have a listing waiting for review. Withdraw it before your account can be deleted.' };
  }
  if (liveBids > 0) {
    return { allowed: false, reason: 'You have a bid on an auction that is still running. It must end before your account can be deleted.' };
  }
  if (awaitingPayment > 0) {
    return { allowed: false, reason: 'You have a purchase or sale awaiting payment. It must be completed or voided by an admin before your account can be deleted.' };
  }
  if (inFulfilment > 0) {
    return { allowed: false, reason: 'You have a purchase or sale that is paid but not finished (not yet shipped, not yet received, or disputed). It must be finished before your account can be deleted.' };
  }
  return { allowed: true };
}

/**
 * The anonymisation itself. Callers must run `checkAccountDeletable` first -- this function
 * does not re-check, so it can also be used for a case an admin has decided to override
 * (there is no such override route today, but the separation keeps the guard reusable rather
 * than duplicated into a "force" flag).
 */
/**
 * Pass `tx` to anonymize inside a caller's transaction (delete-account does, to hold its lock on
 * the administrator rows until the account is gone); without it the two writes get their own.
 */
export async function anonymizeUser(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
  // Unusable but well-formed: keeps `passwordHash` a valid bcrypt string (nothing downstream
  // has to special-case an empty one) while guaranteeing no password will ever match it.
  const unusablePassword = await hashPassword(crypto.randomUUID());

  const write = async (db: Prisma.TransactionClient) => {
    await db.user.update({
      where: { id: userId },
      data: {
        name: DELETED_NAME,
        // Unique and unregistrable -- .invalid is the reserved TLD for exactly this (RFC 2606).
        // Changing it away from the address the person knows is also what makes login
        // impossible afterward: the lookup by email in POST /auth/login will simply find no
        // row, the same clean 401 an unrecognised address always gets.
        email: `deleted-${userId}${ANONYMIZED_EMAIL_SUFFIX}`,
        passwordHash: unusablePassword,
        notifyOutbid: false,
        notifyWins: false,
        notifyNews: false,
        // B5: everything a person gave to become a seller goes, and so does the capability. The
        // seller's past auctions and sales stay (they are records the platform must keep), but
        // they now belong to a "Deleted user" with no city, phone or bio attached.
        isSeller: false,
        sellerSince: null,
        sellerTermsAcceptedAt: null,
        sellerTermsVersion: null,
        ageConfirmedAt: null,
        sellerCity: null,
        sellerProvince: null,
        sellerPhone: null,
        sellerBio: null,
        sellerRevokedAt: null,
        sellerLimitOverrideItems: null,
        sellerLimitOverrideValue: null,
      },
    });
    await db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  };

  if (tx) await write(tx);
  else await prisma.$transaction(write);
}
