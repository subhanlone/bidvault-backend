import crypto from 'node:crypto';
import { Router } from 'express';
import { ItemCondition, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { v2 as cloudinary } from 'cloudinary';
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
import type { ListingDtoType } from '../../openapi/schemas.js';
import { submitListingSchema, rejectListingSchema } from '../../openapi/requests.js';
import { uploadSignatureRateLimit } from '../../middleware/rate-limit.js';
import { decodeCursor, parseLimit, slicePage } from '../../utils/pagination.js';

const router = Router();
const ALLOWED_UPLOAD_FORMATS = 'jpg,png,webp';

class ListingStateError extends Error {}

// See toAuctionDto — the return type is the published contract, so drift is a build error.
function toListingDto(
  listing: Prisma.ListingGetPayload<{ include: { seller: true } }>,
): ListingDtoType {
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
    attributes: (listing.attributes as Record<string, string | number> | null) ?? undefined,
  };
}

function generateListingCode(): string {
  const year = new Date().getFullYear();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BV-${year}-${suffix}`;
}

function isOwnedCloudinaryImage(imageUrl: string, sellerId: string): boolean {
  const url = new URL(imageUrl);
  const expectedAccountPath = `/${env.CLOUDINARY_CLOUD_NAME}/image/upload/`;
  const expectedAssetPrefix = `/bidvault/listings/listing-${sellerId}-`;
  return (
    url.protocol === 'https:' &&
    url.hostname === 'res.cloudinary.com' &&
    url.pathname.startsWith(expectedAccountPath) &&
    url.pathname.includes(expectedAssetPrefix)
  );
}

async function approveOneListing(
  listing: Prisma.ListingGetPayload<{ include: { seller: true } }>,
  adminUserId: string,
  io: Server | undefined,
): Promise<{ listingId: string; auctionId?: string; warning?: string }> {
  if (listing.status !== 'PENDING') {
    throw new ListingStateError('Only pending listings can be approved.');
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
          attributes: listing.attributes ?? undefined,
          startTime,
          endTime,
          status: auctionStatus,
        },
      });
    }

    // Same transaction as the state change it records, not a best-effort write after it
    // (BV-050): an audit log created afterward can be lost to a crash between the commit and
    // this call, leaving an approval with no trail of who made it. schedulingFailed isn't
    // known yet at this point -- scheduling calls an external queue and cannot itself run
    // inside a DB transaction -- so it stays out of this record; a failure there gets its own
    // console.error below, not a silent gap in this one.
    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'LISTING_APPROVED',
        entityType: 'Listing',
        entityId: listing.id,
        metadata: { auctionId: auction.id },
      },
    });

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
    // Best-effort and logged rather than silent (BV-050): a lost in-app notification is
    // recoverable (the seller still gets the email above, and sees the listing live either
    // way) but a swallowed failure here previously left no trace it happened at all.
  }).catch((err: unknown) => console.error('[listings] approval notification failed', { listingId: listing.id, err }));

  return {
    listingId: result.updatedListing.id,
    auctionId: result.auction?.id,
    ...(schedulingFailed && { warning: 'scheduling-failed' }),
  };
}

router.post(
  '/upload-signature',
  requireAuth(['SELLER']),
  uploadSignatureRateLimit,
  asyncHandler(async (req, res) => {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = 'bidvault/listings';
    const publicId = `listing-${req.auth!.userId}-${crypto.randomUUID()}`;
    // Normalizes every upload to JPEG. Without this, Cloudinary stores whatever format
    // the browser sent verbatim — iPhone photos default to HEIC, which Chrome/Firefox/Edge
    // cannot render in an <img> tag, so the listing's image silently never displays for
    // most visitors even though the upload itself "succeeded".
    const format = 'jpg';
    // Only parameters Cloudinary itself recognises may be signed.
    //
    // Cloudinary rebuilds the signature from the parameters it understands and ignores the
    // rest, so signing one it does not know breaks every upload: it computes over a shorter
    // string than we did and answers 401 Invalid Signature. `max_file_size` was signed here
    // and is not an Upload API parameter — verified against the live API, which returned
    // `String to sign - 'allowed_formats=...&folder=...&format=jpg&public_id=...&timestamp=...'`
    // with max_file_size absent. `allowed_formats` is real and is enforced: the same probe
    // uploading a GIF was refused with 400 "Image file format gif not allowed".
    //
    // The Upload API has no per-request size cap, so size is not server-enforceable here. What
    // does constrain abuse: the format allow-list above, a server-issued public_id that pins
    // the asset to this seller (checked again on submit by isOwnedCloudinaryImage), and the
    // per-user rate limit on this route. The client's own 5 MB check is a courtesy to the
    // user, not a control — anyone holding the signature can skip it.
    const signedParams = {
      timestamp,
      folder,
      public_id: publicId,
      format,
      allowed_formats: ALLOWED_UPLOAD_FORMATS,
    };
    const signature = cloudinary.utils.api_sign_request(
      signedParams,
      env.CLOUDINARY_API_SECRET,
    );
    ok(res, {
      signature,
      timestamp,
      apiKey:    env.CLOUDINARY_API_KEY,
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      folder,
      format,
      publicId,
      allowedFormats: ALLOWED_UPLOAD_FORMATS,
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
      fail(res, `Starting price must be at least PKR ${settings.minListingPrice.toLocaleString()}.`, 422);
      return;
    }
    if (req.body.imageUrl && !isOwnedCloudinaryImage(req.body.imageUrl, req.auth!.userId)) {
      fail(res, 'Image must be an upload issued for this seller by BidVault.', 422);
      return;
    }
    if (req.body.minIncrement > settings.maxBidIncrement) {
      fail(res, `Minimum bid increment cannot exceed PKR ${settings.maxBidIncrement.toLocaleString()}.`, 422);
      return;
    }

    const attributesResult = validateCategoryAttributes(req.body.category, req.body.attributes);
    if (!attributesResult.success) {
      fail(res, attributesResult.error, 422);
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
    const sellerId = req.auth!.userId;
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const where: Prisma.ListingWhereInput = cursor
      ? {
          sellerId,
          OR: [
            { submittedAt: { lt: new Date(cursor.sortValue) } },
            { submittedAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
          ],
        }
      : { sellerId };

    const rows = await prisma.listing.findMany({
      where,
      include: { seller: true },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const { pageRows, nextCursor } = slicePage(rows, limit, (l) => l.submittedAt, (l) => l.id);
    ok(res, { items: pageRows.map(toListingDto), nextCursor });
  }),
);

router.get(
  '/pending',
  requireAuth(['ADMIN']),
  asyncHandler(async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const where: Prisma.ListingWhereInput = cursor
      ? {
          status: 'PENDING',
          OR: [
            { submittedAt: { gt: new Date(cursor.sortValue) } },
            { submittedAt: new Date(cursor.sortValue), id: { gt: cursor.id } },
          ],
        }
      : { status: 'PENDING' };

    const rows = await prisma.listing.findMany({
      where,
      include: { seller: true },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const { pageRows, nextCursor } = slicePage(rows, limit, (l) => l.submittedAt, (l) => l.id);
    ok(res, { items: pageRows.map(toListingDto), nextCursor });
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
      if (err instanceof ListingStateError) {
        fail(res, err.message, 400);
        return;
      }
      throw err;
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
        if (err instanceof ListingStateError) {
          failures.push({ listingId: listing.id, error: err.message });
          continue;
        }
        throw err;
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
      fail(res, 'Only pending listings can be rejected.', 409);
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
    }).catch((err: unknown) => console.error('[listings] rejection audit log failed', { listingId: listing.id, err }));

    await prisma.notification.create({
      data: {
        userId: listing.sellerId,
        type: 'LISTING_REJECTED',
        title: 'Listing rejected',
        message: `Your listing "${listing.title}" was not approved. Reason: ${req.body.reason}`,
      },
    }).catch((err: unknown) => console.error('[listings] rejection notification failed', { listingId: listing.id, err }));

    ok(res, {
      listingId: updated.id,
      status: updated.status,
      rejectionReason: updated.rejectionReason,
    });
  }),
);

export default router;
