import { Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { prisma } from '../db/prisma.js';
import { getPlatformSettings, paymentDueAtFrom } from './settings.service.js';
import { generateListingCode } from '../utils/listing-code.js';
import { scheduleAuctionLifecycle, cancelScheduledJob } from '../queues/auction-lifecycle.queue.js';
import {
  dispatchEmail,
  sendAuctionCancelledEmail,
  sendPaymentDeadlineVoidedEmail,
  sendSecondChanceOfferEmail,
  sendListingTakenDownEmail,
} from './email.service.js';
import { announceRefund, refundLockedSale, type RefundActor, type RefundedSale } from './fulfillment.service.js';

/**
 * Phase 6 (LIFECYCLE-IMPLEMENTATION-PLAN.md): auction cancellation (B4/C4), the payment-deadline
 * sweep and its recovery paths (A3/A5). Phase 7's takedownListing() (C3) lives here too rather
 * than in a fourth file, since it's a thin wrapper that reuses cancelAuction() directly. Kept
 * apart from fulfillment.service.ts, which is scoped to the post-payment half of a sale —
 * everything here runs either before payment or instead of it. Same convention as that module:
 * every state transition lives here once, because each has more than one caller that must
 * behave identically (the seller's own cancel route and the admin's, the buyer's
 * confirm-receipt and the worker's sweep elsewhere).
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

type CancelActor = { userId: string; isAdmin: boolean; reason: string };
type CancelledAuction = {
  title: string;
  seller: { id: string; email: string; name: string };
  bidders: { id: string; email: string; name: string }[];
};

/**
 * Cancels an auction whose row the caller has locked and found ACTIVE: the status, the admin's
 * audit row and the in-app notices, in the caller's transaction. What happens after the commit
 * (the job, the live notice, the e-mails) is announceCancel's. Split so a takedown can cancel the
 * auction in the same transaction as the listing's removal.
 */
async function cancelLockedAuction(
  tx: Prisma.TransactionClient,
  auctionId: string,
  actor: CancelActor,
): Promise<CancelledAuction> {
  await tx.auction.update({ where: { id: auctionId }, data: { status: 'CANCELLED' } });

  if (actor.isAdmin) {
    await tx.auditLog.create({
      data: {
        actorUserId: actor.userId,
        action: 'AUCTION_CANCELLED',
        entityType: 'Auction',
        entityId: auctionId,
        metadata: { reason: actor.reason },
      },
    });
  }

  const full = await tx.auction.findUniqueOrThrow({
    where: { id: auctionId },
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

  return { title: full.title, seller: full.seller, bidders };
}

/** After a cancel has committed: the close job, the live notice and the e-mails. */
async function announceCancel(auctionId: string, cancelled: CancelledAuction, actor: CancelActor, io?: Server) {
  // The cancel has committed, so a failure here must not undo the answer, the live notice or the
  // e-mails below. A job that could not be removed (Redis down, or a worker already running it) is
  // harmless: closeAuction refuses an auction that is no longer ACTIVE.
  try {
    await cancelScheduledJob(auctionId);
  } catch (err) {
    console.error(`[auction-control] Could not remove the close job for cancelled auction ${auctionId}:`, err);
  }
  // LIFECYCLE-IMPLEMENTATION-PLAN.md's B4/C4 section calls for a live socket notification
  // ("bid:cancelled socket event") alongside the DB notification + email above -- named
  // `auction:cancelled` here instead, matching this codebase's own convention of naming
  // real-time events after the entity that changed (listing:approved, listing:submitted), not
  // literally following the plan's shorthand. Reaches anyone actively subscribed to this
  // auction's room (BuyerLiveBidding, AdminAuctionMonitor) regardless of which path cancelled
  // it -- a bid-free auction can still have a viewer with the page open.
  io?.to(`auction:${auctionId}`).emit('auction:cancelled', {
    auctionId,
    title: cancelled.title,
    reason: actor.reason,
  });
  dispatchEmail(
    sendAuctionCancelledEmail(
      cancelled.seller,
      { title: cancelled.title },
      { reason: actor.reason, cancelledByAdmin: actor.isAdmin, bidders: cancelled.bidders },
    ),
    `auction-cancelled (${auctionId})`,
  );
}

export async function cancelAuction(
  auctionId: string,
  actor: CancelActor,
  io?: Server,
): Promise<CancelAuctionResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; sellerId: string; status: string; bidCount: number }>>`
      SELECT id, "sellerId", status, "bidCount" FROM "Auction" WHERE id = ${auctionId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (!actor.isAdmin && row.sellerId !== actor.userId) return { kind: 'forbidden' as const };
    if (row.status !== 'ACTIVE') return { kind: 'wrong-state' as const };
    // The seller's own withdrawal is scoped to a bid-free auction — cancelling out from under
    // an active bidder is a buyer-protection problem the reference model doesn't solve cleanly
    // (see LIFECYCLE-IMPLEMENTATION-PLAN.md's B4/C4 section). The admin path has no such limit:
    // a pricing error or shill-bidding suspicion is exactly the case with bids already on it.
    if (!actor.isAdmin && row.bidCount > 0) return { kind: 'has-bids' as const };

    return { kind: 'ok' as const, cancelled: await cancelLockedAuction(tx, row.id, actor) };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };
  await announceCancel(auctionId, outcome.cancelled, actor, io);
  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------
// Payment deadline sweep (A3)
// ---------------------------------------------------------------------------

/**
 * Whether a waiting sale has run out of time. A sale carries its own due date (`paymentDueAt`: set
 * when it is created and again by every second-chance offer). One created before that column
 * existed has none, and is measured the way every sale used to be: from `createdAt`, with today's
 * paymentDeadlineHours.
 */
function isPaymentOverdue(
  row: { paymentDueAt: Date | null; createdAt: Date },
  now: Date,
  paymentDeadlineHours: number,
): boolean {
  if (row.paymentDueAt) return row.paymentDueAt < now;
  return row.createdAt.getTime() < now.getTime() - paymentDeadlineHours * 60 * 60 * 1000;
}

export async function findOverduePayments(): Promise<string[]> {
  const { paymentDeadlineHours } = await getPlatformSettings();
  const now = new Date();
  const cutoff = new Date(now.getTime() - paymentDeadlineHours * 60 * 60 * 1000);

  const rows = await prisma.auctionTransaction.findMany({
    where: {
      status: 'PENDING',
      OR: [{ paymentDueAt: { lt: now } }, { paymentDueAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export type VoidOverduePaymentResult = { kind: 'ok' } | { kind: 'not-found' } | { kind: 'wrong-state' };

export async function voidOverduePayment(transactionId: string): Promise<VoidOverduePaymentResult> {
  const { paymentDeadlineHours } = await getPlatformSettings();
  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ id: string; status: string; paymentDueAt: Date | null; createdAt: Date }>>`
      SELECT id, status, "paymentDueAt", "createdAt" FROM "AuctionTransaction" WHERE id = ${transactionId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (row.status !== 'PENDING') return { kind: 'wrong-state' as const };
    // The sweep read its list a moment ago. Since then the seller may have offered the item to
    // someone else, which gave this same row a fresh deadline: decided again here, under the lock.
    if (!isPaymentOverdue(row, new Date(), paymentDeadlineHours)) return { kind: 'wrong-state' as const };

    await tx.auctionTransaction.update({ where: { id: row.id }, data: { status: 'VOIDED', lastPaymentError: null } });

    // LIFECYCLE-IMPLEMENTATION-PLAN.md's A3 section: "writes an AuditLog row" -- system-initiated
    // (actorUserId null, same as any worker sweep), distinct action from the admin's own manual
    // TRANSACTION_VOIDED so the two can be told apart later.
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        action: 'TRANSACTION_VOIDED_OVERDUE',
        entityType: 'AuctionTransaction',
        entityId: row.id,
        metadata: { reason: 'Payment deadline exceeded' },
      },
    });

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
 * The highest bid on an auction by a buyer who is not in `excludeBuyerIds`: the person a
 * second-chance offer would go to. Exported so the seller-items read model previews the very same
 * choice offerToNextBidder will make, rather than a second copy of the rule that could drift.
 *
 * "not null" and "not in" are both spelled out (rather than relying on how `notIn` alone treats a
 * NULL buyerId) so an anonymised bidder (BV-018) is excluded the same unambiguous way
 * close-auction.ts excludes one from its own winner-selection query.
 */
