import { Router } from 'express';
import type { TransactionStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { voidTransactionSchema, anonymizeUserSchema, resolveDisputeSchema } from '../../openapi/requests.js';
import { checkAccountDeletable, anonymizeUser } from '../../services/account.service.js';
import { dispatchEmail, sendAccountDeletedEmail } from '../../services/email.service.js';
import { resolveDispute, REVENUE_STATUSES } from '../../services/fulfillment.service.js';

const router = Router();

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

router.get(
  '/analytics',
  requireAuth(['ADMIN']),
  asyncHandler(async (_req, res) => {
    // UTC throughout (BV-008): a server running in any timezone other than UTC bucketed
    // records near a month boundary into the wrong month, silently -- Jan 31 23:30 UTC is
    // still January there, but `new Date(...).getMonth()` reads it back in *local* time,
    // which pushes it into February the moment the container's zone is even one hour ahead.
    const now = new Date();
    const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));

    const [
      listingsTotal,
      listingsApproved,
      completedTxStats,
      bidStats,
      revenueByMonth,
      bidsByMonth,
      categoryGroups,
      sellerTxGroups,
    ] = await Promise.all([
      prisma.listing.count(),
      prisma.listing.count({ where: { status: 'APPROVED' } }),
      prisma.auctionTransaction.aggregate({
        where: { status: { in: REVENUE_STATUSES } },
        _sum: { finalAmount: true },
        _count: { id: true },
      }),
      prisma.bid.aggregate({
        _count: { id: true },
        _avg: { amount: true },
      }),
      // Grouped and summed in Postgres rather than pulled row-by-row and reduced in JS
      // (BV-008): the old findMany fetched every matching row just to compute 12 monthly
      // sums, a cost that grows with total row count instead of staying at "12 numbers".
      //
      // date_trunc('month', x AT TIME ZONE 'UTC') returns a *naive* timestamp -- one with no
      // zone attached, holding UTC wall-clock digits ("2026-06-01 00:00:00" for midnight UTC
      // on June 1st, regardless of what "createdAt" itself carried). node-postgres decodes a
      // naive timestamp into a JS Date by reading those same digits as *local* time, so the
      // Date this produces has its correct UTC-wall-clock reading sitting behind whatever the
      // process's own zone is -- read it back with the matching local getters below
      // (row.month.getFullYear()/getMonth()), not the UTC ones, or the two conversions no
      // longer cancel out and the month silently shifts by the server's own offset. Confirmed
      // by running both readings side by side against a known date: UTC getters landed a
      // 2026-06-01 UTC row in May.
      // Kept in sync by hand with REVENUE_STATUSES (fulfillment.service.ts) — raw SQL can't
      // share that array directly.
      prisma.$queryRaw<{ month: Date; revenue: bigint | null }[]>`
        SELECT date_trunc('month', "createdAt" AT TIME ZONE 'UTC') AS month,
               SUM("finalAmount") AS revenue
        FROM "AuctionTransaction"
        WHERE status IN ('COMPLETED', 'SHIPPED', 'DELIVERED', 'DISPUTED') AND "createdAt" >= ${twelveMonthsAgo}
        GROUP BY month
      `,
      prisma.$queryRaw<{ month: Date; count: bigint }[]>`
        SELECT date_trunc('month', "createdAt" AT TIME ZONE 'UTC') AS month,
               COUNT(*) AS count
        FROM "Bid"
        WHERE "createdAt" >= ${twelveMonthsAgo}
        GROUP BY month
      `,
      // No `take` — a truncated groupBy makes the percentages below add up to 100% while
      // silently omitting whole categories, presenting partial data as the full picture.
      // Callers that need a short list should aggregate the tail into an "Other" row.
      prisma.listing.groupBy({
        by: ['category'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.auctionTransaction.groupBy({
        by: ['sellerId'],
        where: { status: { in: REVENUE_STATUSES } },
        _sum: { finalAmount: true },
        _count: { id: true },
        orderBy: { _sum: { finalAmount: 'desc' } },
        take: 5,
      }),
    ]);

    // Build ordered month key list for last 12 months, in UTC to match the queries above.
    const orderedKeys: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const key = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      orderedKeys.push(`${key.getUTCFullYear()}-${key.getUTCMonth()}`);
    }

    const revenueMap = new Map<string, number>(orderedKeys.map(k => [k, 0]));
    const bidsMap    = new Map<string, number>(orderedKeys.map(k => [k, 0]));

    for (const row of revenueByMonth) {
      // Local getters, deliberately -- see the query comment above.
      const key = `${row.month.getFullYear()}-${row.month.getMonth()}`;
      if (revenueMap.has(key)) revenueMap.set(key, Number(row.revenue ?? 0));
    }
    for (const row of bidsByMonth) {
      const key = `${row.month.getFullYear()}-${row.month.getMonth()}`;
      if (bidsMap.has(key)) bidsMap.set(key, Number(row.count));
    }

    const monthlyRevenue = orderedKeys.map(key => ({
      month: MONTH_NAMES[parseInt(key.split('-')[1])],
      value: revenueMap.get(key) ?? 0,
      bids:  bidsMap.get(key)    ?? 0,
    }));

    // Category breakdown.
    //
    // Percentages are apportioned by largest remainder rather than rounded independently.
    // Rounding each share on its own lets the error accumulate — with 8 categories the panel
    // displayed shares totalling 102%. Floor every share, then hand the leftover points to
    // the largest fractional remainders, so the column always sums to exactly 100.
    const totalCatCount = categoryGroups.reduce((s, g) => s + g._count.id, 0);
    const exactShares = categoryGroups.map(g => ({
      name: g.category,
      count: g._count.id,
      exact: totalCatCount > 0 ? (g._count.id / totalCatCount) * 100 : 0,
    }));
    const floored = exactShares.map(s => ({ ...s, pct: Math.floor(s.exact) }));
    let leftover = (totalCatCount > 0 ? 100 : 0) - floored.reduce((s, c) => s + c.pct, 0);
    const byRemainder = [...floored].sort(
      (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)),
    );
    for (const row of byRemainder) {
      if (leftover <= 0) break;
      row.pct += 1;
      leftover -= 1;
    }
    const categoryBreakdown = floored.map(({ name, count, pct }) => ({ name, count, pct }));

    // Top sellers — resolve names
    const sellerIds = sellerTxGroups.map(g => g.sellerId);
    const sellers = sellerIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameMap = new Map(sellers.map(u => [u.id, u.name]));
    const topSellers = sellerTxGroups.map(g => ({
      sellerId:   g.sellerId,
      sellerName: nameMap.get(g.sellerId) ?? 'Unknown',
      sales:      g._count.id,
      revenue:    g._sum.finalAmount ?? 0,
    }));

    ok(res, {
      totalRevenue:         completedTxStats._sum.finalAmount ?? 0,
      totalBids:            bidStats._count.id,
      avgBidValue:          Math.round(bidStats._avg.amount ?? 0),
      sellerConversionRate: listingsTotal > 0
        ? Math.round((listingsApproved / listingsTotal) * 100)
        : 0,
      monthlyRevenue,
      categoryBreakdown,
      topSellers,
    });
  }),
);

