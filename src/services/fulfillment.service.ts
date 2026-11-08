import type { Prisma, TransactionStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getPlatformSettings } from './settings.service.js';
import {
  dispatchEmail,
  sendItemShippedEmail,
  sendDeliveryConfirmedEmail,
  sendDisputeRaisedEmail,
  sendDisputeResolvedEmail,
} from './email.service.js';

/**
 * BV-047: the post-payment half of a sale, absent from the platform entirely before this
 * (LIFECYCLE-GAPS.md A4/C5/E6). A transaction moves COMPLETED -> SHIPPED -> DELIVERED (or
 * DISPUTED -> REFUNDED/DELIVERED) — see the TransactionStatus enum in schema.prisma for the
 * full state diagram.
 *
 * This module holds every state transition, because each one has more than one caller that
 * must behave identically: confirmDelivery() is reached from the buyer's own route, the
 * worker's timeout sweep, and an admin releasing a dispute. Routes and the worker stay thin
 * callers, matching close-auction.ts's split from auction-lifecycle.worker.ts.
 *
 * The payment gateway is fully self-built (see payment-gateway.service.ts) — a seller's payout
 * is a local ledger write, not a network call, so it lives inside the same transaction as the
 * state change it accompanies rather than after it. There is no external failure mode to
 * handle here any more.
 */

/**
 * Every status a transaction reaches once payment has actually succeeded, except REFUNDED —
 * the money went back, so it should no longer count as revenue. Before BV-047 every revenue
 * aggregate filtered for status = 'COMPLETED' alone; that status now means "paid, not yet
 * shipped" rather than "the whole sale", so anything reading it for a revenue figure needs
 * this list instead. Two admin.routes.ts queries are raw SQL and can't share this array
 * directly — kept in sync by hand, `status IN ('COMPLETED','SHIPPED','DELIVERED','DISPUTED')`.
 */
export const REVENUE_STATUSES: TransactionStatus[] = ['COMPLETED', 'SHIPPED', 'DELIVERED', 'DISPUTED'];

type LockedTransactionRow = {
  id: string;
  status: string;
  winnerId: string;
  sellerId: string;
  finalAmount: number;
};

async function lockTransaction(
  tx: Prisma.TransactionClient,
  transactionId: string,
): Promise<LockedTransactionRow | undefined> {
  const [row] = await tx.$queryRaw<LockedTransactionRow[]>`
    SELECT id, status, "winnerId", "sellerId", "finalAmount"
    FROM "AuctionTransaction"
    WHERE id = ${transactionId}
    FOR UPDATE
  `;
  return row;
}

// ---------------------------------------------------------------------------
// Ship
// ---------------------------------------------------------------------------

export type MarkShippedResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' }
  | { kind: 'no-address' };

export async function markShipped(transactionId: string, sellerId: string): Promise<MarkShippedResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await lockTransaction(tx, transactionId);
    if (!row) return { kind: 'not-found' as const };
    if (row.sellerId !== sellerId) return { kind: 'forbidden' as const };
    if (row.status !== 'COMPLETED') return { kind: 'wrong-state' as const };

    const full = await tx.auctionTransaction.findUniqueOrThrow({
      where: { id: row.id },
      select: {
        deliveryAddress: true,
        auction: { select: { title: true } },
        winner: { select: { email: true, name: true } },
      },
    });
    if (!full.deliveryAddress) return { kind: 'no-address' as const };

    await tx.auctionTransaction.update({
      where: { id: row.id },
      data: { status: 'SHIPPED', shippedAt: new Date() },
    });

    await tx.notification.create({
      data: {
        userId: row.winnerId,
        type: 'ITEM_SHIPPED',
        title: 'Your item has shipped',
        message: `"${full.auction.title}" is on its way. Confirm receipt once it arrives, or report a problem if something's wrong.`,
      },
    });

    return { kind: 'ok' as const, auctionTitle: full.auction.title, buyer: full.winner };
  });

  if (outcome.kind === 'ok') {
    const { reviewTimeoutHours } = await getPlatformSettings();
    dispatchEmail(
      sendItemShippedEmail(outcome.buyer, { auctionTitle: outcome.auctionTitle, reviewTimeoutHours }),
      `item-shipped (${transactionId})`,
    );
  }

  return outcome.kind === 'ok' ? { kind: 'ok' } : outcome;
}

