import { Router } from 'express';
import { AuctionStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Server } from 'socket.io';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { getAuctionRuntimeState, setAuctionRuntimeState } from '../../services/auction-state.service.js';
import { triggerN8nWorkflow } from '../../services/n8n.service.js';

const router = Router();

const placeBidSchema = z.object({
  amount: z.coerce.number().int().positive(),
});

function toAuctionDto(auction: Prisma.AuctionGetPayload<{ include: { seller: true } }>) {
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
    sellerVerified: auction.seller.isEmailVerified,
    sellerRating: null as number | null,
    sellerSales: null as number | null,
    startPrice: auction.startPrice,
    currentBid: auction.currentBid,
    minIncrement: auction.minIncrement,
    reservePrice: auction.reservePrice ?? undefined,
    bidCount: auction.bidCount,
    startTime: auction.startTime.toISOString(),
    endTime: auction.endTime.toISOString(),
    status: auction.status,
    imageUrl: auction.imageUrl ?? '',
    images: auction.imageUrl ? [auction.imageUrl] : [],
  };
}

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

    ok(res, auctions.map(toAuctionDto));
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

    ok(
      res,
      bids.map(bid => ({
        bidId: bid.id,
        auctionId: bid.auctionId,
        buyerId: bid.buyerId,
        buyerName: bid.buyer.name,
        amount: bid.amount,
        timestamp: bid.createdAt.toISOString(),
        auction: toAuctionDto(bid.auction),
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
    const dto = toAuctionDto(auction);
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
          await tx.notification.create({
            data: {
              userId: prevHighest.buyerId,
              type: 'BID_OUTBID',
              title: "You've been outbid",
              message: `Your bid on "${row.title}" was outbid. New leading bid: PKR ${amount.toLocaleString()}.`,
            },
          });
        }

        return { bid: createdBid, updatedAuction: nextAuction };
      });
    } catch (err) {
      if (err instanceof BidError) {
        fail(res, err.message, err.httpStatus);
        return;
      }
      throw err;
    }

    const { bid, updatedAuction } = result;

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

    await triggerN8nWorkflow('auction.bid.placed', {
      auctionId,
      bidId: bid.id,
      buyerId: bid.buyerId,
      amount: bid.amount,
      bidCount: updatedAuction.bidCount,
    });

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
