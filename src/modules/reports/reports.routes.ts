import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type ListingReport } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { sendValidationError, validateBody } from '../../middleware/validate.js';
import { decodeCursor, parseLimit, slicePage } from '../../utils/pagination.js';
import { adminReportsQuerySchema, reportListingSchema, resolveReportSchema } from '../../openapi/requests.js';

/**
 * G5: Report listing (docs/superpowers/plans/2026-11-06-guest-browsing.md, decision H).
 *
 * Anyone with an account (not an admin, and not the listed seller) can report an auction they
 * think breaks the rules, once: a repeat gives back the report they already made. Admins see the
 * reports and mark each one actioned or dismissed. Resolving never changes the auction; an admin
 * who decides the listing must go uses the existing takedown or cancel control.
 *
 * The listed seller never sees a report or who made it: nothing here, and no seller-facing route,
 * returns one.
 */

function reportDto(r: ListingReport) {
  return {
    reportId: r.id,
    auctionId: r.auctionId,
    reason: r.reason,
    note: r.note ?? undefined,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Mounted on /api/v1/auctions, beside the auctions router. */
export const reportRoutes = Router();

reportRoutes.post(
  '/:auctionId/report',
  requireAuth(['BUYER', 'SELLER']),
  validateBody(reportListingSchema),
  asyncHandler<z.infer<typeof reportListingSchema>>(async (req, res) => {
    const { auctionId } = req.params;
    const reporterId = req.auth!.userId;
    const { reason, note } = req.body;

    const auction = await prisma.auction.findUnique({ where: { id: auctionId }, select: { sellerId: true, status: true } });
    if (!auction) {
      fail(res, 'Auction not found.', 404);
      return;
    }
    if (auction.sellerId === reporterId) {
      fail(res, 'You cannot report your own listing.', 403);
      return;
    }
    // A cancelled auction is one that has been taken down or withdrawn already; there is nothing
    // left for a report to ask an admin to do.
    if (auction.status === 'CANCELLED') {
      fail(res, 'This listing has already been removed.', 409);
      return;
    }

    const existing = await prisma.listingReport.findUnique({ where: { auctionId_reporterId: { auctionId, reporterId } } });
    // One answer for both cases (the client generator wants a single 2xx); `alreadyReported` is
    // what tells the dialog to say "you already reported this listing" instead of thanking them.
    if (existing) {
      ok(res, { report: reportDto(existing), alreadyReported: true });
      return;
    }

    try {
      const created = await prisma.listingReport.create({
        data: { auctionId, reporterId, reason, note: note || null },
      });
      ok(res, { report: reportDto(created), alreadyReported: false });
    } catch (err) {
      // The same person reporting twice at once: the unique index lets one row in, and the other
      // request answers with that row, exactly as a later repeat would.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await prisma.listingReport.findUniqueOrThrow({
          where: { auctionId_reporterId: { auctionId, reporterId } },
        });
        ok(res, { report: reportDto(winner), alreadyReported: true });
        return;
      }
      throw err;
    }
  }),
);

/** Mounted on /api/v1/admin/reports. */
export const adminReportRoutes = Router();

adminReportRoutes.get(
  '/',
  requireAuth(['ADMIN']),
  asyncHandler(async (req, res) => {
    const parsed = adminReportsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, z.flattenError(parsed.error).fieldErrors);
      return;
    }
    const status = parsed.data.status ?? 'OPEN';
    const limit = parseLimit(parsed.data.limit);
    const cursor = decodeCursor(parsed.data.cursor);

    // Oldest first: a moderation queue is worked from the report that has waited longest.
    const where: Prisma.ListingReportWhereInput = cursor
      ? {
          status,
          OR: [
            { createdAt: { gt: new Date(cursor.sortValue) } },
            { createdAt: new Date(cursor.sortValue), id: { gt: cursor.id } },
          ],
        }
      : { status };

    const rows = await prisma.listingReport.findMany({
      where,
      include: {
        reporter: { select: { name: true } },
        auction: {
          select: {
            id: true,
            title: true,
            status: true,
            listing: { select: { listingCode: true } },
            seller: { select: { name: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const { pageRows, nextCursor } = slicePage(rows, limit, (r) => r.createdAt, (r) => r.id);
    ok(res, {
      items: pageRows.map((r) => ({
        reportId: r.id,
        auction: {
          auctionId: r.auction.id,
          title: r.auction.title,
          listingCode: r.auction.listing.listingCode,
          status: r.auction.status,
          sellerName: r.auction.seller.name,
        },
        reason: r.reason,
        note: r.note ?? undefined,
        reporterName: r.reporter.name,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString(),
      })),
      nextCursor,
    });
  }),
);

adminReportRoutes.patch(
  '/:reportId',
  requireAuth(['ADMIN']),
  validateBody(resolveReportSchema),
  asyncHandler<z.infer<typeof resolveReportSchema>>(async (req, res) => {
    const { reportId } = req.params;
    const { status } = req.body;
    const adminUserId = req.auth!.userId;

    const outcome = await prisma.$transaction(async (tx) => {
      // Only an OPEN report changes, so two admins (or a double click) resolving at once write one
      // decision and one audit row; the loser reads what the winner wrote.
      const changed = await tx.listingReport.updateMany({
        where: { id: reportId, status: 'OPEN' },
        data: { status, resolvedAt: new Date(), resolvedById: adminUserId },
      });
      const report = await tx.listingReport.findUnique({ where: { id: reportId } });
      if (!report) return { kind: 'not-found' as const };
      if (changed.count === 1) {
        await tx.auditLog.create({
          data: {
            actorUserId: adminUserId,
            action: 'LISTING_REPORT_RESOLVED',
            entityType: 'ListingReport',
            entityId: reportId,
            metadata: { status, auctionId: report.auctionId },
          },
        });
      }
      return { kind: 'ok' as const, report };
    });

    if (outcome.kind === 'not-found') {
      fail(res, 'Report not found.', 404);
      return;
    }
    if (outcome.report.status !== status) {
      fail(res, `This report was already marked ${outcome.report.status.toLowerCase()}.`, 409);
      return;
    }
    ok(res, { report: reportDto(outcome.report) });
  }),
);
