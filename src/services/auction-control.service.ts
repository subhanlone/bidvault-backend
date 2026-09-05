import { Prisma, type Listing } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getPlatformSettings } from './settings.service.js';
import { generateListingCode } from '../modules/listings/listings.routes.js';
import { scheduleAuctionLifecycle, cancelScheduledJob } from '../queues/auction-lifecycle.queue.js';
import {
  dispatchEmail,
  sendAuctionCancelledEmail,
  sendPaymentDeadlineVoidedEmail,
  sendSecondChanceOfferEmail,
} from './email.service.js';

/**
 * Phase 6 (LIFECYCLE-IMPLEMENTATION-PLAN.md): auction cancellation (B4/C4), the payment-deadline
 * sweep and its recovery paths (A3/A5). Kept apart from fulfillment.service.ts, which is scoped
 * to the post-payment half of a sale — everything here runs either before payment or instead of
 * it. Same convention as that module: every state transition lives here once, because each has
 * more than one caller that must behave identically (the seller's own cancel route and the
 * admin's, the buyer's confirm-receipt and the worker's sweep elsewhere).
 */

// ---------------------------------------------------------------------------
// Cancel (B4: seller withdraws a bid-free auction; C4: admin stops any auction)
// ---------------------------------------------------------------------------

export type CancelAuctionResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' }
  | { kind: 'has-bids' };

export async function cancelAuction(
  auctionId: string,
  actor: { userId: string; isAdmin: boolean; reason: string },
): Promise<CancelAuctionResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; sellerId: string; status: string; bidCount: number; title: string }>>`
      SELECT id, "sellerId", status, "bidCount", title FROM "Auction" WHERE id = ${auctionId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (!actor.isAdmin && row.sellerId !== actor.userId) return { kind: 'forbidden' as const };
    if (row.status !== 'ACTIVE') return { kind: 'wrong-state' as const };
    // The seller's own withdrawal is scoped to a bid-free auction — cancelling out from under
    // an active bidder is a buyer-protection problem the reference model doesn't solve cleanly
    // (see LIFECYCLE-IMPLEMENTATION-PLAN.md's B4/C4 section). The admin path has no such limit:
    // a pricing error or shill-bidding suspicion is exactly the case with bids already on it.
    if (!actor.isAdmin && row.bidCount > 0) return { kind: 'has-bids' as const };

    await tx.auction.update({ where: { id: row.id }, data: { status: 'CANCELLED' } });

    if (actor.isAdmin) {
      await tx.auditLog.create({
        data: {
          actorUserId: actor.userId,
          action: 'AUCTION_CANCELLED',
          entityType: 'Auction',
          entityId: row.id,
          metadata: { reason: actor.reason },
        },
      });
    }

    const full = await tx.auction.findUniqueOrThrow({
      where: { id: row.id },
      include: {
        seller: { select: { id: true, email: true, name: true } },
        bids: {
          where: { buyerId: { not: null } },
          distinct: ['buyerId'],
          include: { buyer: { select: { id: true, email: true, name: true } } },
        },
      },
    });
    const bidders = full.bids.map((b) => b.buyer!);

    await tx.notification.createMany({
      data: [
        {
          userId: full.sellerId,
          type: 'AUCTION_CANCELLED',
          title: 'Auction cancelled',
          message: actor.isAdmin
            ? `An admin cancelled your auction "${full.title}": ${actor.reason}`
            : `You cancelled your auction "${full.title}".`,
        },
        ...bidders.map((b) => ({
          userId: b.id,
          type: 'AUCTION_CANCELLED',
          title: 'Auction cancelled',
          message: `The auction "${full.title}" you bid on was cancelled: ${actor.reason}`,
        })),
      ],
    });

    return {
      kind: 'ok' as const,
      title: full.title,
      seller: full.seller,
      bidders,
    };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };

  await cancelScheduledJob(auctionId);
  dispatchEmail(
    sendAuctionCancelledEmail(
      outcome.seller,
      { title: outcome.title },
      { reason: actor.reason, cancelledByAdmin: actor.isAdmin, bidders: outcome.bidders },
    ),
    `auction-cancelled (${auctionId})`,
  );

  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------
// Payment deadline sweep (A3)
// ---------------------------------------------------------------------------

export async function findOverduePayments(): Promise<string[]> {
  const { paymentDeadlineHours } = await getPlatformSettings();
  const cutoff = new Date(Date.now() - paymentDeadlineHours * 60 * 60 * 1000);

  const rows = await prisma.auctionTransaction.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export type VoidOverduePaymentResult = { kind: 'ok' } | { kind: 'not-found' } | { kind: 'wrong-state' };

export async function voidOverduePayment(transactionId: string): Promise<VoidOverduePaymentResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM "AuctionTransaction" WHERE id = ${transactionId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (row.status !== 'PENDING') return { kind: 'wrong-state' as const };

    await tx.auctionTransaction.update({ where: { id: row.id }, data: { status: 'VOIDED', lastPaymentError: null } });

    const full = await tx.auctionTransaction.findUniqueOrThrow({
      where: { id: row.id },
      select: {
        finalAmount: true,
        auction: { select: { title: true } },
        winner: { select: { email: true, name: true } },
        seller: { select: { email: true, name: true } },
      },
    });

    return { kind: 'ok' as const, ...full };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };

  dispatchEmail(
    sendPaymentDeadlineVoidedEmail(
      outcome.winner,
      outcome.seller,
      { title: outcome.auction.title, finalAmount: outcome.finalAmount },
    ),
    `payment-deadline-voided (${transactionId})`,
  );

  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------
// Non-payment recovery (A5): the seller's two options on a VOIDED transaction
// ---------------------------------------------------------------------------

export type OfferNextBidderResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' }
  | { kind: 'no-other-bidder' };

/**
 * Re-targets the same transaction row at the next-highest bidder, at their own last bid — not
 * a new row, because AuctionTransaction.auctionId is @@unique (one transaction slot per
 * auction, ever). The defaulting winner's row already occupies that slot; nothing about it
 * (review/dispute/ledgerEntry) can exist yet, since none of those are reachable before a
 * transaction is ever paid, so re-pointing it at someone else is safe.
 */
export async function offerToNextBidder(
  transactionId: string,
  sellerId: string,
): Promise<OfferNextBidderResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; auctionId: string; sellerId: string; winnerId: string; status: string }>>`
      SELECT id, "auctionId", "sellerId", "winnerId", status FROM "AuctionTransaction" WHERE id = ${transactionId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (row.sellerId !== sellerId) return { kind: 'forbidden' as const };
    if (row.status !== 'VOIDED') return { kind: 'wrong-state' as const };

    // Both conditions spelled out explicitly (rather than relying on how `not` alone treats a
    // NULL buyerId) so an anonymised bidder (BV-018) is excluded the same unambiguous way
    // close-auction.ts excludes one from its own winner-selection query.
    const nextBid = await tx.bid.findFirst({
      where: { AND: [{ auctionId: row.auctionId }, { buyerId: { not: null } }, { buyerId: { not: row.winnerId } }] },
      orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: { buyer: true },
    });
    if (!nextBid || nextBid.buyerId === null || nextBid.buyer === null) {
      return { kind: 'no-other-bidder' as const };
    }

    await tx.auctionTransaction.update({
      where: { id: row.id },
      data: {
        winnerId: nextBid.buyerId,
        finalAmount: nextBid.amount,
        status: 'PENDING',
        paymentReference: null,
        lastPaymentError: null,
        deliveryAddress: null,
        deliveryPhone: null,
        shippedAt: null,
      },
    });

    const auction = await tx.auction.findUniqueOrThrow({ where: { id: row.auctionId }, select: { title: true } });

    await tx.notification.create({
      data: {
        userId: nextBid.buyerId,
        type: 'SECOND_CHANCE_OFFER',
        title: "You've been offered an item",
        message: `The seller is offering you "${auction.title}" at your bid of PKR ${nextBid.amount.toLocaleString()}.`,
      },
    });

    return { kind: 'ok' as const, auctionTitle: auction.title, buyer: nextBid.buyer, amount: nextBid.amount };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };

  dispatchEmail(
    sendSecondChanceOfferEmail(outcome.buyer, { title: outcome.auctionTitle, amount: outcome.amount }),
    `second-chance-offer (${transactionId})`,
  );
  return { kind: 'ok' };
}

