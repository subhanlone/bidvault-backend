import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();

router.get(
  '/',
  requireAuth(['BUYER', 'ADMIN']),
  asyncHandler(async (req, res) => {
    const entries = await prisma.watchlist.findMany({
      where: { userId: req.auth!.userId },
      include: { auction: true },
      orderBy: { createdAt: 'desc' },
    });

    ok(
      res,
      entries.map((entry) => ({
        auctionId: entry.auctionId,
        title: entry.auction.title,
        currentBid: entry.auction.currentBid,
        status: entry.auction.status,
        endTime: entry.auction.endTime.toISOString(),
      })),
    );
  }),
);

router.post(
  '/:auctionId',
  requireAuth(['BUYER', 'ADMIN']),
  asyncHandler(async (req, res) => {
    const auction = await prisma.auction.findUnique({ where: { id: req.params.auctionId } });
    if (!auction) {
      fail(res, 'Auction not found.', 404);
      return;
    }

    await prisma.watchlist.upsert({
      where: {
        userId_auctionId: {
          userId: req.auth!.userId,
          auctionId: req.params.auctionId,
        },
      },
      update: {},
      create: {
        userId: req.auth!.userId,
        auctionId: req.params.auctionId,
      },
    });

    ok(res, { auctionId: req.params.auctionId, watched: true }, 201);
  }),
);

router.delete(
  '/:auctionId',
  requireAuth(['BUYER', 'ADMIN']),
  asyncHandler(async (req, res) => {
    await prisma.watchlist.deleteMany({
      where: {
        userId: req.auth!.userId,
        auctionId: req.params.auctionId,
      },
    });
    ok(res, { auctionId: req.params.auctionId, watched: false });
  }),
);

export default router;