// BV-004 / BV-006: neither an uncapped-bid winner who vanishes nor a buyer who never returns
// after a decline had any way out before this — the transaction just sat PENDING forever,
// with the listing permanently consumed (Auction.listingId is @unique) and no admin surface
// to do anything about it. This is that surface: list the stuck ones, then void the ones that
// are never going to be paid.
router.get(
  '/transactions',
  requireAuth(['ADMIN']),
  asyncHandler(async (_req, res) => {
    const transactions = await prisma.auctionTransaction.findMany({
      where: { status: 'PENDING' },
      include: {
        auction: { select: { title: true } },
        winner: { select: { id: true, name: true } },
        seller: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    ok(res, transactions.map((tx) => ({
      transactionId: tx.id,
      auctionId: tx.auctionId,
      auctionTitle: tx.auction.title,
      buyerId: tx.winner.id,
      buyerName: tx.winner.name,
      sellerId: tx.seller.id,
      sellerName: tx.seller.name,
      finalAmount: tx.finalAmount,
      status: tx.status,
      lastPaymentError: tx.lastPaymentError ?? undefined,
      createdAt: tx.createdAt.toISOString(),
    })));
  }),
);

router.post(
  '/transactions/:transactionId/void',
  requireAuth(['ADMIN']),
  validateBody(voidTransactionSchema),
  asyncHandler(async (req, res) => {
    const { transactionId } = req.params;
    const { reason } = req.body;
    const adminUserId = req.auth!.userId;

    // Locked so a webhook delivery completing this exact transaction and an admin voiding it
    // cannot both win -- the same FOR UPDATE pattern payments.routes.ts uses for create-intent.
    const outcome = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ id: string; status: TransactionStatus }>>`
        SELECT id, status FROM "AuctionTransaction" WHERE id = ${transactionId} FOR UPDATE
      `;

      if (!row) return { kind: 'not-found' as const };
      if (row.status !== 'PENDING') return { kind: 'not-pending' as const };

      await tx.auctionTransaction.update({
        where: { id: row.id },
        data: { status: 'VOIDED', lastPaymentError: null },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: adminUserId,
          action: 'TRANSACTION_VOIDED',
          entityType: 'AuctionTransaction',
          entityId: row.id,
          metadata: { reason },
        },
      });

      return { kind: 'ok' as const };
    });

    if (outcome.kind === 'not-found') {
      fail(res, 'Transaction not found.', 404);
      return;
    }
    if (outcome.kind === 'not-pending') {
      fail(res, 'Only a pending transaction can be voided.', 409);
      return;
    }
    ok(res, { transactionId, status: 'VOIDED' });
  }),
);

