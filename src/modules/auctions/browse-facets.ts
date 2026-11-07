import type { ItemCondition, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import type { AuctionFacetsDtoType } from '../../openapi/schemas.js';
import { buildFilters, DEFAULT_SORT, type BrowseParams, type FacetGroup } from './browse-query.js';

const CONDITIONS: readonly ItemCondition[] = ['NEW', 'LIKE_NEW', 'USED'];

// Whole-rupee ranges on the current bid, side by side with no gap: the rail turns a band into a
// minPrice and a maxPrice of these same numbers, so a count and the list it opens always agree.
const PRICE_BANDS: readonly { id: AuctionFacetsDtoType['priceBands'][number]['id']; range: Prisma.IntFilter }[] = [
  { id: 'under-5000', range: { lt: 5_000 } },
  { id: '5000-25000', range: { gte: 5_000, lte: 25_000 } },
  { id: 'over-25000', range: { gt: 25_000 } },
];

/**
 * Counts for the browse filters, read as grouped counts: no auction row leaves the database. A
 * sort means nothing to a count, so it is set aside: the "ending soonest with bids" sort would
 * otherwise quietly turn into a bids filter here.
 */
export async function loadFacets(requested: BrowseParams): Promise<AuctionFacetsDtoType> {
  const params: BrowseParams = { ...requested, sort: DEFAULT_SORT };
  const without = (group: FacetGroup) => buildFilters(params, group);

  const [categories, conditions, bands, withBids] = await Promise.all([
    prisma.auction.groupBy({ by: ['category'], where: without('category'), _count: { _all: true } }),
    prisma.auction.groupBy({ by: ['condition'], where: without('condition'), _count: { _all: true } }),
    Promise.all(
      PRICE_BANDS.map((band) => prisma.auction.count({ where: { AND: [without('price'), { currentBid: band.range }] } })),
    ),
    prisma.auction.count({ where: { AND: [without('withBids'), { bidCount: { gt: 0 } }] } }),
  ]);

  return {
    categories: categories
      .map((row) => ({ name: row.category, count: row._count._all }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    conditions: CONDITIONS.map((value) => ({
      value,
      count: conditions.find((row) => row.condition === value)?._count._all ?? 0,
    })),
    priceBands: PRICE_BANDS.map((band, i) => ({ id: band.id, count: bands[i] })),
    withBids,
  };
}
