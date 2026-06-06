import crypto from 'node:crypto';
import { Router } from 'express';
import { ItemCondition, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { scheduleAuctionLifecycle } from '../../queues/auction-lifecycle.queue.js';
import { triggerN8nWorkflow } from '../../services/n8n.service.js';
import { env } from '../../config/env.js';

const router = Router();

const submitListingSchema = z.object({
  title: z.string().trim().min(3),
  category: z.string().trim().min(2),
  condition: z.enum(['NEW', 'LIKE_NEW', 'USED']),
  description: z.string().trim().min(10),
  startPrice: z.coerce.number().int().positive(),
  reservePrice: z.coerce.number().int().positive().optional(),
  minIncrement: z.coerce.number().int().positive(),
  startAt: z.coerce.date(),
  durationDays: z.coerce.number().int().positive().max(30),
  imageUrl: z.string().url().optional(),
  emoji: z.string().optional(),
});

const rejectListingSchema = z.object({
  reason: z.string().trim().min(3),
});

function toListingDto(
  listing: Prisma.ListingGetPayload<{ include: { seller: true } }>,
) {
  return {
    listingId: listing.id,
    listingCode: listing.listingCode,
    sellerId: listing.sellerId,
    sellerName: listing.seller.name,
    title: listing.title,
    category: listing.category,
    condition: listing.condition,
    description: listing.description,
    startPrice: listing.startPrice,
    reservePrice: listing.reservePrice ?? undefined,
    minIncrement: listing.minIncrement,
    startAt: listing.startAt.toISOString(),
    durationDays: listing.durationDays,
    status: listing.status,
    rejectionReason: listing.rejectionReason ?? undefined,
    submittedAt: listing.submittedAt.toISOString(),
    emoji: listing.emoji ?? '📦',
    imageUrl: listing.imageUrl ?? undefined,
    sellerEmail: listing.seller.email,
  };
}

function generateListingCode(): string {
  const year = new Date().getFullYear();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BV-${year}-${suffix}`;
}

router.post(
  '/upload-signature',
  requireAuth(['SELLER']),
  asyncHandler(async (_req, res) => {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = 'bidvault/listings';
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder },
      env.CLOUDINARY_API_SECRET,
    );
    ok(res, {
      signature,
      timestamp,
      apiKey:    env.CLOUDINARY_API_KEY,
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      folder,
    });
  }),
);

router.post(
  '/',
  requireAuth(['SELLER']),
  validateBody(submitListingSchema),
  asyncHandler(async (req, res) => {
    if (req.body.startAt <= new Date()) {
      fail(res, 'Auction start time must be in the future.', 400);
      return;
    }

    const listingCode = generateListingCode();

    const listing = await prisma.listing.create({
      data: {
        listingCode,
        sellerId: req.auth!.userId,
        title: req.body.title,
        category: req.body.category,
        condition: req.body.condition as ItemCondition,
        description: req.body.description,
        startPrice: req.body.startPrice,
        reservePrice: req.body.reservePrice,
        minIncrement: req.body.minIncrement,
        startAt: req.body.startAt,
        durationDays: req.body.durationDays,
        imageUrl: req.body.imageUrl,
        emoji: req.body.emoji,
        status: 'PENDING',
      },
      include: { seller: true },
    });

    await triggerN8nWorkflow('listing.submitted', {
      listingId: listing.id,
      listingCode: listing.listingCode,
      sellerId: listing.sellerId,
      sellerName: listing.seller.name,
      sellerEmail: listing.seller.email,
      title: listing.title,
      category: listing.category,
      startPrice: listing.startPrice,
    });

    ok(res, toListingDto(listing), 201);
  }),
);

router.get(
  '/mine',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    const listings = await prisma.listing.findMany({
      where: { sellerId: req.auth!.userId },
      include: { seller: true },
      orderBy: { submittedAt: 'desc' },
    });
    ok(res, listings.map(toListingDto));
  }),
);

router.get(
  '/pending',
  requireAuth(['ADMIN']),
  asyncHandler(async (_req, res) => {
    const listings = await prisma.listing.findMany({
      where: { status: 'PENDING' },
      include: { seller: true },
      orderBy: { submittedAt: 'asc' },
    });
    ok(res, listings.map(toListingDto));
  }),
);

router.post(
  '/:listingId/approve',
  requireAuth(['ADMIN']),
  asyncHandler(async (req, res) => {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.listingId },
      include: { seller: true },
    });

    if (!listing) {
      fail(res, 'Listing not found.', 404);
      return;
    }

    if (listing.status !== 'PENDING') {
      fail(res, 'Only pending listings can be approved.', 400);
      return;
    }

    const now = new Date();
    const startTime = listing.startAt;
    const endTime = new Date(startTime.getTime() + listing.durationDays * 24 * 60 * 60 * 1000);
    const auctionStatus = endTime <= now ? 'CLOSED' : startTime <= now ? 'ACTIVE' : 'SCHEDULED';

    const result = await prisma.$transaction(async (tx) => {
      const updatedListing = await tx.listing.update({
        where: { id: listing.id },
        data: { status: 'APPROVED', rejectionReason: null },
      });

      const existingAuction = await tx.auction.findUnique({
        where: { listingId: listing.id },
      });

      let auction = existingAuction;
      if (!auction) {
        auction = await tx.auction.create({
          data: {
            listingId: listing.id,
            sellerId: listing.sellerId,
            title: listing.title,
            category: listing.category,
            condition: listing.condition,
            description: listing.description,
            imageUrl: listing.imageUrl,
            emoji: listing.emoji,
            startPrice: listing.startPrice,
            reservePrice: listing.reservePrice,
            minIncrement: listing.minIncrement,
            currentBid: listing.startPrice,
            startTime,
            endTime,
            status: auctionStatus,
          },
        });
      }

      return { updatedListing, auction, isNewAuction: !existingAuction };
    });

    let schedulingFailed = false;
    if (result.auction && result.auction.status !== 'CLOSED' && result.isNewAuction) {
      try {
        await scheduleAuctionLifecycle({
          auctionId: result.auction.id,
          startTime: result.auction.startTime,
          endTime: result.auction.endTime,
        });
      } catch (err) {
        console.error(`[listings] Failed to schedule lifecycle for auction ${result.auction.id}:`, err);
        schedulingFailed = true;
      }
    }

    const io = req.app.get('io') as Server | undefined;
    io?.emit('listing:approved', { listingId: listing.id, auctionId: result.auction?.id });
    await triggerN8nWorkflow('listing.approved', {
      listingId: listing.id,
      listingCode: listing.listingCode,
      auctionId: result.auction?.id,
      approvedAt: new Date().toISOString(),
      sellerName: listing.seller?.name ?? '',
      sellerEmail: listing.seller?.email ?? '',
      title: listing.title,
    });

    await prisma.auditLog.create({
      data: {
        actorUserId: req.auth!.userId,
        action: 'LISTING_APPROVED',
        entityType: 'Listing',
        entityId: listing.id,
        metadata: { auctionId: result.auction?.id, schedulingFailed },
      },
    }).catch(() => {});

    await prisma.notification.create({
      data: {
        userId: listing.sellerId,
        type: 'LISTING_APPROVED',
        title: 'Listing approved',
        message: `Your listing "${listing.title}" has been approved and your auction is now scheduled.`,
      },
    }).catch(() => {});

    ok(res, {
      listingId: result.updatedListing.id,
      status: result.updatedListing.status,
      auctionId: result.auction?.id,
      ...(schedulingFailed && { warning: 'scheduling-failed' }),
    });
  }),
);

router.post(
  '/:listingId/reject',
  requireAuth(['ADMIN']),
  validateBody(rejectListingSchema),
  asyncHandler(async (req, res) => {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.listingId },
      include: { seller: true },
    });

    if (!listing) {
      fail(res, 'Listing not found.', 404);
      return;
    }

    if (listing.status !== 'PENDING') {
      fail(res, 'Only pending listings can be rejected.', 400);
      return;
    }

    const updated = await prisma.listing.update({
      where: { id: listing.id },
      data: {
        status: 'REJECTED',
        rejectionReason: req.body.reason,
      },
    });

    const io = req.app.get('io') as Server | undefined;
    io?.emit('listing:rejected', { listingId: listing.id });
    await triggerN8nWorkflow('listing.rejected', {
      listingId: listing.id,
      listingCode: listing.listingCode,
      rejectedAt: new Date().toISOString(),
      reason: updated.rejectionReason ?? '',
      sellerName: listing.seller?.name ?? '',
      sellerEmail: listing.seller?.email ?? '',
      title: listing.title,
    });

    await prisma.auditLog.create({
      data: {
        actorUserId: req.auth!.userId,
        action: 'LISTING_REJECTED',
        entityType: 'Listing',
        entityId: listing.id,
        metadata: { reason: req.body.reason },
      },
    }).catch(() => {});

    await prisma.notification.create({
      data: {
        userId: listing.sellerId,
        type: 'LISTING_REJECTED',
        title: 'Listing rejected',
        message: `Your listing "${listing.title}" was not approved. Reason: ${req.body.reason}`,
      },
    }).catch(() => {});

    ok(res, {
      listingId: updated.id,
      status: updated.status,
      rejectionReason: updated.rejectionReason,
    });
  }),
);

export default router;
