import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import type { AuctionDtoType } from '../../openapi/schemas.js';

/**
 * Seller rating + completed-sales counts for a set of sellers, in two grouped queries
 * rather than one pair per auction.
 *
 * Lives here rather than in auctions.routes.ts because /watchlist serves the same
 * AuctionDto and needs the same numbers; duplicating the mapper is how the watchlist
 * ended up returning a five-field subset that no auction card could render.
 */
export async function buildSellerStatsMap(sellerIds: string[]) {
  const uniqueIds = [...new Set(sellerIds)];
  const map = new Map<string, { rating: number | null; salesCount: number }>();
  for (const id of uniqueIds) map.set(id, { rating: null, salesCount: 0 });

  if (uniqueIds.length === 0) return map;

  const [ratings, sales] = await Promise.all([
    prisma.sellerReview.groupBy({
      by: ['sellerId'],
      where: { sellerId: { in: uniqueIds } },
      _avg: { stars: true },
    }),
    prisma.auctionTransaction.groupBy({
      by: ['sellerId'],
      where: { sellerId: { in: uniqueIds }, status: 'COMPLETED' },
      _count: { sellerId: true },
    }),
  ]);

  for (const r of ratings) {
    const rounded = r._avg.stars !== null ? Math.round(r._avg.stars * 10) / 10 : null;
    map.set(r.sellerId, { ...map.get(r.sellerId)!, rating: rounded });
  }
  for (const s of sales) {
    map.set(s.sellerId, { ...map.get(s.sellerId)!, salesCount: s._count.sellerId });
  }
  return map;
}

// Return type is the published contract, not inferred. If this mapper and
// openapi/schemas.ts drift apart, the build breaks here rather than the frontend
// silently receiving a shape its generated types say is impossible.
export function toAuctionDto(
  auction: Prisma.AuctionGetPayload<{ include: { seller: true } }>,
  statsMap?: Map<string, { rating: number | null; salesCount: number }>,
): AuctionDtoType {
  const stats = statsMap?.get(auction.sellerId);
  return {
    auctionId: auction.id,
    listingId: auction.listingId,
    title: auction.title,
    category: auction.category,
    condition: auction.condition,
    description: auction.description,
    emoji: auction.emoji ?? '📦',
    sellerId: auction.sellerId,
    sellerName: auction.seller.name,
    sellerRating: stats?.rating ?? null,
    sellerSales: stats ? stats.salesCount : null,
    startPrice: auction.startPrice,
    currentBid: auction.currentBid,
    minIncrement: auction.minIncrement,
    // reservePrice is deliberately NOT sent. This DTO is served by the public
    // GET /auctions and GET /auctions/:id, so publishing the amount hands every bidder the
    // seller's hidden floor: bid exactly the reserve and never a rupee more, or walk away on
    // seeing it is out of reach. Only the derived verdict goes out. The owning seller and
    // admins still get the number through the listing DTO, which is role-gated.
    //
    // null   = no reserve was set
    // false  = reserve not reached (live comparison while open, the worker's recorded
    //          verdict once closed)
    // true   = reserve reached
    reserveMet:
      auction.reservePrice === null
        ? null
        : (auction.reserveMet ?? auction.currentBid >= auction.reservePrice),
    bidCount: auction.bidCount,
    startTime: auction.startTime.toISOString(),
    endTime: auction.endTime.toISOString(),
    status: auction.status,
    imageUrl: auction.imageUrl ?? '',
    images: auction.imageUrl ? [auction.imageUrl] : [],
    attributes: (auction.attributes as Record<string, string | number> | null) ?? undefined,
  };
}
