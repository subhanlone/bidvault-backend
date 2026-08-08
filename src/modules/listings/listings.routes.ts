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
import {
  dispatchEmail,
  sendListingSubmittedEmail,
  sendListingApprovedEmail,
  sendListingRejectedEmail,
} from '../../services/email.service.js';
import { env } from '../../config/env.js';
import { getPlatformSettings } from '../../services/settings.service.js';
import { validateCategoryAttributes } from './category-attributes.js';

const router = Router();

const submitListingSchema = z.object({
  title: z.string().trim().min(3).max(150),
  category: z.string().trim().min(2),
  condition: z.enum(['NEW', 'LIKE_NEW', 'USED']),
  description: z.string().trim().min(10).max(5000),
  startPrice: z.coerce.number().int().positive(),
  reservePrice: z.coerce.number().int().positive().optional(),
  minIncrement: z.coerce.number().int().positive(),
  durationDays: z.coerce.number().int().positive().max(30),
  imageUrl: z.string().url().optional(),
  emoji: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
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
    durationDays: listing.durationDays,
    status: listing.status,
    rejectionReason: listing.rejectionReason ?? undefined,
    submittedAt: listing.submittedAt.toISOString(),
    emoji: listing.emoji ?? '📦',
    imageUrl: listing.imageUrl ?? undefined,
    sellerEmail: listing.seller.email,
    attributes: (listing.attributes as Record<string, unknown> | null) ?? undefined,
  };
}

function generateListingCode(): string {
  const year = new Date().getFullYear();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BV-${year}-${suffix}`;
}

async function approveOneListing(
  listing: Prisma.ListingGetPayload<{ include: { seller: true } }>,
  adminUserId: string,
  io: Server | undefined,
): Promise<{ listingId: string; auctionId?: string; warning?: string }> {
  if (listing.status !== 'PENDING') {
    throw new Error('Only pending listings can be approved.');
  }

  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + listing.durationDays * 24 * 60 * 60 * 1000);
  const auctionStatus = 'ACTIVE';

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
          attributes: (listing.attributes ?? undefined) as Prisma.InputJsonValue | undefined,
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
        endTime: result.auction.endTime,
      });
    } catch (err) {
      console.error(`[listings] Failed to schedule lifecycle for auction ${result.auction.id}:`, err);
      schedulingFailed = true;
    }
  }

  io?.emit('listing:approved', { listingId: listing.id, auctionId: result.auction?.id });
  dispatchEmail(sendListingApprovedEmail(
    { email: listing.seller?.email ?? '', name: listing.seller?.name ?? '' },
    { title: listing.title, listingCode: listing.listingCode },
  ), 'listing approved');

  await prisma.auditLog.create({
    data: {
      actorUserId: adminUserId,
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
      // Auctions are created ACTIVE with startTime = now on approval — nothing is scheduled.
      // The old "is now scheduled" wording was left over from the retired SCHEDULED path and
      // contradicted the seller-facing banner in create-listing step 2, which correctly says
      // the auction goes live the moment an admin approves. A seller reading it would
      // reasonably wait for a start that had already happened.
      message: `Your listing "${listing.title}" has been approved and your auction is now live.`,
    },
  }).catch(() => {});

  return {
    listingId: result.updatedListing.id,
    auctionId: result.auction?.id,
    ...(schedulingFailed && { warning: 'scheduling-failed' }),
  };
}

router.post(
  '/upload-signature',
  requireAuth(['SELLER']),
  asyncHandler(async (_req, res) => {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = 'bidvault/listings';
    // Normalizes every upload to JPEG. Without this, Cloudinary stores whatever format
    // the browser sent verbatim — iPhone photos default to HEIC, which Chrome/Firefox/Edge
    // cannot render in an <img> tag, so the listing's image silently never displays for
    // most visitors even though the upload itself "succeeded".
    const format = 'jpg';
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder, format },
      env.CLOUDINARY_API_SECRET,
    );
    ok(res, {
      signature,
      timestamp,
      apiKey:    env.CLOUDINARY_API_KEY,
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      folder,
      format,
    });
  }),
);

router.post(
  '/',
  requireAuth(['SELLER']),
  validateBody(submitListingSchema),
  asyncHandler(async (req, res) => {
    const settings = await getPlatformSettings();
    if (req.body.startPrice < settings.minListingPrice) {
      fail(res, `Starting price must be at least PKR ${settings.minListingPrice.toLocaleString()}.`, 400);
      return;
    }
    if (req.body.minIncrement > settings.maxBidIncrement) {
      fail(res, `Minimum bid increment cannot exceed PKR ${settings.maxBidIncrement.toLocaleString()}.`, 400);
      return;
    }

    const attributesResult = validateCategoryAttributes(req.body.category, req.body.attributes);
    if (!attributesResult.success) {
      fail(res, attributesResult.error, 400);
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
        durationDays: req.body.durationDays,
        imageUrl: req.body.imageUrl,
        emoji: req.body.emoji,
        attributes: attributesResult.data as Prisma.InputJsonValue,
        status: 'PENDING',
      },
      include: { seller: true },
    });

    dispatchEmail(sendListingSubmittedEmail(
      { email: listing.seller.email, name: listing.seller.name },
      { title: listing.title, listingCode: listing.listingCode },
    ), 'listing submitted');

    const io = req.app.get('io') as Server | undefined;
    io?.emit('listing:submitted', { listingId: listing.id, title: listing.title });

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

    const io = req.app.get('io') as Server | undefined;
    try {
      const result = await approveOneListing(listing, req.auth!.userId, io);
      ok(res, {
        listingId: result.listingId,
        status: 'APPROVED',
        auctionId: result.auctionId,
        ...(result.warning && { warning: result.warning }),
      });
    } catch (err) {
      fail(res, err instanceof Error ? err.message : 'Could not approve listing.', 400);
    }
  }),
);

router.post(
  '/approve-all',
  requireAuth(['ADMIN']),
  asyncHandler(async (req, res) => {
    const pending = await prisma.listing.findMany({
      where: { status: 'PENDING' },
      include: { seller: true },
    });

    const io = req.app.get('io') as Server | undefined;
    const failures: { listingId: string; error: string }[] = [];
    let approved = 0;

    for (const listing of pending) {
      try {
        await approveOneListing(listing, req.auth!.userId, io);
        approved++;
      } catch (err) {
        failures.push({
          listingId: listing.id,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    ok(res, { approved, failed: failures.length, failures });
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
    dispatchEmail(sendListingRejectedEmail(
      { email: listing.seller?.email ?? '', name: listing.seller?.name ?? '' },
      { title: listing.title, reason: updated.rejectionReason ?? '' },
    ), 'listing rejected');

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