// ---------------------------------------------------------------------------
// Confirm delivery -> payout (used by the buyer's route, the timeout sweep, and an admin
// releasing a dispute in the seller's favour)
// ---------------------------------------------------------------------------

export type ConfirmDeliveryResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' };

/**
 * Marks a locked sale DELIVERED and pays the seller: the ledger entry, the balance and the payout
 * notice, all in the caller's transaction. The gateway is local, so there is no external latency or
 * failure mode to keep off the row lock: either the delivery and the payout both happen or neither
 * does. Shared by confirmDelivery and by resolveDispute's RELEASE, which must not commit the
 * dispute's resolution without them.
 */
async function deliverAndPaySeller(tx: Prisma.TransactionClient, row: LockedTransactionRow) {
  const full = await tx.auctionTransaction.findUniqueOrThrow({
    where: { id: row.id },
    select: { auction: { select: { title: true } }, seller: { select: { id: true, email: true, name: true } } },
  });

  await tx.auctionTransaction.update({ where: { id: row.id }, data: { status: 'DELIVERED' } });
  await tx.ledgerEntry.create({
    data: { sellerId: row.sellerId, transactionId: row.id, amount: row.finalAmount },
  });
  await tx.user.update({
    where: { id: row.sellerId },
    data: { ledgerBalance: { increment: row.finalAmount } },
  });
  await tx.notification.create({
    data: {
      userId: row.sellerId,
      type: 'PAYOUT_RECEIVED',
      title: "You've been paid",
      message: `PKR ${row.finalAmount.toLocaleString()} for "${full.auction.title}" has been added to your earnings.`,
    },
  });

  return { finalAmount: row.finalAmount, auctionTitle: full.auction.title, seller: full.seller };
}

export async function confirmDelivery(
  transactionId: string,
  opts: { requireWinnerId?: string; auto?: boolean } = {},
): Promise<ConfirmDeliveryResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await lockTransaction(tx, transactionId);
    if (!row) return { kind: 'not-found' as const };
    if (opts.requireWinnerId && row.winnerId !== opts.requireWinnerId) return { kind: 'forbidden' as const };
    // The buyer's confirmation and the timeout sweep both start from SHIPPED. An admin releasing
    // a DISPUTED sale goes through resolveDispute, which pays the seller in its own transaction.
    if (row.status !== 'SHIPPED') return { kind: 'wrong-state' as const };

    return { kind: 'ok' as const, ...(await deliverAndPaySeller(tx, row)) };
  });

  if (outcome.kind !== 'ok') return { kind: outcome.kind };

  dispatchEmail(
    sendDeliveryConfirmedEmail(
      { email: outcome.seller.email, name: outcome.seller.name },
      { auctionTitle: outcome.auctionTitle, finalAmount: outcome.finalAmount, auto: opts.auto === true },
    ),
    `delivery-confirmed (${transactionId})`,
  );

  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

/**
 * How long the seller is told they have to respond to a dispute. A soft window: it is shown to
 * the seller ("respond within 3 days") and to the admin (answered, or window passed), but nothing
 * waits for it or enforces it -- resolveDispute works at any time, with or without a response.
 * eBay gives a seller 3 business days and Stripe 7 to 21 days; calendar days keep this simple.
 */
export const DISPUTE_RESPONSE_WINDOW_DAYS = 3;

export function disputeResponseDueAt(raisedAt: Date): Date {
  return new Date(raisedAt.getTime() + DISPUTE_RESPONSE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export type RaiseDisputeResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'wrong-state' };

export async function raiseDispute(
  transactionId: string,
  buyerId: string,
  reason: string,
): Promise<RaiseDisputeResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await lockTransaction(tx, transactionId);
    if (!row) return { kind: 'not-found' as const };
    if (row.winnerId !== buyerId) return { kind: 'forbidden' as const };
    if (row.status !== 'SHIPPED') return { kind: 'wrong-state' as const };

    const full = await tx.auctionTransaction.findUniqueOrThrow({
      where: { id: row.id },
      select: { auction: { select: { title: true } }, seller: { select: { email: true, name: true } } },
    });

    await tx.auctionTransaction.update({ where: { id: row.id }, data: { status: 'DISPUTED' } });
    const dispute = await tx.dispute.create({
      data: { transactionId: row.id, raisedByUserId: buyerId, reason },
    });

    await tx.notification.create({
      data: {
        userId: row.sellerId,
        type: 'DISPUTE_RAISED',
        title: 'A dispute was raised',
        message: `The buyer reported a problem with "${full.auction.title}": "${reason}". You can respond within ${DISPUTE_RESPONSE_WINDOW_DAYS} days.`,
      },
    });

    return {
      kind: 'ok' as const,
      auctionTitle: full.auction.title,
      seller: full.seller,
      respondBy: disputeResponseDueAt(dispute.createdAt),
    };
  });

  if (outcome.kind === 'ok') {
    dispatchEmail(
      sendDisputeRaisedEmail(outcome.seller, {
        auctionTitle: outcome.auctionTitle,
        reason,
        respondBy: outcome.respondBy,
        windowDays: DISPUTE_RESPONSE_WINDOW_DAYS,
      }),
      `dispute-raised (${transactionId})`,
    );
    return { kind: 'ok' };
  }
  return outcome;
}

