import crypto from 'node:crypto';
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

export interface DeleteGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Mirrors eBay's own precondition for closing an account: no active listings, no
 * bids/purchases/sales still in progress, nothing unpaid. In this schema that is exactly
 * "no ACTIVE auction as seller" and "no PENDING transaction on either side" -- a completed
 * sale or a past bid on a since-closed auction does not block anything, only unresolved
 * obligations do.
 */
export async function checkAccountDeletable(userId: string): Promise<DeleteGuardResult> {
  const [activeAuctions, pendingTransactions] = await Promise.all([
    prisma.auction.count({ where: { sellerId: userId, status: 'ACTIVE' } }),
    prisma.auctionTransaction.count({
      where: { status: 'PENDING', OR: [{ winnerId: userId }, { sellerId: userId }] },
    }),
  ]);

  if (activeAuctions > 0) {
    return { allowed: false, reason: 'You have an active auction. It must end before your account can be deleted.' };
  }
  if (pendingTransactions > 0) {
    return { allowed: false, reason: 'You have a purchase or sale awaiting payment. It must be completed or voided by an admin before your account can be deleted.' };
  }
  return { allowed: true };
}

/**
 * The anonymisation itself. Callers must run `checkAccountDeletable` first -- this function
 * does not re-check, so it can also be used for a case an admin has decided to override
 * (there is no such override route today, but the separation keeps the guard reusable rather
 * than duplicated into a "force" flag).
 */
export async function anonymizeUser(userId: string): Promise<void> {
  // Unusable but well-formed: keeps `passwordHash` a valid bcrypt string (nothing downstream
  // has to special-case an empty one) while guaranteeing no password will ever match it.
  const unusablePassword = await hashPassword(crypto.randomUUID());

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        name: DELETED_NAME,
        // Unique and unregistrable -- .invalid is the reserved TLD for exactly this (RFC 2606).
        // Changing it away from the address the person knows is also what makes login
        // impossible afterward: the lookup by email in POST /auth/login will simply find no
        // row, the same clean 401 an unrecognised address always gets.
        email: `deleted-${userId}@bidvault.invalid`,
        passwordHash: unusablePassword,
        notifyOutbid: false,
        notifyWins: false,
        notifyNews: false,
      },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