// BV-047 / E6: the admin side of the dispute the platform previously had no way to express at
// all. Every state transition and every Stripe call lives in fulfillment.service.ts -- this
// route only authenticates and translates the result.
router.get(
  '/disputes',
  requireAuth(['ADMIN']),
  asyncHandler(async (_req, res) => {
    const disputes = await prisma.dispute.findMany({
      where: { status: 'OPEN' },
      include: {
        transaction: {
          include: {
            auction: { select: { title: true } },
            winner: { select: { id: true, name: true } },
            seller: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    ok(res, disputes.map((d) => ({
      disputeId: d.id,
      transactionId: d.transactionId,
      auctionTitle: d.transaction.auction.title,
      buyerId: d.transaction.winner.id,
      buyerName: d.transaction.winner.name,
      sellerId: d.transaction.seller.id,
      sellerName: d.transaction.seller.name,
      finalAmount: d.transaction.finalAmount,
      reason: d.reason,
      createdAt: d.createdAt.toISOString(),
    })));
  }),
);

router.post(
  '/disputes/:disputeId/resolve',
  requireAuth(['ADMIN']),
  validateBody(resolveDisputeSchema),
  asyncHandler(async (req, res) => {
    const { disputeId } = req.params;
    const { resolution, note } = req.body;
    const adminUserId = req.auth!.userId;

    const result = await resolveDispute(disputeId, adminUserId, resolution, note);

    if (result.kind === 'not-found') {
      fail(res, 'Dispute not found.', 404);
      return;
    }
    if (result.kind === 'not-open') {
      fail(res, 'This dispute has already been resolved.', 409);
      return;
    }
    ok(res, { disputeId, resolution });
  }),
);

// BV-018: the admin half of anonymise-in-place -- for a support request from someone who can
// no longer sign in to use the self-service route themselves (auth/delete-account). Search by
// email first: there is no general user-directory screen, and building one is a bigger
// feature than this one action needs.
router.get(
  '/users',
  requireAuth(['ADMIN']),
  asyncHandler(async (req, res) => {
    const email = (req.query.email as string | undefined)?.trim();
    if (!email) {
      fail(res, 'Query parameter "email" is required.', 400);
      return;
    }

    const users = await prisma.user.findMany({
      where: { email: { contains: email, mode: 'insensitive' } },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    ok(res, users.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt.toISOString(),
    })));
  }),
);

router.post(
  '/users/:userId/anonymize',
  requireAuth(['ADMIN']),
  validateBody(anonymizeUserSchema),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;
    const adminUserId = req.auth!.userId;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      fail(res, 'User not found.', 404);
      return;
    }

    const guard = await checkAccountDeletable(userId);
    if (!guard.allowed) {
      fail(res, guard.reason!, 409);
      return;
    }

    dispatchEmail(sendAccountDeletedEmail({ email: user.email, name: user.name }), 'account deleted (admin)');

    await anonymizeUser(userId);
    await prisma.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'USER_ANONYMIZED',
        entityType: 'User',
        entityId: userId,
        metadata: { reason },
      },
    });

    ok(res, { userId, status: 'ANONYMIZED' });
  }),
);

export default router;