export async function findNextBid(db: Prisma.TransactionClient, auctionId: string, excludeBuyerIds: string[]) {
  return db.bid.findFirst({
    where: { AND: [{ auctionId }, { buyerId: { not: null } }, { buyerId: { notIn: excludeBuyerIds } }] },
    orderBy: [{ amount: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    include: { buyer: true },
  });
}

/**
 * What findNextBid would find, for many unpaid sales in one query, as the amount only: the
 * seller-items list previews the offer for every defaulted sale on a page, and one lookup per row
 * made a page of them a page of queries. Each sale brings its own exclusions (the current winner
 * and everyone it was already taken away from), so they travel with it as JSON rather than as one
 * shared list. The rule is findNextBid's, written in SQL: a bid by a real (not anonymised) buyer
 * who is not excluded, highest amount; seller-items.test.ts checks the two agree on ties,
 * anonymised bidders and earlier defaulters. A sale nobody could be offered to has no entry.
 */
export async function findNextBidAmounts(
  sales: Array<{ auctionId: string; excludeBuyerIds: string[] }>,
): Promise<Map<string, number>> {
  if (sales.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ auctionId: string; amount: number | null }>>`
    SELECT t."auctionId", (
      SELECT max(b.amount) FROM "Bid" b
      WHERE b."auctionId" = t."auctionId"
        AND b."buyerId" IS NOT NULL
        AND b."buyerId" <> ALL (t."excludeBuyerIds")
    ) AS amount
    FROM jsonb_to_recordset(${JSON.stringify(sales)}::jsonb) AS t("auctionId" text, "excludeBuyerIds" text[])
  `;
  return new Map(rows.flatMap((r) => (r.amount === null ? [] : [[r.auctionId, r.amount] as const])));
}

/**
 * Locks the item's original listing and says whether an admin has taken it down. Both recovery
 * actions refuse a removed item: the takedown is the moderators' decision, and a fresh
 * (auto-approved) copy or a second sale would undo it. The lock is the listing row's, the same one
 * a takedown's UPDATE needs, so a takedown running at the same moment is ordered before or after
 * the recovery action, never in the middle of it. My Items already shows no such action on a
 * removed item; this is the endpoint refusing it too.
 */
async function isOriginalListingRemoved(tx: Prisma.TransactionClient, listingId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT status FROM "Listing" WHERE id = ${listingId} FOR UPDATE
  `;
  return row?.status === 'REMOVED';
}

/**
 * Re-targets the same transaction row at the next-highest bidder, at their own last bid — not
 * a new row, because AuctionTransaction.auctionId is @@unique (one transaction slot per
 * auction, ever). The defaulting winner's row already occupies that slot; nothing about it
 * (review/dispute/ledgerEntry) can exist yet, since none of those are reachable before a
 * transaction is ever paid, so re-pointing it at someone else is safe.
 *
 * The row is re-targeted in place, which overwrites winnerId, so the people it has already been
 * taken away from are kept in previousWinnerIds and never offered it again. A sale whose item has
 * already been relisted is refused: it is live in a new auction, and offering the old one to the
 * runner-up as well would sell the same item twice.
 */
export async function offerToNextBidder(
  transactionId: string,
  sellerId: string,
): Promise<OfferNextBidderResult> {
  const { paymentDeadlineHours } = await getPlatformSettings();
  const outcome = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      Array<{ id: string; auctionId: string; sellerId: string; winnerId: string; status: string; previousWinnerIds: string[] | null }>
    >`
      SELECT id, "auctionId", "sellerId", "winnerId", status, "previousWinnerIds" FROM "AuctionTransaction" WHERE id = ${transactionId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (row.sellerId !== sellerId) return { kind: 'forbidden' as const };
    if (row.status !== 'VOIDED') return { kind: 'wrong-state' as const };

    const auction = await tx.auction.findUniqueOrThrow({
      where: { id: row.auctionId },
      select: { title: true, listingId: true },
    });
    const alreadyRelisted = await tx.listing.findUnique({
      where: { relistedFromId: auction.listingId },
      select: { id: true },
    });
    if (alreadyRelisted) return { kind: 'wrong-state' as const };
    if (await isOriginalListingRemoved(tx, auction.listingId)) return { kind: 'wrong-state' as const };

    const alreadyOffered = [...(row.previousWinnerIds ?? []), row.winnerId];
    const nextBid = await findNextBid(tx, row.auctionId, alreadyOffered);
    if (!nextBid || nextBid.buyerId === null || nextBid.buyer === null) {
      return { kind: 'no-other-bidder' as const };
    }

    await tx.auctionTransaction.update({
      where: { id: row.id },
      data: {
        winnerId: nextBid.buyerId,
        previousWinnerIds: alreadyOffered,
        finalAmount: nextBid.amount,
        status: 'PENDING',
        // A new buyer, a new deadline: createdAt is the sale's own date and stays where it is.
        paymentDueAt: paymentDueAtFrom(new Date(), paymentDeadlineHours),
        paymentReference: null,
        paidAt: null,
        shipByAt: null,
        notShippedReportedAt: null,
        notShippedNote: null,
        lastPaymentError: null,
        deliveryAddress: null,
        deliveryPhone: null,
        shippedAt: null,
      },
    });

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
 *
 * A sale can be relisted once: the new Listing records relistedFromId, which is @unique, so a
 * second attempt (a double click, two tabs, a retry) fails that constraint and is reported as
 * wrong-state. A relisted sale is likewise refused by offerToNextBidder.
 */
export async function relistFromVoidedTransaction(
  transactionId: string,
  sellerId: string,
): Promise<RelistResult> {
  const startTime = new Date();
  const result = await createRelist(transactionId, sellerId, startTime);
  if (result.kind !== 'ok') return { kind: result.kind };

  try {
    await scheduleAuctionLifecycle({ auctionId: result.auctionId, endTime: result.endTime });
  } catch (err) {
    console.error(`[auction-control] Failed to schedule lifecycle for relisted auction ${result.auctionId}:`, err);
  }

  return { kind: 'ok', listingId: result.listingId, auctionId: result.auctionId };
}

function isUniqueViolation(err: unknown, field: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    ((err.meta?.target as string[] | undefined)?.includes(field) ?? false)
  );
}

// BV-014: listingCode is random and unique, so a collision is internal and says nothing about what
// the seller did. A unique violation aborts a Postgres transaction ("current transaction is
// aborted" for every later statement), so the retry has to be a whole new transaction, not a
// second insert inside the first. The other unique violation, relistedFromId, means this sale was
// already relisted and is an answer, not something to retry.
async function createRelist(transactionId: string, sellerId: string, startTime: Date) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await relistOnce(transactionId, sellerId, startTime);
    } catch (err) {
      if (isUniqueViolation(err, 'relistedFromId')) return { kind: 'wrong-state' as const };
      if (!isUniqueViolation(err, 'listingCode') || attempt === 2) throw err;
    }
  }
  throw new Error('unreachable: relist retry loop exited without a result');
}