export type RespondToDisputeResult =
  | { kind: 'ok'; respondedAt: Date }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'no-open-dispute' }
  | { kind: 'already-responded' };

/**
 * The seller's one response to a dispute on their own sale: stored once, never edited, and only
 * while the dispute is OPEN. It informs the admin's decision and gates nothing.
 *
 * The Dispute row is locked, not the transaction: resolveDispute locks that same row, so a
 * response and a resolution cannot interleave -- a response is stored before the admin's decision
 * commits or is refused, never written onto a dispute that has already been decided.
 */
export async function respondToDispute(
  transactionId: string,
  sellerId: string,
  response: string,
): Promise<RespondToDisputeResult> {
  return prisma.$transaction(async (tx) => {
    const sale = await tx.auctionTransaction.findUnique({
      where: { id: transactionId },
      select: { sellerId: true },
    });
    if (!sale) return { kind: 'not-found' as const };
    if (sale.sellerId !== sellerId) return { kind: 'forbidden' as const };

    const [dispute] = await tx.$queryRaw<Array<{ id: string; status: string; sellerResponse: string | null }>>`
      SELECT id, status, "sellerResponse" FROM "Dispute" WHERE "transactionId" = ${transactionId} FOR UPDATE
    `;
    if (!dispute || dispute.status !== 'OPEN') return { kind: 'no-open-dispute' as const };
    if (dispute.sellerResponse !== null) return { kind: 'already-responded' as const };

    const respondedAt = new Date();
    await tx.dispute.update({
      where: { id: dispute.id },
      data: { sellerResponse: response, sellerRespondedAt: respondedAt },
    });
    return { kind: 'ok' as const, respondedAt };
  });
}

// ---------------------------------------------------------------------------
// Admin dispute resolution
// ---------------------------------------------------------------------------

export type ResolveDisputeResult =
  | { kind: 'ok' }
  | { kind: 'not-found' }
  | { kind: 'not-open' };

