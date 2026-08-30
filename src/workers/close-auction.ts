import { AuctionStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { sendAuctionEndedEmail, sendReserveNotMetEmail } from '../services/email.service.js';

/**
 * Closes one auction: decides the outcome, writes it, and tells both parties.
 *
 * This lives apart from auction-lifecycle.worker.ts, which does nothing but hand jobs to it,
 * for the same reason openapi/requests.ts lives apart from the routes: importing the worker
 * constructs a real BullMQ Worker, which connects to Redis and starts consuming. A test that
 * imported it would join the queue. Here there is nothing to join.
 *
 * That matters because this is where BUG-15 lived — the reserve price was collected, stored,
 * displayed as "Auction won't close below this amount", and never compared against anything.
 * An auction closed 17% under its floor, declared a winner and invoiced them. The rule below
 * is the fix, and until now nothing tested it.
 */

export interface CloseResult {
  /** Another worker got there first; nothing was written. */
  alreadyClosed: boolean;
  /** null when no reserve was set, otherwise whether the top bid cleared it. */
  reserveMet: boolean | null;
  /** True when an AuctionTransaction was created — i.e. something is owed. */
  sold: boolean;
}

export async function closeAuction(auctionId: string): Promise<CloseResult> {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: { seller: true },
  });

  if (!auction) return { alreadyClosed: false, reserveMet: null, sold: false };

  // NEW-09: the winning bid is read inside the transaction under a FOR UPDATE lock, so two
  // retries cannot both see status=ACTIVE and create duplicate transactions.
  const txResult = await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM "Auction" WHERE id = ${auction.id} FOR UPDATE
    `;
    if (!locked || locked.status === 'CLOSED') {
      return { alreadyClosed: true, winningBid: null, notifyWinner: false, reserveMet: null };
    }

    const winBid = await tx.bid.findFirst({
      where: { auctionId: auction.id },
      orderBy: { amount: 'desc' },
      include: { buyer: true },
    });

    // The reserve is the seller's floor — the create-listing form promises "Auction won't close
    // below this amount". An auction that ends under it closes UNSOLD: no winner is declared and
    // no AuctionTransaction is created, so nothing is ever owed.
    const reserveMet =
      auction.reservePrice === null ? null : (winBid?.amount ?? 0) >= auction.reservePrice;

    await tx.auction.update({
      where: { id: auction.id },
      data: { status: AuctionStatus.CLOSED, reserveMet },
    });

    let notifyWinner = true;
    if (winBid && reserveMet === false) {
      // Bids were placed but the top one was under the floor. Both sides need telling: the
      // seller that it did not sell, and the top bidder that no invoice is coming. The bidder's
      // alert is not gated on notifyWins — it corrects an expectation rather than announcing a win.
      await tx.notification.createMany({
        data: [
          {
            userId: auction.sellerId,
            type: 'RESERVE_NOT_MET',
            title: 'Auction ended below your reserve',
            message: `"${auction.title}" ended at PKR ${winBid.amount.toLocaleString()}, below your reserve of PKR ${auction.reservePrice!.toLocaleString()}. The item was not sold.`,
          },
          {
            userId: winBid.buyerId,
            type: 'RESERVE_NOT_MET',
            title: 'Reserve price not met',
            message: `You were the highest bidder on "${auction.title}" at PKR ${winBid.amount.toLocaleString()}, but the seller's reserve was not met, so the item was not sold. No payment is due.`,
          },
        ],
      });
    } else if (winBid) {
      // Respect the winner's notification preference for the in-app AUCTION_WON alert + win email.
      const winnerPrefs = await tx.user.findUnique({
        where: { id: winBid.buyerId },
        select: { notifyWins: true },
      });
      notifyWinner = winnerPrefs?.notifyWins ?? true;

      await tx.auctionTransaction.create({
        data: {
          auctionId: auction.id,
          winnerId: winBid.buyerId,
          sellerId: auction.sellerId,
          finalAmount: winBid.amount,
          status: 'PENDING',
        },
      });

      if (notifyWinner) {
        await tx.notification.create({
          data: {
            userId: winBid.buyerId,
            type: 'AUCTION_WON',
            title: 'You won the auction!',
            message: `Congratulations! You won "${auction.title}" with a bid of PKR ${winBid.amount.toLocaleString()}. Complete your payment to claim it.`,
          },
        });
      }
    }

    return { alreadyClosed: false, winningBid: winBid ?? null, notifyWinner, reserveMet };
  });

  if (txResult.alreadyClosed) {
    return { alreadyClosed: true, reserveMet: null, sold: false };
  }

  const winningBid = txResult.winningBid;
  const sold = winningBid !== null && txResult.reserveMet !== false;

  // These two stay awaited, unlike the sends in the HTTP routes. Nothing is waiting on a
  // response here, and letting the job own the send means a failure is visible as a job
  // failure rather than a log line nobody reads.
  if (winningBid && txResult.reserveMet === false) {
    await sendReserveNotMetEmail(
      { email: auction.seller.email, name: auction.seller.name },
      {
        title: auction.title,
        reservePrice: auction.reservePrice!,
        bidCount: auction.bidCount,
      },
      { email: winningBid.buyer.email, name: winningBid.buyer.name, amount: winningBid.amount },
    );
    return { alreadyClosed: false, reserveMet: txResult.reserveMet, sold };
  }

  await sendAuctionEndedEmail(
    { email: auction.seller.email, name: auction.seller.name },
    { title: auction.title, finalBid: auction.currentBid, bidCount: auction.bidCount },
    winningBid
      ? { email: winningBid.buyer.email, name: winningBid.buyer.name, amount: winningBid.amount }
      : null,
    txResult.notifyWinner,
  );

  return { alreadyClosed: false, reserveMet: txResult.reserveMet, sold };
}
