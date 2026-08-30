import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';

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
        where: { status: 'COMPLETED' },
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
      prisma.$queryRaw<{ month: Date; revenue: bigint | null }[]>`
        SELECT date_trunc('month', "createdAt" AT TIME ZONE 'UTC') AS month,
               SUM("finalAmount") AS revenue
        FROM "AuctionTransaction"
        WHERE status = 'COMPLETED' AND "createdAt" >= ${twelveMonthsAgo}
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
        where: { status: 'COMPLETED' },
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

export default router;