export type RelistResult =
  | { kind: 'ok'; listingId: string; auctionId: string }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' };

/**
 * Creates a fresh Listing + Auction pair rather than a second Auction against the original
 * Listing — Auction.listingId is @@unique (one auction per listing, ever), so a relist is a
 * new listing cycle, not a reopening of the old one. The original Listing/Auction/
 * AuctionTransaction rows are untouched — they stay the historical record of the sale that
 * fell through. Already-vetted (this item was APPROVED once already), so the new Listing
 * skips PENDING review and goes straight to APPROVED + an ACTIVE auction, same as
 * approveOneListing's shape but without its admin-approval emails, which would misdescribe
 * what just happened.
 */
export async function relistFromVoidedTransaction(
  transactionId: string,
  sellerId: string,
): Promise<RelistResult> {
  const tx0 = await prisma.auctionTransaction.findUnique({
    where: { id: transactionId },
    select: { sellerId: true, status: true, auction: { include: { listing: true } } },
  });
  if (!tx0) return { kind: 'not-found' };
  if (tx0.sellerId !== sellerId) return { kind: 'forbidden' };
  if (tx0.status !== 'VOIDED') return { kind: 'wrong-state' };

  const original = tx0.auction.listing;
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + original.durationDays * 24 * 60 * 60 * 1000);

  const result = await prisma.$transaction(async (dbTx) => {
    let listing: Listing | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        listing = await dbTx.listing.create({
          data: {
            listingCode: generateListingCode(),
            sellerId: original.sellerId,
            title: original.title,
            category: original.category,
            condition: original.condition,
            description: original.description,
            startPrice: original.startPrice,
            reservePrice: original.reservePrice,
            minIncrement: original.minIncrement,
            durationDays: original.durationDays,
            imageUrl: original.imageUrl,
            emoji: original.emoji,
            attributes: original.attributes ?? undefined,
            status: 'APPROVED',
          },
        });
        break;
      } catch (err) {
        const isCodeCollision =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          (err.meta?.target as string[] | undefined)?.includes('listingCode');
        if (!isCodeCollision || attempt === 2) throw err;
      }
    }
    if (!listing) throw new Error('unreachable: relist listing-creation loop exited without a result');

    const auction = await dbTx.auction.create({
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
        status: 'ACTIVE',
      },
    });

    await dbTx.notification.create({
      data: {
        userId: sellerId,
        type: 'LISTING_RELISTED',
        title: 'Item relisted',
        message: `"${listing.title}" is live again in a new auction.`,
      },
    });

    return { listingId: listing.id, auctionId: auction.id };
  });

  try {
    await scheduleAuctionLifecycle({ auctionId: result.auctionId, endTime });
  } catch (err) {
    console.error(`[auction-control] Failed to schedule lifecycle for relisted auction ${result.auctionId}:`, err);
  }

  return { kind: 'ok', ...result };
}
