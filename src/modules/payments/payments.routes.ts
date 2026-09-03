import { Router } from 'express';
import type { Prisma, TransactionStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { fail, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { payTransactionSchema, raiseDisputeSchema } from '../../openapi/requests.js';
import { dispatchEmail, sendPaymentCompletedEmail } from '../../services/email.service.js';
import { chargeCard } from '../../services/payment-gateway.service.js';
import { getPlatformSettings } from '../../services/settings.service.js';
import { decodeCursor, parseLimit, slicePage } from '../../utils/pagination.js';
import {
  markShipped,
  confirmDelivery,
  raiseDispute,
  REVENUE_STATUSES,
} from '../../services/fulfillment.service.js';

const router = Router();

// A sale is "paid for" from pay's point of view in every one of these states — the charge
// succeeded at COMPLETED and nothing after that ever un-succeeds it except a dispute resolving
// to REFUNDED, which is its own terminal state, not a reason to accept a second payment.
const PAID_STATUSES: TransactionStatus[] = ['COMPLETED', 'SHIPPED', 'DELIVERED', 'DISPUTED', 'REFUNDED'];

router.get(
  '/my-wins',
  requireAuth(['BUYER']),
  asyncHandler(async (req, res) => {
    const winnerId = req.auth!.userId;

    const transactions = await prisma.auctionTransaction.findMany({
      where: { winnerId },
      include: {
        auction: true,
        seller: { select: { name: true, email: true } },
        review: { select: { id: true } },
        dispute: { select: { reason: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const { reviewTimeoutHours } = await getPlatformSettings();

    ok(res, transactions.map((tx) => ({
      transactionId: tx.id,
      auctionId: tx.auctionId,
      auctionTitle: tx.auction.title,
      auctionEmoji: tx.auction.emoji ?? '📦',
      auctionImageUrl: tx.auction.imageUrl ?? '',
      sellerName: tx.seller.name,
      finalAmount: tx.finalAmount,
      status: tx.status,
      // Why the last attempt failed, if one did. Published rather than left in the database:
      // a buyer whose card was declined needs to know it was declined and can be retried,
      // which is the whole point of not writing FAILED into `status` any more.
      lastPaymentError: tx.lastPaymentError ?? undefined,
      // BV-047: when the item shipped, and the deadline (computed server-side so the frontend
      // never needs reviewTimeoutHours separately) to either confirm receipt or dispute before
      // it is assumed received automatically.
      shippedAt: tx.shippedAt?.toISOString(),
      reviewDeadlineAt: tx.shippedAt
        ? new Date(tx.shippedAt.getTime() + reviewTimeoutHours * 60 * 60 * 1000).toISOString()
        : undefined,
      disputeReason: tx.dispute?.reason,
      createdAt: tx.createdAt.toISOString(),
      reviewed: tx.review !== null,
    })));
  }),
);

router.get(
  '/seller-stats',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    // BV-029's evidence table listed this alongside the six list endpoints, but it doesn't
    // return a list -- {totalRevenue, itemsSold} is an aggregate, so cursor pagination
    // doesn't apply to it. Its actual defect (BV-008's shape: every completed row fetched
    // to sum in JS) gets BV-008's fix instead -- the aggregate in Postgres.
    const { _sum, _count } = await prisma.auctionTransaction.aggregate({
      where: { sellerId: req.auth!.userId, status: { in: REVENUE_STATUSES } },
      _sum: { finalAmount: true },
      _count: { id: true },
    });
    ok(res, {
      totalRevenue: _sum.finalAmount ?? 0,
      itemsSold: _count.id,
    });
  }),
);

// The dummy gateway's payout side (C5) — no external account, so this is the whole "where did
// my money go" answer: the running balance plus the individual sale that built each entry.
router.get(
  '/earnings',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    const sellerId = req.auth!.userId;

    const [seller, entries] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: sellerId }, select: { ledgerBalance: true } }),
      prisma.ledgerEntry.findMany({
        where: { sellerId },
        include: { transaction: { select: { auction: { select: { title: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    ok(res, {
      ledgerBalance: seller.ledgerBalance,
      entries: entries.map((e) => ({
        transactionId: e.transactionId,
        auctionTitle: e.transaction.auction.title,
        amount: e.amount,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  }),
);

// BV-047 / B2: sellers previously had no way to see their own sales at all -- not even that
// one existed, let alone which need shipping or carry the buyer's delivery address. Cursor
// paginated the same way BV-029 did the other six list endpoints, for the same reason: a
// prolific seller's history is unbounded.
router.get(
  '/my-sales',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    const sellerId = req.auth!.userId;
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const where: Prisma.AuctionTransactionWhereInput = cursor
      ? {
          sellerId,
          OR: [
            { createdAt: { lt: new Date(cursor.sortValue) } },
            { createdAt: new Date(cursor.sortValue), id: { lt: cursor.id } },
          ],
        }
      : { sellerId };

    const rows = await prisma.auctionTransaction.findMany({
      where,
      include: {
        auction: { select: { title: true, emoji: true, imageUrl: true } },
        winner: { select: { name: true } },
        dispute: { select: { reason: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const { reviewTimeoutHours } = await getPlatformSettings();
    const { pageRows, nextCursor } = slicePage(rows, limit, (t) => t.createdAt, (t) => t.id);

    ok(res, {
      items: pageRows.map((t) => ({
        transactionId: t.id,
        auctionId: t.auctionId,
        auctionTitle: t.auction.title,
        auctionEmoji: t.auction.emoji ?? '📦',
        auctionImageUrl: t.auction.imageUrl ?? '',
        buyerName: t.winner.name,
        finalAmount: t.finalAmount,
        status: t.status,
        deliveryAddress: t.deliveryAddress ?? undefined,
        deliveryPhone: t.deliveryPhone ?? undefined,
        shippedAt: t.shippedAt?.toISOString(),
        reviewDeadlineAt: t.shippedAt
          ? new Date(t.shippedAt.getTime() + reviewTimeoutHours * 60 * 60 * 1000).toISOString()
          : undefined,
        disputeReason: t.dispute?.reason,
        createdAt: t.createdAt.toISOString(),
      })),
      nextCursor,
    });
  }),
);

// The dummy gateway resolves synchronously in the same request — no client secret, no
// webhook, no separate confirm step. Those existed only because a real processor's own UI had
// to run in the buyer's browser first; this app decides the outcome itself.
router.post(
  '/:transactionId/pay',
  requireAuth(['BUYER']),
  validateBody(payTransactionSchema),
  asyncHandler(async (req, res) => {
    const winnerId = req.auth!.userId;
    const { transactionId } = req.params;
    const { cardNumber, deliveryAddress, deliveryPhone } = req.body;

    // The whole read-decide-write runs under a row lock — a double-clicked Pay button is
    // otherwise two concurrent callers both seeing PENDING and both charging. Same FOR UPDATE
    // pattern the bid path has used since NEW-09.
    const outcome = await prisma.$transaction(async (dbTx) => {
      const [row] = await dbTx.$queryRaw<Array<{
        id: string;
        winnerId: string;
        auctionId: string;
        finalAmount: number;
        status: TransactionStatus;
      }>>`
        SELECT id, "winnerId", "auctionId", "finalAmount", status
        FROM "AuctionTransaction"
        WHERE id = ${transactionId}
        FOR UPDATE
      `;

      if (!row) return { kind: 'not-found' as const };
      if (row.winnerId !== winnerId) return { kind: 'forbidden' as const };

      // FAILED is retryable. A declined card is an ordinary event, and refusing it here was
      // what made one decline permanent — see BV-006 and the lastPaymentError column.
      // Everything from COMPLETED onward (BV-047) means the charge already succeeded once.
      if (PAID_STATUSES.includes(row.status)) {
        return { kind: 'already-paid' as const };
      }

      const charge = chargeCard(cardNumber);

      if (!charge.ok) {
        await dbTx.auctionTransaction.update({
          where: { id: row.id },
          data: { deliveryAddress, deliveryPhone, lastPaymentError: charge.reason },
        });
        return { kind: 'declined' as const, reason: charge.reason };
      }

      await dbTx.auctionTransaction.update({
        where: { id: row.id },
        data: {
          deliveryAddress,
          deliveryPhone,
          paymentReference: charge.reference,
          status: 'COMPLETED',
          lastPaymentError: null,
        },
      });

      const full = await dbTx.auctionTransaction.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          winner: { select: { email: true, name: true } },
          seller: { select: { email: true, name: true } },
          auction: { select: { title: true } },
        },
      });

      return { kind: 'ok' as const, full };
    });

    if (outcome.kind === 'not-found') { fail(res, 'Transaction not found.', 404); return; }
    if (outcome.kind === 'forbidden') { fail(res, 'Forbidden.', 403); return; }
    if (outcome.kind === 'already-paid') { fail(res, 'This purchase has already been paid for.', 409); return; }

    if (outcome.kind === 'declined') {
      // A decline is an ordinary business outcome, not a request error — same reasoning as
      // the fulfilment routes' error-kind mapping, just inline since there is only one case.
      ok(res, { transactionId, status: 'PENDING', lastPaymentError: outcome.reason });
      return;
    }

    dispatchEmail(sendPaymentCompletedEmail(
      { email: outcome.full.winner.email, name: outcome.full.winner.name },
      { email: outcome.full.seller.email, name: outcome.full.seller.name },
      { auctionTitle: outcome.full.auction.title, finalAmount: outcome.full.finalAmount },
    ), `payment completed (${transactionId})`);

    ok(res, { transactionId, status: 'COMPLETED' });
  }),
);

// ---------------------------------------------------------------------------
// Fulfilment (BV-047) — see services/fulfillment.service.ts for the state machine and every
// ledger write. Routes here only authenticate, translate the result kind to a status code, and
// respond.
// ---------------------------------------------------------------------------

const FULFILLMENT_ERROR_STATUS: Record<string, [string, number]> = {
  'not-found': ['Transaction not found.', 404],
  forbidden: ['Forbidden.', 403],
  'wrong-state': ['This action is not available for the transaction in its current state.', 409],
  'no-address': ['A delivery address is required before an item can be marked shipped.', 409],
  'payout-not-ready': ['Complete your payout setup before marking an item as shipped.', 409],
};

router.patch(
  '/:transactionId/ship',
  requireAuth(['SELLER']),
  asyncHandler(async (req, res) => {
    const result = await markShipped(req.params.transactionId, req.auth!.userId);
    if (result.kind !== 'ok') {
      const [message, status] = FULFILLMENT_ERROR_STATUS[result.kind];
      fail(res, message, status);
      return;
    }
    ok(res, { transactionId: req.params.transactionId, status: 'SHIPPED' });
  }),
);

router.post(
  '/:transactionId/confirm-receipt',
  requireAuth(['BUYER']),
  asyncHandler(async (req, res) => {
    const result = await confirmDelivery(req.params.transactionId, { requireWinnerId: req.auth!.userId });
    if (result.kind !== 'ok') {
      const [message, status] = FULFILLMENT_ERROR_STATUS[result.kind];
      fail(res, message, status);
      return;
    }
    ok(res, { transactionId: req.params.transactionId, status: 'DELIVERED' });
  }),
);

router.post(
  '/:transactionId/dispute',
  requireAuth(['BUYER']),
  validateBody(raiseDisputeSchema),
  asyncHandler(async (req, res) => {
    const result = await raiseDispute(req.params.transactionId, req.auth!.userId, req.body.reason);
    if (result.kind !== 'ok') {
      const [message, status] = FULFILLMENT_ERROR_STATUS[result.kind];
      fail(res, message, status);
      return;
    }
    ok(res, { transactionId: req.params.transactionId, status: 'DISPUTED' });
  }),
);

// LIFECYCLE-GAPS.md E3: the platform previously had no invoice, receipt, or proof of purchase
// anywhere. Derived entirely from the transaction row rather than a separate stored document —
// there is nothing here that isn't already in AuctionTransaction/Auction/Dispute.
router.get(
  '/:transactionId/invoice',
  requireAuth(['BUYER', 'SELLER', 'ADMIN']),
  asyncHandler(async (req, res) => {
    const { transactionId } = req.params;

    const tx = await prisma.auctionTransaction.findUnique({
      where: { id: transactionId },
      include: {
        auction: { select: { title: true, category: true } },
        winner: { select: { name: true, email: true } },
        seller: { select: { name: true, email: true } },
        dispute: { select: { status: true, reason: true, resolutionNote: true } },
      },
    });

    if (!tx) { fail(res, 'Transaction not found.', 404); return; }

    const { userId, role } = req.auth!;
    if (role !== 'ADMIN' && tx.winnerId !== userId && tx.sellerId !== userId) {
      fail(res, 'Forbidden.', 403);
      return;
    }

    ok(res, {
      transactionId: tx.id,
      invoiceNumber: `INV-${tx.id.slice(-8).toUpperCase()}`,
      auctionTitle: tx.auction.title,
      category: tx.auction.category,
      buyerName: tx.winner.name,
      buyerEmail: tx.winner.email,
      sellerName: tx.seller.name,
      sellerEmail: tx.seller.email,
      amount: tx.finalAmount,
      status: tx.status,
      paymentReference: tx.paymentReference ?? undefined,
      deliveryAddress: tx.deliveryAddress ?? undefined,
      deliveryPhone: tx.deliveryPhone ?? undefined,
      createdAt: tx.createdAt.toISOString(),
      shippedAt: tx.shippedAt?.toISOString(),
      disputeStatus: tx.dispute?.status,
      disputeReason: tx.dispute?.reason,
      disputeResolutionNote: tx.dispute?.resolutionNote ?? undefined,
    });
  }),
);

export default router;