async function relistOnce(transactionId: string, sellerId: string, startTime: Date) {
  return prisma.$transaction(async (dbTx) => {
    // The same row lock offerToNextBidder takes, so the two serialise: whichever runs second
    // sees the other's effect (a relist, or a sale that is PENDING again) and is refused. The
    // checks used to run before the transaction and never marked the sale, which let a relist
    // run any number of times.
    const [row] = await dbTx.$queryRaw<Array<{ id: string; sellerId: string; status: string }>>`
      SELECT id, "sellerId", status FROM "AuctionTransaction" WHERE id = ${transactionId} FOR UPDATE
    `;
    if (!row) return { kind: 'not-found' as const };
    if (row.sellerId !== sellerId) return { kind: 'forbidden' as const };
    if (row.status !== 'VOIDED') return { kind: 'wrong-state' as const };

    const sale = await dbTx.auctionTransaction.findUniqueOrThrow({
      where: { id: transactionId },
      select: { auction: { include: { listing: true } } },
    });
    const original = sale.auction.listing;
    if (await isOriginalListingRemoved(dbTx, original.id)) return { kind: 'wrong-state' as const };

    const endTime = new Date(startTime.getTime() + original.durationDays * 24 * 60 * 60 * 1000);

    const listing = await dbTx.listing.create({
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
        relistedFromId: original.id,
        status: 'APPROVED',
      },
    });

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

    return { kind: 'ok' as const, listingId: listing.id, auctionId: auction.id, endTime };
  });
}

