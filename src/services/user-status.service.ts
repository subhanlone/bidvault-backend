import { prisma } from '../db/prisma.js';
import { dispatchEmail, sendAccountSuspendedEmail, sendAccountReinstatedEmail } from './email.service.js';

/**
 * C2, Phase 7: requireAuth checks this on every authenticated request, so an uncached read would
 * add a DB round trip to every request in the app. Per-user, short TTL, no cross-process
 * invalidation (unlike settings.service.ts's pub/sub) -- a few seconds of staleness after a
 * suspend/reinstate is an acceptable trade for this project's scale, matching the reference
 * model's own observation that real platforms govern by computed thresholds, not by a real-time
 * hard gate. Unbounded Map, not a real LRU: this project's user count is in the dozens, not
 * millions, so eviction was not worth the complexity it would add.
 */
const TTL_MS = 10_000;
const cache = new Map<string, { suspended: boolean; at: number }>();

export async function isSuspended(userId: string): Promise<boolean> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.suspended;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  const suspended = user?.status === 'SUSPENDED';
  cache.set(userId, { suspended, at: Date.now() });
  return suspended;
}

/** Called by suspend/reinstate so the acting admin's own next request (and everyone else's,
 * within the TTL) doesn't read a stale value for the rest of the window. */
export function invalidateUserStatusCache(userId: string): void {
  cache.delete(userId);
}

export type SuspendUserResult = { kind: 'ok' } | { kind: 'not-found' } | { kind: 'self' } | { kind: 'already-suspended' };

/**
 * Deliberately does not touch this seller's live auctions -- LIFECYCLE-IMPLEMENTATION-PLAN.md's
 * C2 section calls this out explicitly as "a judgment call worth a comment, not a silent side
 * effect." Auto-cancelling on suspend would be a surprising, hard-to-reverse side effect bundled
 * into an otherwise-reversible action (reinstate undoes the suspension, but not an auction it
 * triggered cancelling and notifying bidders about). An admin who judges a specific live auction
 * needs stopping too can still cancel it separately via cancelAuction()'s admin path (C4).
 */
export async function suspendUser(
  userId: string,
  adminUserId: string,
  reason: string,
): Promise<SuspendUserResult> {
  if (userId === adminUserId) return { kind: 'self' };

  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; status: string; email: string; name: string }>>`
      SELECT id, status, email, name FROM "User" WHERE id = ${userId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (row.status === 'SUSPENDED') return { kind: 'already-suspended' as const };

    await tx.user.update({ where: { id: row.id }, data: { status: 'SUSPENDED' } });
    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'USER_SUSPENDED',
        entityType: 'User',
        entityId: row.id,
        metadata: { reason },
      },
    });
    return { kind: 'ok' as const, email: row.email, name: row.name };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };

  invalidateUserStatusCache(userId);
  dispatchEmail(sendAccountSuspendedEmail({ email: outcome.email, name: outcome.name }, reason), `account-suspended (${userId})`);
  return { kind: 'ok' };
}

export type ReinstateUserResult = { kind: 'ok' } | { kind: 'not-found' } | { kind: 'not-suspended' };

export async function reinstateUser(userId: string, adminUserId: string): Promise<ReinstateUserResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; status: string; email: string; name: string }>>`
      SELECT id, status, email, name FROM "User" WHERE id = ${userId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (row.status !== 'SUSPENDED') return { kind: 'not-suspended' as const };

    await tx.user.update({ where: { id: row.id }, data: { status: 'ACTIVE' } });
    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'USER_REINSTATED',
        entityType: 'User',
        entityId: row.id,
        metadata: {},
      },
    });
    return { kind: 'ok' as const, email: row.email, name: row.name };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };

  invalidateUserStatusCache(userId);
  dispatchEmail(sendAccountReinstatedEmail({ email: outcome.email, name: outcome.name }), `account-reinstated (${userId})`);
  return { kind: 'ok' };
}
