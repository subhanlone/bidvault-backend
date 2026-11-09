import type { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { prisma } from '../db/prisma.js';
import { isAnonymized, notAnonymized } from './account.service.js';
import { announceCancel, cancelLockedAuction, type CancelActor, type CancelledAuction } from './auction-control.service.js';
import { dispatchEmail, sendSellingPausedEmail, sendSellingRestoredEmail } from './email.service.js';
import { invalidateUserStatusCache } from './user-status.service.js';
import { karachiMonthStart, sellerLimits } from './seller-limit.service.js';

/**
 * B5 PR 3b (docs/B5-SELLER-ACCOUNT-RESEARCH.md sections 3.3 and 3.4, D4 and D7): an admin pauses or
 * restores someone's selling and sets their personal monthly limit; a seller asks for a higher one.
 *
 * Revoking stops selling only: the person keeps their account, can still buy, and the sales they have
 * already made keep working (shipping, disputes, relisting are guarded by ownership, not by isSeller).
 */

export type SellerStatus = 'NONE' | 'ACTIVE' | 'REVOKED';

export function sellerStatusOf(user: { isSeller: boolean; sellerRevokedAt: Date | null }): SellerStatus {
  return user.isSeller ? 'ACTIVE' : user.sellerRevokedAt ? 'REVOKED' : 'NONE';
}

const pkr = (n: number) => `PKR ${n.toLocaleString('en-US')}`;

type LockedUser = { id: string; role: string; email: string; name: string; isSeller: boolean; sellerRevokedAt: Date | null };

async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<LockedUser | undefined> {
  const [row] = await tx.$queryRaw<LockedUser[]>`
    SELECT id, role, email, name, "isSeller", "sellerRevokedAt" FROM "User" WHERE id = ${userId} FOR UPDATE
  `;
  return row;
}

export type RevokeSellerResult =
  | { kind: 'ok'; withdrawnListings: number; cancelledAuctions: number }
  | { kind: 'not-found' }
  | { kind: 'refused'; message: string };

export async function revokeSeller(
  userId: string,
  adminUserId: string,
  reason: string,
  endLiveAuctions: boolean,
  io?: Server,
): Promise<RevokeSellerResult> {
  const actor: CancelActor = { userId: adminUserId, isAdmin: true, reason };

  const outcome = await prisma.$transaction(async (tx) => {
    const user = await lockUser(tx, userId);
    if (!user) return { kind: 'not-found' as const };
    if (isAnonymized(user)) return { kind: 'refused' as const, message: 'This account is deleted.' };
    if (user.role === 'ADMIN') return { kind: 'refused' as const, message: 'An administrator account does not sell.' };
    if (!user.isSeller) {
      return {
        kind: 'refused' as const,
        message: user.sellerRevokedAt ? 'Selling is already paused on this account.' : 'This account does not sell.',
      };
    }

    await tx.user.update({ where: { id: userId }, data: { isSeller: false, sellerRevokedAt: new Date() } });

    // The auctions first, then the listings: the lock order every path takes.
    const cancelled: Array<{ auctionId: string; auction: CancelledAuction }> = [];
    if (endLiveAuctions) {
      const live = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Auction" WHERE "sellerId" = ${userId} AND status = 'ACTIVE' ORDER BY id FOR UPDATE
      `;
      for (const { id } of live) cancelled.push({ auctionId: id, auction: await cancelLockedAuction(tx, id, actor) });
    }

    // Pending listings are withdrawn with the reason, kept as REJECTED so the seller can read why.
    const pending = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Listing" WHERE "sellerId" = ${userId} AND status = 'PENDING' ORDER BY id FOR UPDATE
    `;
    if (pending.length > 0) {
      await tx.listing.updateMany({
        where: { id: { in: pending.map((l) => l.id) } },
        data: { status: 'REJECTED', rejectionReason: `Withdrawn because selling was paused on your account: ${reason}` },
      });
    }

    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'SELLER_REVOKED',
        entityType: 'User',
        entityId: userId,
        metadata: { reason, endLiveAuctions, withdrawnListings: pending.length, cancelledAuctions: cancelled.length },
      },
    });
    await tx.notification.create({
      data: {
        userId,
        type: 'SELLER_REVOKED',
        title: 'Selling on your account has been paused',
        message:
          `An admin paused selling on your account: ${reason} Listings waiting for review were withdrawn. ` +
          (endLiveAuctions ? 'Your live auctions were ended. ' : 'Your live auctions will finish as normal. ') +
          'Sales you have already made continue: ship them and answer any dispute as usual.',
      },
    });
    return { kind: 'ok' as const, user, withdrawn: pending.length, cancelled };
  });

  if (outcome.kind !== 'ok') return outcome;

  invalidateUserStatusCache(userId);
  dispatchEmail(sendSellingPausedEmail(outcome.user, reason, endLiveAuctions), `selling-paused (${userId})`);
  for (const c of outcome.cancelled) await announceCancel(c.auctionId, c.auction, actor, io);
  return { kind: 'ok', withdrawnListings: outcome.withdrawn, cancelledAuctions: outcome.cancelled.length };
}

export type RestoreSellerResult = { kind: 'ok' } | { kind: 'not-found' } | { kind: 'refused'; message: string };

