import { Router } from 'express';
import { AuctionStatus, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { dispatchEmail, sendBidPlacedEmail } from '../../services/email.service.js';
import { placeBidSchema } from '../../openapi/requests.js';
import { buildSellerStatsMap, toAuctionDto } from './auction-dto.js';
import { decodeCursor, parseLimit, slicePage } from '../../utils/pagination.js';

const router = Router();
const MAX_STORED_MONEY = 2_000_000_000;

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status as AuctionStatus | undefined;
    const category = (req.query.category as string | undefined)?.trim();
    const search = (req.query.search as string | undefined)?.trim();
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const filters: Prisma.AuctionWhereInput = {};
    // BV-029: defaults to ACTIVE now that the list is paginated -- an unfiltered call used to
    // return every auction ever created, closed ones included, which is the exact unbounded
    // read this finding is about. The one current caller already asks for ?status=ACTIVE
    // explicitly (useActiveAuctions), so this default serves no one today and only narrows
    // what a direct API call returns by default. Still overridable: ?status=CLOSED etc. works.
    filters.status = status && ['SCHEDULED', 'ACTIVE', 'CLOSED'].includes(status) ? status : 'ACTIVE';
    if (category) {
      filters.category = { contains: category, mode: 'insensitive' };
    }
    if (search) {
      filters.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const where: Prisma.AuctionWhereInput = cursor
      ? {
          AND: [
            filters,
            {
              OR: [
                { endTime: { gt: new Date(cursor.sortValue) } },
                { endTime: new Date(cursor.sortValue), id: { gt: cursor.id } },
              ],
            },
          ],
        }
      : filters;

    const rows = await prisma.auction.findMany({
      where,
      include: { seller: true },
      orderBy: [{ endTime: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const { pageRows, nextCursor } = slicePage(rows, limit, (a) => a.endTime, (a) => a.id);
    const statsMap = await buildSellerStatsMap(pageRows.map(a => a.sellerId));
    ok(res, { items: pageRows.map(a => toAuctionDto(a, statsMap)), nextCursor });
  }),
);

router.get(
  '/mine/bids',
  requireAuth(['BUYER']),
  asyncHandler(async (req, res) => {
    const buyerId = req.auth!.userId;
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const where: Prisma.BidWhereInput = cursor
      ? {
          buyerId,
          OR: [
            { createdAt: { lt: new Date(cursor.sortValue) } },
            { createdAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
          ],
        }
      : { buyerId };

    const rows = await prisma.bid.findMany({
      where,
      include: { buyer: true, auction: { include: { seller: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const { pageRows, nextCursor } = slicePage(rows, limit, (b) => b.createdAt, (b) => b.id);
    const statsMap = await buildSellerStatsMap(pageRows.map(b => b.auction.sellerId));

    ok(res, {
      items: pageRows.map(bid => ({
        bidId: bid.id,
        auctionId: bid.auctionId,
        buyerId: bid.buyerId,
        // Filtered to `where: { buyerId }` above (the caller's own id, a live authenticated
        // user), so this bid's buyer can never be the null/anonymised case -- unlike the public
        // bid list on GET /:auctionId/bids.
        buyerName: bid.buyer!.name,
        amount: bid.amount,
        timestamp: bid.createdAt.toISOString(),
        auction: toAuctionDto(bid.auction, statsMap),
      })),
      nextCursor,
    });
  }),
);

router.get(
  '/:auctionId',
  asyncHandler(async (req, res) => {
    const auction = await prisma.auction.findUnique({
      where: { id: req.params.auctionId },
      include: { seller: true },
    });

    if (!auction) {
      fail(res, 'Auction not found.', 404);
      return;
    }

    const statsMap = await buildSellerStatsMap([auction.sellerId]);
    const dto = toAuctionDto(auction, statsMap);
    ok(res, dto);
  }),
);

router.get(
  '/:auctionId/bids',
  asyncHandler(async (req, res) => {
    const auctionId = req.params.auctionId;
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const where: Prisma.BidWhereInput = cursor
      ? {
          auctionId,
          OR: [
            { createdAt: { lt: new Date(cursor.sortValue) } },
            { createdAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
          ],
        }
      : { auctionId };

    const rows = await prisma.bid.findMany({
      where,
      include: { buyer: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const { pageRows, nextCursor } = slicePage(rows, limit, (b) => b.createdAt, (b) => b.id);

    ok(res, {
      items: pageRows.map((bid) => ({
        bidId: bid.id,
        auctionId: bid.auctionId,
        // BV-018: buyerId/buyer can now be null (an anonymised, deleted account). Reachable
        // now that the account-deletion route exists (BV-018/BV-042) -- anonymizeUser() keeps
        // the Bid row and its buyerId intact, so this stays a defensive fallback rather than
        // the common case, but it is genuinely reachable, not hypothetical.
        buyerId: bid.buyerId,
        buyerName: bid.buyer?.name ?? 'Deleted user',
        amount: bid.amount,
        timestamp: bid.createdAt.toISOString(),
      })),
      nextCursor,
    });
  }),
);

class BidError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message);
    this.name = 'BidError';
  }
}

router.post(
  '/:auctionId/bids',
  requireAuth(['BUYER']),
  validateBody(placeBidSchema),
  asyncHandler(async (req, res) => {
    const amount: number = req.body.amount;
    const auctionId = req.params.auctionId;
    const buyerId = req.auth!.userId;

    let result: {
      bid: Prisma.BidGetPayload<{ include: { buyer: true } }>;
      auctionTitle: string;
    };

    try {
      result = await prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{
          id: string;
          sellerId: string;
          title: string;
          startPrice: number;
          currentBid: number;
          bidCount: number;
          minIncrement: number;
          status: AuctionStatus;
          endTime: Date;
        }>>`
          SELECT id, "sellerId", title, "startPrice", "currentBid", "bidCount", "minIncrement", status, "endTime"
          FROM "Auction"
          WHERE id = ${auctionId}
          FOR UPDATE
        `;

        if (!row) throw new BidError(404, 'Auction not found.');
        if (row.sellerId === buyerId) throw new BidError(403, 'You cannot bid on your own auction.');
        if (row.status !== 'ACTIVE') throw new BidError(422, 'Bidding is closed for this auction.');
        if (new Date(row.endTime).getTime() <= Date.now()) throw new BidError(422, 'Auction has already ended.');

        // BV-013: currentBid is seeded to startPrice at creation, so "+ minIncrement" made the
        // advertised starting price itself unbiddable -- the real floor was one increment above
        // what both the seller set and the buyer was shown. The first bid is now allowed at the
        // start price, exactly like eBay; every bid after that must clear the previous one by a
        // full increment as before.
        const minAllowed = row.bidCount === 0 ? row.currentBid : row.currentBid + row.minIncrement;
        if (amount < minAllowed) {
          throw new BidError(422, `Bid must be at least PKR ${minAllowed.toLocaleString()}.`);
        }

        // The int32 schema ceiling prevents a database overflow, but by itself still lets a
        // buyer lock a low-value auction with a deliberately absurd yet storable bid. Bound
        // the jump relative to the auction under the same row lock used for the minimum.
        const maxAllowed = Math.min(
          MAX_STORED_MONEY,
          Math.max(minAllowed, row.currentBid * 10, row.startPrice * 100),
        );
        if (amount > maxAllowed) {
          throw new BidError(422, `Bid cannot exceed PKR ${maxAllowed.toLocaleString()} for this auction.`);
        }

        // NEW-05: outbid notification — find previous highest bidder before updating
        const prevHighest = row.bidCount > 0
          ? await tx.bid.findFirst({
              where: { auctionId: row.id, amount: row.currentBid },
              orderBy: { createdAt: 'desc' },
              select: { buyerId: true },
            })
          : null;

        const createdBid = await tx.bid.create({
          data: { auctionId: row.id, buyerId, amount },
          include: { buyer: true },
        });

        await tx.auction.update({
          where: { id: row.id },
          data: { currentBid: amount, bidCount: { increment: 1 } },
          select: { id: true },
        });

        // BV-018: a null buyerId means that bidder's account was anonymised -- nobody to notify.
        if (prevHighest && prevHighest.buyerId !== null && prevHighest.buyerId !== buyerId) {
          const recipient = await tx.user.findUnique({
            where: { id: prevHighest.buyerId },
            select: { notifyOutbid: true },
          });
          if (recipient?.notifyOutbid) {
            await tx.notification.create({
              data: {
                userId: prevHighest.buyerId,
                type: 'BID_OUTBID',
                title: "You've been outbid",
                message: `Your bid on "${row.title}" was outbid. New leading bid: PKR ${amount.toLocaleString()}.`,
              },
            });
          }
        }

        return { bid: createdBid, auctionTitle: row.title };
      });
    } catch (err) {
      if (err instanceof BidError) {
        fail(res, err.message, err.httpStatus);
        return;
      }
      throw err;
    }

    const { bid, auctionTitle } = result;
    // bid.buyer is the caller who just placed this bid a moment ago -- it cannot be the
    // null/anonymised case (BV-018) that only applies to a bid's buyer sometime after the fact.
    const buyer = bid.buyer!;

    // The database is the only source of truth for currentBid/bidCount (BV-010 removed the
    // Redis overlay that used to shadow it here) -- live viewers get the update below via the
    // socket broadcast, not by re-reading the row.
    const io = req.app.get('io') as Server | undefined;
    io?.to(`auction:${auctionId}`).emit('bid:placed', {
      auctionId,
      bid: {
        bidId: bid.id,
        amount: bid.amount,
        buyerId: bid.buyerId,
        buyerName: buyer.name,
        timestamp: bid.createdAt.toISOString(),
      },
    });

    // Not awaited: bidding is the most latency-sensitive action in the product and this
    // send was adding ~3.3s to every bid.
    dispatchEmail(sendBidPlacedEmail(
      { email: buyer.email, name: buyer.name },
      { title: auctionTitle, amount: bid.amount, auctionId },
    ), 'bid placed');

    ok(res, {
      bidId: bid.id,
      auctionId: bid.auctionId,
      buyerId: bid.buyerId,
      buyerName: buyer.name,
      amount: bid.amount,
      timestamp: bid.createdAt.toISOString(),
    }, 201);
  }),
);

export default router;
