import { Router } from 'express';
import { AuctionStatus, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { getAuctionRuntimeState, setAuctionRuntimeState } from '../../services/auction-state.service.js';
import { dispatchEmail, sendBidPlacedEmail } from '../../services/email.service.js';
import { placeBidSchema } from '../../openapi/requests.js';
import { buildSellerStatsMap, toAuctionDto } from './auction-dto.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status as AuctionStatus | undefined;
    const category = (req.query.category as string | undefined)?.trim();
    const search = (req.query.search as string | undefined)?.trim();

    const where: Prisma.AuctionWhereInput = {};
    if (status && ['SCHEDULED', 'ACTIVE', 'CLOSED'].includes(status)) {
      where.status = status;
    }
    if (category) {
      where.category = { contains: category, mode: 'insensitive' };
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const auctions = await prisma.auction.findMany({
      where,
      include: { seller: true },
      orderBy: { endTime: 'asc' },
    });

    const statsMap = await buildSellerStatsMap(auctions.map(a => a.sellerId));
    ok(res, auctions.map(a => toAuctionDto(a, statsMap)));
  }),
);

router.get(
  '/mine/bids',
  requireAuth(['BUYER']),
  asyncHandler(async (req, res) => {
    const buyerId = req.auth!.userId;
    const bids = await prisma.bid.findMany({
      where: { buyerId },
      include: { buyer: true, auction: { include: { seller: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const statsMap = await buildSellerStatsMap(bids.map(b => b.auction.sellerId));

    ok(
      res,
      bids.map(bid => ({
        bidId: bid.id,
        auctionId: bid.auctionId,
        buyerId: bid.buyerId,
        buyerName: bid.buyer.name,
        amount: bid.amount,
        timestamp: bid.createdAt.toISOString(),
        auction: toAuctionDto(bid.auction, statsMap),
      })),
    );
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

    const runtime = await getAuctionRuntimeState(auction.id);
    const statsMap = await buildSellerStatsMap([auction.sellerId]);
    const dto = toAuctionDto(auction, statsMap);
    ok(res, {
      ...dto,
      currentBid: runtime.currentBid ?? dto.currentBid,
      bidCount: runtime.bidCount ?? dto.bidCount,
    });
  }),
);

router.get(
  '/:auctionId/bids',
  asyncHandler(async (req, res) => {
    const bids = await prisma.bid.findMany({
      where: { auctionId: req.params.auctionId },
      include: { buyer: true },
      orderBy: { createdAt: 'desc' },
    });

    ok(
      res,
      bids.map((bid) => ({
        bidId: bid.id,
        auctionId: bid.auctionId,
        buyerId: bid.buyerId,
        buyerName: bid.buyer.name,
        amount: bid.amount,
        timestamp: bid.createdAt.toISOString(),
      })),
    );
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
      updatedAuction: { currentBid: number; bidCount: number };
      auctionTitle: string;
    };

    try {
      result = await prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{
          id: string;
          sellerId: string;
          title: string;
          currentBid: number;
          bidCount: number;
          minIncrement: number;
          status: AuctionStatus;
          endTime: Date;
        }>>`
          SELECT id, "sellerId", title, "currentBid", "bidCount", "minIncrement", status, "endTime"
          FROM "Auction"
          WHERE id = ${auctionId}
          FOR UPDATE
        `;

        if (!row) throw new BidError(404, 'Auction not found.');
        if (row.sellerId === buyerId) throw new BidError(403, 'You cannot bid on your own auction.');
        if (row.status !== 'ACTIVE') throw new BidError(400, 'Bidding is closed for this auction.');
        if (new Date(row.endTime).getTime() <= Date.now()) throw new BidError(400, 'Auction has already ended.');

        const minAllowed = row.currentBid + row.minIncrement;
        if (amount < minAllowed) {
          throw new BidError(400, `Bid must be at least PKR ${minAllowed.toLocaleString()}.`);
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

        const nextAuction = await tx.auction.update({
          where: { id: row.id },
          data: { currentBid: amount, bidCount: { increment: 1 } },
          select: { currentBid: true, bidCount: true },
        });

        if (prevHighest && prevHighest.buyerId !== buyerId) {
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

        return { bid: createdBid, updatedAuction: nextAuction, auctionTitle: row.title };
      });
    } catch (err) {
      if (err instanceof BidError) {
        fail(res, err.message, err.httpStatus);
        return;
      }
      throw err;
    }

    const { bid, updatedAuction, auctionTitle } = result;

    await setAuctionRuntimeState({
      auctionId,
      currentBid: updatedAuction.currentBid,
      bidCount: updatedAuction.bidCount,
    });

    const io = req.app.get('io') as Server | undefined;
    io?.to(`auction:${auctionId}`).emit('bid:placed', {
      auctionId,
      bid: {
        bidId: bid.id,
        amount: bid.amount,
        buyerId: bid.buyerId,
        buyerName: bid.buyer.name,
        timestamp: bid.createdAt.toISOString(),
      },
    });

    // Not awaited: bidding is the most latency-sensitive action in the product and this
    // send was adding ~3.3s to every bid.
    dispatchEmail(sendBidPlacedEmail(
      { email: bid.buyer.email, name: bid.buyer.name },
      { title: auctionTitle, amount: bid.amount, auctionId },
    ), 'bid placed');

    ok(res, {
      bidId: bid.id,
      auctionId: bid.auctionId,
      buyerId: bid.buyerId,
      buyerName: bid.buyer.name,
      amount: bid.amount,
      timestamp: bid.createdAt.toISOString(),
    }, 201);
  }),
);

export default router;