export async function resolveDispute(
  disputeId: string,
  adminUserId: string,
  resolution: 'REFUND' | 'RELEASE',
  note: string,
): Promise<ResolveDisputeResult> {
  // One transaction for the whole decision: the dispute's resolution, the sale's new status and, on
  // RELEASE, the seller's payout. They used to be two, with the payout's result ignored, so a payout
  // that failed left the dispute closed (gone from the admin's list), the sale DISPUTED and the
  // seller unpaid, with nothing to retry it. Now a failure undoes all of it and the admin can retry.
  const outcome = await prisma.$transaction(async (tx) => {
    // The sale's row first, then the dispute's: the order every path takes (the sale before
    // anything that hangs off it). The dispute's sale never changes, so it can be read unlocked.
    const [ref] = await tx.$queryRaw<Array<{ transactionId: string }>>`
      SELECT "transactionId" FROM "Dispute" WHERE id = ${disputeId}
    `;
    if (!ref) return { kind: 'not-found' as const };
    const sale = await lockTransaction(tx, ref.transactionId);

    // Locked the same way every other admin decision on a financial row is (void-transaction,
    // pay): two admins resolving the same dispute at once must not both pass the OPEN check
    // before either write commits.
    const [locked] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM "Dispute" WHERE id = ${disputeId} FOR UPDATE
    `;
    if (!locked) return { kind: 'not-found' as const };
    if (locked.status !== 'OPEN') return { kind: 'not-open' as const };
    // An open dispute always sits on a DISPUTED sale (raiseDispute writes both together, and only
    // this function moves either on). Anything else is damaged data, said out loud, not resolved.
    if (!sale || sale.status !== 'DISPUTED') {
      throw new Error(`Dispute ${disputeId} is OPEN but its sale is ${sale?.status ?? 'missing'}; not resolving it.`);
    }

    const dispute = await tx.dispute.findUniqueOrThrow({
      where: { id: disputeId },
      include: {
        transaction: {
          include: {
            auction: { select: { title: true } },
            winner: { select: { email: true, name: true } },
            seller: { select: { email: true, name: true } },
          },
        },
      },
    });

    await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: resolution === 'REFUND' ? 'RESOLVED_REFUNDED' : 'RESOLVED_RELEASED',
        resolvedByUserId: adminUserId,
        resolutionNote: note,
        resolvedAt: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: resolution === 'REFUND' ? 'DISPUTE_RESOLVED_REFUNDED' : 'DISPUTE_RESOLVED_RELEASED',
        entityType: 'Dispute',
        entityId: dispute.id,
        metadata: { transactionId: dispute.transactionId, note },
      },
    });

    if (resolution === 'REFUND') {
      // A pure status flip — a dispute is only reachable from SHIPPED, so no payout has ever
      // fired for this transaction, and the gateway never actually moved money to begin with.
      // There is nothing to reverse.
      await tx.auctionTransaction.update({ where: { id: dispute.transactionId }, data: { status: 'REFUNDED' } });
    }

    const title = dispute.transaction.auction.title;
    await tx.notification.createMany({
      data:
        resolution === 'REFUND'
          ? [
              {
                userId: dispute.transaction.winnerId,
                type: 'DISPUTE_RESOLVED',
                title: 'Dispute resolved — refunded',
                message: `Your dispute for "${title}" was resolved. You've been refunded.`,
              },
              {
                userId: dispute.transaction.sellerId,
                type: 'DISPUTE_RESOLVED',
                title: 'Dispute resolved — refunded',
                message: `The dispute for "${title}" was resolved in the buyer's favour. No payout will be issued.`,
              },
            ]
          : [
              {
                userId: dispute.transaction.winnerId,
                type: 'DISPUTE_RESOLVED',
                title: 'Dispute resolved',
                message: `Your dispute for "${title}" was resolved in the seller's favour.`,
              },
            ],
      // RELEASE's seller-facing notification is the payout notice deliverAndPaySeller writes (the
      // same one any delivery gets) rather than a second one here.
    });

    const payout = resolution === 'RELEASE' ? await deliverAndPaySeller(tx, sale) : null;

    return {
      kind: 'ok' as const,
      transactionId: dispute.transactionId,
      auctionTitle: dispute.transaction.auction.title,
      buyer: dispute.transaction.winner,
      seller: dispute.transaction.seller,
      payout,
    };
  });

  if (outcome.kind !== 'ok') return outcome;

  if (resolution === 'REFUND') {
    dispatchEmail(
      sendDisputeResolvedEmail(outcome.buyer, outcome.seller, {
        auctionTitle: outcome.auctionTitle,
        resolution: 'REFUNDED',
        note,
      }),
      `dispute-resolved-refunded (${outcome.transactionId})`,
    );
    return { kind: 'ok' };
  }

  // RELEASE: the sale was delivered and the seller paid inside the transaction above; these are the
  // same two e-mails the two-step version sent.
  if (outcome.payout) {
    dispatchEmail(
      sendDeliveryConfirmedEmail(
        { email: outcome.payout.seller.email, name: outcome.payout.seller.name },
        { auctionTitle: outcome.payout.auctionTitle, finalAmount: outcome.payout.finalAmount, auto: false },
      ),
      `delivery-confirmed (${outcome.transactionId})`,
    );
  }
  dispatchEmail(
    sendDisputeResolvedEmail(outcome.buyer, outcome.seller, {
      auctionTitle: outcome.auctionTitle,
      resolution: 'RELEASED',
      note,
    }),
    `dispute-resolved-released (${outcome.transactionId})`,
  );
  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------
// Timeout sweep (BV-040): SHIPPED rows whose reviewTimeoutHours has elapsed with no open
// dispute auto-confirm, same as if the buyer had clicked confirm-receipt themselves.
// ---------------------------------------------------------------------------

export async function findTimedOutShipments(): Promise<string[]> {
  const { reviewTimeoutHours } = await getPlatformSettings();
  const cutoff = new Date(Date.now() - reviewTimeoutHours * 60 * 60 * 1000);

  const rows = await prisma.auctionTransaction.findMany({
    where: { status: 'SHIPPED', shippedAt: { lt: cutoff } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
