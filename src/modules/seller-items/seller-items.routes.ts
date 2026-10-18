import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { failField, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { decodeCursor, parseLimit, slicePage, type DecodedCursor } from '../../utils/pagination.js';
import { escapeLike } from '../../utils/escape-like.js';
import { SELLER_ITEMS_SEARCH_MAX } from '../../openapi/requests.js';
import type { SellerItemDtoType, SellerItemsSummaryDtoType } from '../../openapi/schemas.js';
import { buildWatcherCountMap } from '../auctions/auction-dto.js';
import { findNextBid } from '../../services/auction-control.service.js';
import { disputeResponseDueAt } from '../../services/fulfillment.service.js';
import { getPlatformSettings } from '../../services/settings.service.js';
import {
  SELLER_ITEM_TABS,
  STAGE_TAB,
  allowedActions,
  deriveStage,
  tabWhere,
  type ItemFacts,
  type SellerItemTab,
} from './seller-item-stage.js';

/**
 * The seller's whole inventory as one list: one row per Listing whatever stage it is in, split into
 * six tabs (see seller-item-stage.ts for the rules). Read-only; every action a row offers is an
 * existing endpoint, and the rules that decide which are offered live next to the stage rules.
 */

const router = Router();

const itemInclude = {
  auction: {
    include: {
      transactions: {
        include: {
          winner: { select: { name: true } },
          dispute: true,
          review: { select: { stars: true } },
          ledgerEntry: { select: { createdAt: true } },
        },
      },
    },
  },
  relistedAs: { select: { id: true, listingCode: true } },
} satisfies Prisma.ListingInclude;

type ItemRow = Prisma.ListingGetPayload<{ include: typeof itemInclude }>;

// A live or finished auction is read by when it ends; a listing that has no auction yet (or never
// will) by when it was submitted. Every row on an "auctionEnd" tab has an auction, because each
// stage on those tabs does (a sale, a live or ended or cancelled auction).
interface TabOrder {
  key: 'auctionEnd' | 'submitted';
  dir: 'asc' | 'desc';
}

const TAB_ORDER: Record<SellerItemTab, TabOrder> = {
  action: { key: 'auctionEnd', dir: 'asc' }, // waiting longest first
  live: { key: 'auctionEnd', dir: 'asc' }, // ending soonest first
  sold: { key: 'auctionEnd', dir: 'desc' },
  unsold: { key: 'auctionEnd', dir: 'desc' },
  review: { key: 'submitted', dir: 'desc' },
  closed: { key: 'submitted', dir: 'desc' },
};

function sortValue(row: ItemRow, order: TabOrder): Date {
  if (order.key === 'submitted') return row.submittedAt;
  if (!row.auction) throw new Error(`seller-items: listing ${row.id} is on an auction-ordered tab but has no auction`);
  return row.auction.endTime;
}

export function itemsOrderBy(tab: SellerItemTab): Prisma.ListingOrderByWithRelationInput[] {
  const order = TAB_ORDER[tab];
  return order.key === 'auctionEnd'
    ? [{ auction: { endTime: order.dir } }, { id: order.dir }]
    : [{ submittedAt: order.dir }, { id: order.dir }];
}

function cursorWhere(order: TabOrder, cursor: DecodedCursor): Prisma.ListingWhereInput {
  const beyond = order.dir === 'asc' ? 'gt' : 'lt';
  const at = new Date(cursor.sortValue);
  return order.key === 'auctionEnd'
    ? {
        OR: [
          { auction: { is: { endTime: { [beyond]: at } } } },
          { auction: { is: { endTime: at } }, id: { [beyond]: cursor.id } },
        ],
      }
    : { OR: [{ submittedAt: { [beyond]: at } }, { submittedAt: at, id: { [beyond]: cursor.id } }] };
}

/**
 * The listings one page of a tab is drawn from: this seller's, in this tab, matching the search
 * (title or listing code, case-insensitive, % and _ literal) when there is one, and past the
 * cursor when there is one. Exported so the query can be measured as the route runs it.
 */
export function itemsWhere(
  sellerId: string,
  tab: SellerItemTab,
  search: string,
  cursor?: DecodedCursor,
): Prisma.ListingWhereInput {
  const term = escapeLike(search);
  return {
    AND: [
      { sellerId },
      tabWhere(tab),
      ...(search
        ? [
            {
              OR: [
                { title: { contains: term, mode: 'insensitive' as const } },
                { listingCode: { contains: term, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
      ...(cursor ? [cursorWhere(TAB_ORDER[tab], cursor)] : []),
    ],
  };
}

function factsOf(row: ItemRow, hasNextBidder: boolean): ItemFacts {
  const auction = row.auction ?? undefined;
  const sale = auction?.transactions[0];
  return {
    listingStatus: row.status,
    auctionStatus: auction?.status,
    reserveMet: auction?.reserveMet,
    bidCount: auction?.bidCount,
    txnStatus: sale?.status,
    disputeResponded: sale?.dispute?.sellerResponse != null,
    relisted: row.relistedAs !== null,
    hasNextBidder,
  };
}

async function toDtos(rows: ItemRow[]): Promise<SellerItemDtoType[]> {
  const auctionIds = rows.flatMap((r) => (r.auction ? [r.auction.id] : []));
  const [watchers, settings] = await Promise.all([buildWatcherCountMap(auctionIds), getPlatformSettings()]);

  return Promise.all(
    rows.map(async (row) => {
      const auction = row.auction ?? undefined;
      const sale = auction?.transactions[0];

      // The one stage that needs a second query: who an unpaid sale could be offered to, chosen by
      // the same findNextBid the offer itself uses, so the preview cannot promise what the offer
      // would refuse.
      let next = null;
      if (auction && sale && deriveStage(factsOf(row, false)) === 'PAYMENT_DEFAULTED') {
        next = await findNextBid(prisma, auction.id, [...sale.previousWinnerIds, sale.winnerId]);
      }

      const facts = factsOf(row, next !== null);
      const stage = deriveStage(facts);

      return {
        itemId: row.id,
        listingCode: row.listingCode,
        title: row.title,
        category: row.category,
        condition: row.condition,
        emoji: row.emoji ?? '📦',
        imageUrl: row.imageUrl ?? undefined,
        tab: STAGE_TAB[stage],
        stage,
        actions: allowedActions(stage, facts),
        listing: {
          description: row.description,
          startPrice: row.startPrice,
          reservePrice: row.reservePrice ?? undefined,
          minIncrement: row.minIncrement,
          durationDays: row.durationDays,
          submittedAt: row.submittedAt.toISOString(),
          rejectionReason: row.rejectionReason ?? undefined,
          attributes: (row.attributes as Record<string, string | number> | null) ?? undefined,
        },
        auction: auction && {
          auctionId: auction.id,
          status: auction.status,
          currentBid: auction.currentBid,
          bidCount: auction.bidCount,
          watcherCount: watchers.get(auction.id) ?? 0,
          reserveMet: auction.reserveMet,
          startTime: auction.startTime.toISOString(),
          endTime: auction.endTime.toISOString(),
        },
        sale: sale && {
          transactionId: sale.id,
          status: sale.status,
          finalAmount: sale.finalAmount,
          buyerName: sale.winner.name,
          deliveryAddress: sale.deliveryAddress ?? undefined,
          deliveryPhone: sale.deliveryPhone ?? undefined,
          paidAt: sale.paidAt?.toISOString(),
          shippedAt: sale.shippedAt?.toISOString(),
          reviewDeadlineAt: sale.shippedAt
            ? new Date(sale.shippedAt.getTime() + settings.reviewTimeoutHours * 60 * 60 * 1000).toISOString()
            : undefined,
          disputeReason: sale.dispute?.reason,
          disputeResponseDueAt: sale.dispute ? disputeResponseDueAt(sale.dispute.createdAt).toISOString() : undefined,
          disputeSellerResponse: sale.dispute?.sellerResponse ?? undefined,
          disputeSellerRespondedAt: sale.dispute?.sellerRespondedAt?.toISOString(),
          payoutAt: sale.ledgerEntry?.createdAt.toISOString(),
          reviewStars: sale.review?.stars,
          nextBidderOffer: next?.amount ?? null,
        },
        relistedAs: row.relistedAs ? { listingId: row.relistedAs.id, listingCode: row.relistedAs.listingCode } : undefined,
      };
    }),
  );
}

router.get(
  '/',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    const sellerId = req.auth!.userId;
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);
    // An unknown or missing tab means "action", like /auctions/mine's status: a stale link lands
    // on a list instead of an error.
    const tab = SELLER_ITEM_TABS.find((t) => t === req.query.tab) ?? 'action';

    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search.length > SELLER_ITEMS_SEARCH_MAX) {
      failField(res, 'search', `Search must be ${SELLER_ITEMS_SEARCH_MAX} characters or fewer.`, 400);
      return;
    }

    const order = TAB_ORDER[tab];
    const rows = await prisma.listing.findMany({
      where: itemsWhere(sellerId, tab, search, cursor),
      include: itemInclude,
      orderBy: itemsOrderBy(tab),
      take: limit + 1,
    });

    const { pageRows, nextCursor } = slicePage(rows, limit, (r) => sortValue(r, order), (r) => r.id);
    ok(res, { items: await toDtos(pageRows), nextCursor });
  }),
);

// The tab badges: always the whole inventory, whatever search the list is showing.
router.get(
  '/summary',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    const sellerId = req.auth!.userId;
    const entries = await Promise.all(
      SELLER_ITEM_TABS.map(
        async (tab) => [tab, await prisma.listing.count({ where: { AND: [{ sellerId }, tabWhere(tab)] } })] as const,
      ),
    );
    const body: SellerItemsSummaryDtoType = { counts: Object.fromEntries(entries) as SellerItemsSummaryDtoType['counts'] };
    ok(res, body);
  }),
);

export default router;
