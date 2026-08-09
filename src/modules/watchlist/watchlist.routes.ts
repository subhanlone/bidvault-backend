import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { buildSellerStatsMap, toAuctionDto } from '../auctions/auction-dto.js';

const router = Router();

router.get(
  '/',
  requireAuth(['BUYER', 'ADMIN']),
  asyncHandler(async (req, res) => {
    // Serves the full AuctionDto, same as GET /auctions. This used to return a five-field
    // subset (id/title/currentBid/status/endTime), which the watchlist screen could not
    // render from — so it re-looked each id up in the client's auction list instead. That
    // list only ever holds ACTIVE auctions, so a watched auction vanished from the page the
    // moment it closed while still counting on the profile (NEW-12).
    const entries = await prisma.watchlist.findMany({
      where: { userId: req.auth!.userId },
      include: { auction: { include: { seller: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const statsMap = await buildSellerStatsMap(entries.map((e) => e.auction.sellerId));
    ok(
      res,
      entries.map((entry) => toAuctionDto(entry.auction, statsMap)),
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