// ---------------------------------------------------------------------------
// Takedown (C3, Phase 7): an approved listing pulled for cause
// ---------------------------------------------------------------------------

export type TakedownListingResult = { kind: 'ok' } | { kind: 'not-found' } | { kind: 'wrong-state' };

/**
 * Scoped to APPROVED listings only -- a PENDING one goes through the existing /reject route
 * instead, and there is nothing to take down from REJECTED/REMOVED/DRAFT. If the auction
 * underneath is still ACTIVE it is cancelled (every bidder told), a sale still waiting for payment
 * is voided, and a sale paid for but not yet sent is refunded (FR-02: a removed item, stolen or
 * counterfeit, must not be sent; eBay likewise refunds at once when it acts against a seller). A
 * sale already shipped is left to the buyer's confirm-or-dispute window.
 *
 * All of it is one transaction. It used to check the listing outside any lock, commit REMOVED,
 * then cancel the auction separately: a close job running at that moment turned the auction into a
 * sale after the takedown had looked for one (so the removed item's sale stayed open), and two
 * takedowns of one listing both went through. The rows are locked in the order every other path
 * takes them: the auction (closeAuction, bids, cancel lock only that), then its sale (pay, offer,
 * relist take the sale before the listing), then the listing. A close in progress is therefore
 * waited for and its sale seen; a takedown in progress is waited for and refused.
 */
