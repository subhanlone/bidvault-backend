import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { createReviewSchema } from '../../openapi/requests.js';

const router = Router();

router.post(
  '/',
  requireAuth(['BUYER']),
  validateBody(createReviewSchema),
  asyncHandler(async (req, res) => {
    const { transactionId, stars, comment } = req.body;
    const buyerId = req.auth!.userId;

    const tx = await prisma.auctionTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!tx) {
      fail(res, 'Transaction not found.', 404);
      return;
    }
    if (tx.winnerId !== buyerId) {
      fail(res, 'Forbidden.', 403);
      return;
    }
    // BV-047: gated on DELIVERED, not COMPLETED (paid) — a review is about the item and the
    // seller's handling of the sale, neither of which the buyer can honestly rate before they
    // have actually received it. COMPLETED only means the card charged (A4).
    if (tx.status !== 'DELIVERED') {
      fail(res, 'Confirm receipt of the item before rating the seller.', 422);
      return;
    }

    const existing = await prisma.sellerReview.findUnique({
      where: { transactionId },
    });
    if (existing) {
      fail(res, "You've already reviewed this seller for this purchase.", 409);
      return;
    }

    // BV-043: the pre-check above gives the good message on the common path, but a concurrent
    // duplicate submit (a double-click on a slow connection) can still win the race between
    // that read and this write -- this is the authoritative fallback for it.
    let review;
    try {
      review = await prisma.sellerReview.create({
        data: {
          transactionId,
          auctionId: tx.auctionId,
          buyerId,
          sellerId: tx.sellerId,
          stars,
          comment: comment ?? null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        fail(res, "You've already reviewed this seller for this purchase.", 409);
        return;
      }
      throw err;
    }

    const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { name: true } });

    await prisma.notification.create({
      data: {
        userId: tx.sellerId,
        type: 'NEW_REVIEW',
        title: 'New review received',
        message: `${buyer?.name ?? 'A buyer'} left you a ${stars}-star review.`,
      },
    });

    ok(res, {
      reviewId: review.id,
      stars: review.stars,
      comment: review.comment,
      createdAt: review.createdAt.toISOString(),
    }, 201);
  }),
);

router.get(
  '/seller/:sellerId',
  asyncHandler(async (req, res) => {
    const sellerId = req.params.sellerId;

    const [agg, reviews] = await Promise.all([
      prisma.sellerReview.aggregate({
        where: { sellerId },
        _avg: { stars: true },
        _count: { stars: true },
      }),
      prisma.sellerReview.findMany({
        where: { sellerId },
        include: { buyer: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    ok(res, {
      sellerId,
      average: agg._avg.stars !== null ? Math.round(agg._avg.stars * 10) / 10 : null,
      count: agg._count.stars,
      reviews: reviews.map(r => ({
        reviewId: r.id,
        stars: r.stars,
        comment: r.comment,
        buyerName: r.buyer.name,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  }),
);

export default router;
