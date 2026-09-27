import { Router } from 'express';
import type { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { createReviewSchema, updateReviewSchema, replyToReviewSchema } from '../../openapi/requests.js';
import { getPlatformSettings } from '../../services/settings.service.js';

const router = Router();

router.post(
  '/',
  requireAuth(['BUYER']),
  validateBody(createReviewSchema),
  asyncHandler<z.infer<typeof createReviewSchema>>(async (req, res) => {
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

// C6, Phase 7: a review was previously permanent -- no correction path for a buyer who mis-typed
// a rating or wants to soften a comment after the seller resolved something out of band.
router.patch(
  '/:reviewId',
  requireAuth(['BUYER']),
  validateBody(updateReviewSchema),
  asyncHandler<z.infer<typeof updateReviewSchema>>(async (req, res) => {
    const review = await prisma.sellerReview.findUnique({ where: { id: req.params.reviewId } });
    if (!review) { fail(res, 'Review not found.', 404); return; }
    if (review.buyerId !== req.auth!.userId) { fail(res, 'Forbidden.', 403); return; }

    const { reviewEditWindowHours } = await getPlatformSettings();
    const deadline = new Date(review.createdAt.getTime() + reviewEditWindowHours * 60 * 60 * 1000);
    if (Date.now() > deadline.getTime()) {
      fail(res, `Reviews can only be edited within ${reviewEditWindowHours} hours of posting.`, 409);
      return;
    }

    const updated = await prisma.sellerReview.update({
      where: { id: review.id },
      data: {
        stars: req.body.stars ?? review.stars,
        comment: req.body.comment !== undefined ? req.body.comment : review.comment,
        updatedAt: new Date(),
      },
    });

    ok(res, {
      reviewId: updated.id,
      stars: updated.stars,
      comment: updated.comment,
      createdAt: updated.createdAt.toISOString(),
    });
  }),
);

router.delete(
  '/:reviewId',
  requireAuth(['BUYER']),
  asyncHandler(async (req, res) => {
    const review = await prisma.sellerReview.findUnique({ where: { id: req.params.reviewId } });
    if (!review) { fail(res, 'Review not found.', 404); return; }
    if (review.buyerId !== req.auth!.userId) { fail(res, 'Forbidden.', 403); return; }

    const { reviewEditWindowHours } = await getPlatformSettings();
    const deadline = new Date(review.createdAt.getTime() + reviewEditWindowHours * 60 * 60 * 1000);
    if (Date.now() > deadline.getTime()) {
      fail(res, `Reviews can only be deleted within ${reviewEditWindowHours} hours of posting.`, 409);
      return;
    }

    await prisma.sellerReview.delete({ where: { id: review.id } });
    ok(res, { reviewId: review.id, status: 'DELETED' });
  }),
);

// The reviewed seller's one-shot right of reply -- no edit once posted, matching the review
// itself's one-shot-per-transaction shape. No time window: a seller may want to respond to an
// old review whenever they notice it.
router.post(
  '/:reviewId/reply',
  requireAuth(['SELLER']),
  validateBody(replyToReviewSchema),
  asyncHandler<z.infer<typeof replyToReviewSchema>>(async (req, res) => {
    const review = await prisma.sellerReview.findUnique({ where: { id: req.params.reviewId } });
    if (!review) { fail(res, 'Review not found.', 404); return; }
    if (review.sellerId !== req.auth!.userId) { fail(res, 'Forbidden.', 403); return; }
    if (review.sellerReply !== null) { fail(res, "You've already replied to this review.", 409); return; }

    const updated = await prisma.sellerReview.update({
      where: { id: review.id },
      data: { sellerReply: req.body.reply, sellerReplyAt: new Date() },
    });

    await prisma.notification.create({
      data: {
        userId: review.buyerId,
        type: 'REVIEW_REPLY',
        title: 'The seller replied to your review',
        message: `"${req.body.reply}"`,
      },
    }).catch((err: unknown) => console.error('[reviews] reply notification failed', { reviewId: review.id, err }));

    ok(res, { reviewId: updated.id, sellerReply: updated.sellerReply, sellerReplyAt: updated.sellerReplyAt?.toISOString() });
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
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    // BV-039: this route is unauthenticated, same problem as the public bid feed -- mask to a
    // stable per-seller pseudonym rather than the reviewer's real name. Not paginated (a fixed
    // top-50), so a rank computed from just this page stays stable for as long as this same
    // window is being shown.
    const rank = new Map<string, number>();
    for (const r of [...reviews].reverse()) {
      if (!rank.has(r.buyerId)) rank.set(r.buyerId, rank.size + 1);
    }

    ok(res, {
      sellerId,
      average: agg._avg.stars !== null ? Math.round(agg._avg.stars * 10) / 10 : null,
      count: agg._count.stars,
      reviews: reviews.map(r => ({
        reviewId: r.id,
        stars: r.stars,
        comment: r.comment,
        buyerName: `Reviewer ${rank.get(r.buyerId)}`,
        createdAt: r.createdAt.toISOString(),
        // C6, Phase 7.
        updatedAt: r.updatedAt?.toISOString(),
        sellerReply: r.sellerReply ?? undefined,
        sellerReplyAt: r.sellerReplyAt?.toISOString(),
      })),
    });
  }),
);

export default router;