export async function restoreSeller(userId: string, adminUserId: string): Promise<RestoreSellerResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const user = await lockUser(tx, userId);
    if (!user) return { kind: 'not-found' as const };
    if (isAnonymized(user)) return { kind: 'refused' as const, message: 'This account is deleted.' };
    if (user.isSeller) return { kind: 'refused' as const, message: 'This account can already sell.' };
    if (!user.sellerRevokedAt) {
      return { kind: 'refused' as const, message: 'This account never became a seller; there is nothing to restore.' };
    }

    await tx.user.update({ where: { id: userId }, data: { isSeller: true, sellerRevokedAt: null } });
    await tx.auditLog.create({
      data: { actorUserId: adminUserId, action: 'SELLER_RESTORED', entityType: 'User', entityId: userId },
    });
    await tx.notification.create({
      data: {
        userId,
        type: 'SELLER_RESTORED',
        title: 'You can sell again',
        message: 'An admin restored selling on your account. You can list items again.',
      },
    });
    return { kind: 'ok' as const, user };
  });

  if (outcome.kind !== 'ok') return outcome;
  invalidateUserStatusCache(userId);
  dispatchEmail(sendSellingRestoredEmail(outcome.user), `selling-restored (${userId})`);
  return { kind: 'ok' };
}

export type SetSellerLimitResult =
  | { kind: 'ok'; items: number | null; value: number | null }
  | { kind: 'not-found' }
  | { kind: 'refused'; message: string };

/** An admin's per-person monthly limit; null for either half means the platform number applies. */
export async function setSellerLimit(
  userId: string,
  adminUserId: string,
  items: number | null,
  value: number | null,
): Promise<SetSellerLimitResult> {
  return prisma.$transaction(async (tx) => {
    const user = await lockUser(tx, userId);
    if (!user) return { kind: 'not-found' as const };
    if (isAnonymized(user)) return { kind: 'refused' as const, message: 'This account is deleted.' };
    if (user.role === 'ADMIN') return { kind: 'refused' as const, message: 'An administrator account does not sell.' };

    await tx.user.update({ where: { id: userId }, data: { sellerLimitOverrideItems: items, sellerLimitOverrideValue: value } });
    await tx.auditLog.create({
      data: { actorUserId: adminUserId, action: 'SELLER_LIMIT_SET', entityType: 'User', entityId: userId, metadata: { items, value } },
    });

    const parts: string[] = [];
    if (items !== null) parts.push(`${items} items`);
    if (value !== null) parts.push(`${pkr(value)} in starting prices`);
    await tx.notification.create({
      data: {
        userId,
        type: 'SELLER_LIMIT_CHANGED',
        title: 'Your monthly selling limit has changed',
        message:
          parts.length === 0
            ? 'An admin removed your personal monthly limit. The usual limit for your account applies again.'
            : `An admin set your monthly limit to ${parts.join(' and ')} a month.` +
              (parts.length === 1 ? ' The other figure is the usual one for your account.' : ''),
      },
    });
    return { kind: 'ok' as const, items, value };
  });
}

export type LimitRequestResult =
  | { kind: 'ok'; requestedAt: Date; alreadyRequested: boolean }
  | { kind: 'no-limit' };

/**
 * D7, "Request a higher limit": records the request (an audit row) and tells every active admin. One
 * a month: a repeat gives back the one already made. The admin answers with PUT seller-limit.
 */
export async function requestHigherLimit(userId: string, note: string | undefined): Promise<LimitRequestResult> {
  return prisma.$transaction(async (tx) => {
    const user = await lockUser(tx, userId);
    if (!user) return { kind: 'no-limit' as const };
    const now = new Date();
    const limits = await sellerLimits(tx, userId, now);
    if (limits.items.limit === null && limits.value.limit === null) return { kind: 'no-limit' as const };

    const earlier = await tx.auditLog.findFirst({
      where: { action: 'SELLER_LIMIT_REQUESTED', entityId: userId, createdAt: { gte: karachiMonthStart(now) } },
      orderBy: { createdAt: 'asc' },
    });
    if (earlier) return { kind: 'ok' as const, requestedAt: earlier.createdAt, alreadyRequested: true };

    const audit = await tx.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'SELLER_LIMIT_REQUESTED',
        entityType: 'User',
        entityId: userId,
        metadata: { note: note ?? null, items: limits.items, value: limits.value, standing: limits.standing },
      },
    });

    const usage = [
      limits.items.limit !== null ? `${limits.items.used} of ${limits.items.limit} items` : null,
      limits.value.limit !== null ? `${pkr(limits.value.used)} of ${pkr(limits.value.limit)}` : null,
    ].filter(Boolean).join(', ');
    const admins = await tx.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE', ...notAnonymized },
      select: { id: true },
    });
    await tx.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type: 'SELLER_LIMIT_REQUESTED',
        title: 'A seller asks for a higher limit',
        message: `${user.name} has used ${usage} this month and asks for more.${note ? ` Their note: "${note}"` : ''}`,
      })),
    });
    return { kind: 'ok' as const, requestedAt: audit.createdAt, alreadyRequested: false };
  });
}