export async function takedownListing(
  listingId: string,
  adminUserId: string,
  reason: string,
  io?: Server,
): Promise<TakedownListingResult> {
  const cancelActor: CancelActor = { userId: adminUserId, isAdmin: true, reason: `Listing removed: ${reason}` };
  const refundActor: RefundActor = { by: 'admin', userId: adminUserId, reason: `Listing removed: ${reason}` };

  const outcome = await prisma.$transaction(async (tx) => {
    // Which auction belongs to this listing never changes, so it is read before taking any lock.
    const auction = await tx.auction.findUnique({ where: { listingId }, select: { id: true } });
    const [auctionRow] = auction
      ? await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Auction" WHERE id = ${auction.id} FOR UPDATE`
      : [];
    const [openSale] = auction
      ? await tx.$queryRaw<Array<{ id: string; status: string; winnerId: string }>>`
          SELECT id, status, "winnerId" FROM "AuctionTransaction" WHERE "auctionId" = ${auction.id} FOR UPDATE
        `
      : [];
    const [locked] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM "Listing" WHERE id = ${listingId} FOR UPDATE
    `;
    if (!locked) return { kind: 'not-found' as const };
    if (locked.status !== 'APPROVED') return { kind: 'wrong-state' as const };

    // The reason goes on the listing as well as into the audit log: the seller can read the
    // listing, never the audit log, and a removal with no explanation is what they saw before.
    const listing = await tx.listing.update({
      where: { id: listingId },
      data: { status: 'REMOVED', rejectionReason: reason },
      include: { seller: { select: { email: true, name: true } } },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'LISTING_REMOVED',
        entityType: 'Listing',
        entityId: listing.id,
        metadata: { reason },
      },
    });
    await tx.notification.create({
      data: {
        userId: listing.sellerId,
        type: 'LISTING_REMOVED',
        title: 'Listing removed',
        message: `Your listing "${listing.title}" was removed by an admin: ${reason}`,
      },
    });

    // A removed item is not sold: a sale on it still waiting for payment is cancelled with it.
    if (openSale && (openSale.status === 'PENDING' || openSale.status === 'FAILED')) {
      await tx.auctionTransaction.update({
        where: { id: openSale.id },
        data: { status: 'VOIDED', lastPaymentError: null },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: adminUserId,
          action: 'TRANSACTION_VOIDED',
          entityType: 'AuctionTransaction',
          entityId: openSale.id,
          metadata: { reason: `Listing removed: ${reason}` },
        },
      });
      await tx.notification.create({
        data: {
          userId: openSale.winnerId,
          type: 'AUCTION_CANCELLED',
          title: 'Sale cancelled',
          message: `BidVault removed "${listing.title}", so this sale is cancelled. Nothing is owed and nothing was charged.`,
        },
      });
    }

    let refunded: RefundedSale | null = null;
    if (openSale?.status === 'COMPLETED') {
      refunded = await refundLockedSale(tx, openSale.id, refundActor);
    }

    const cancelled =
      auction && auctionRow?.status === 'ACTIVE' ? await cancelLockedAuction(tx, auction.id, cancelActor) : null;

    return { kind: 'ok' as const, listing, auctionId: auction?.id, cancelled, refunded };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };

  if (outcome.cancelled && outcome.auctionId) {
    await announceCancel(outcome.auctionId, outcome.cancelled, cancelActor, io);
  }
  if (outcome.refunded) announceRefund(outcome.refunded, refundActor);
  dispatchEmail(
    sendListingTakenDownEmail(outcome.listing.seller, { title: outcome.listing.title, reason }),
    `listing-taken-down (${listingId})`,
  );

  return { kind: 'ok' };
}
