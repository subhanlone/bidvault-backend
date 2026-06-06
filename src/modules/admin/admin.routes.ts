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
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const [
      listingsTotal,
      listingsApproved,
      completedTxStats,
      bidStats,
      recentTxs,
      recentBids,
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
      prisma.auctionTransaction.findMany({
        where: { status: 'COMPLETED', createdAt: { gte: twelveMonthsAgo } },
        select: { finalAmount: true, createdAt: true },
      }),
      prisma.bid.findMany({
        where: { createdAt: { gte: twelveMonthsAgo } },
        select: { createdAt: true },
      }),
      prisma.listing.groupBy({
        by: ['category'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 6,
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

    // Build ordered month key list for last 12 months
    const orderedKeys: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      orderedKeys.push(`${d.getFullYear()}-${d.getMonth()}`);
    }

    const revenueMap = new Map<string, number>(orderedKeys.map(k => [k, 0]));
    const bidsMap    = new Map<string, number>(orderedKeys.map(k => [k, 0]));

    for (const tx of recentTxs) {
      const d = new Date(tx.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (revenueMap.has(key)) revenueMap.set(key, (revenueMap.get(key) ?? 0) + tx.finalAmount);
    }
    for (const b of recentBids) {
      const d = new Date(b.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (bidsMap.has(key)) bidsMap.set(key, (bidsMap.get(key) ?? 0) + 1);
    }

    const monthlyRevenue = orderedKeys.map(key => ({
      month: MONTH_NAMES[parseInt(key.split('-')[1])],
      value: revenueMap.get(key) ?? 0,
      bids:  bidsMap.get(key)    ?? 0,
    }));

    // Category breakdown
    const totalCatCount = categoryGroups.reduce((s, g) => s + g._count.id, 0);
    const categoryBreakdown = categoryGroups.map(g => ({
      name:  g.category,
      count: g._count.id,
      pct:   totalCatCount > 0 ? Math.round((g._count.id / totalCatCount) * 100) : 0,
    }));

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
