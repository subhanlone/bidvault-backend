import type { User } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { SELLER_TERMS_VERSION } from '../config/seller.js';
import { invalidateUserStatusCache } from './user-status.service.js';

export { SELLER_TERMS_VERSION };

export interface EnrollSellerInput {
  termsVersion: string;
  city: string;
  province: string;
  phone?: string;
  bio?: string;
}

export type EnrollSellerResult =
  | { kind: 'ok'; user: User }
  | { kind: 'not-found' }
  | { kind: 'terms-changed' };

/**
 * B5: turns an account into a seller. Instant -- there is no approval step; the safeguards are the
 * terms they accept, the details they give and (in the next PR) a monthly listing limit for new
 * sellers.
 *
 * Idempotent: an account that is already a seller gets its current record back, untouched. That is
 * what makes a double-click, a retry after a dropped response, or a stale second tab harmless --
 * it never overwrites the details or the acceptance time of the first enrolment, and never writes
 * a second audit row. The row lock is what makes that true for two requests in flight at once.
 */
export async function enrollSeller(userId: string, input: EnrollSellerInput): Promise<EnrollSellerResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; isSeller: boolean }>>`
      SELECT id, "isSeller" FROM "User" WHERE id = ${userId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (row.isSeller) {
      return { kind: 'ok' as const, user: await tx.user.findUniqueOrThrow({ where: { id: userId } }) };
    }
    if (input.termsVersion !== SELLER_TERMS_VERSION) return { kind: 'terms-changed' as const };

    const now = new Date();
    const user = await tx.user.update({
      where: { id: userId },
      data: {
        isSeller: true,
        sellerSince: now,
        sellerTermsAcceptedAt: now,
        sellerTermsVersion: input.termsVersion,
        ageConfirmedAt: now,
        sellerCity: input.city,
        sellerProvince: input.province,
        sellerPhone: input.phone ?? null,
        sellerBio: input.bio ?? null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'SELLER_ENROLLED',
        entityType: 'User',
        entityId: userId,
        // Which terms, not the personal details: the audit trail says it happened, the user row
        // says what was given.
        metadata: { termsVersion: input.termsVersion, province: input.province },
      },
    });
    return { kind: 'ok' as const, user };
  });

  if (outcome.kind === 'ok') invalidateUserStatusCache(userId);
  return outcome;
}
