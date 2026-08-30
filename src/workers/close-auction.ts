import { AuctionStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { dispatchEmail, sendAuctionEndedEmail, sendReserveNotMetEmail } from '../services/email.service.js';

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

    // BV-018: buyerId is nullable now (a deleted buyer's bid is anonymised in place, not
    // cascaded away, so bidCount/currentBid stay accurate). A bid with no buyer left can't be
    // awarded a transaction -- there is no winnerId to write -- so it is excluded here rather
    // than filtered out after the fact, and the next real bidder wins instead.
    const rawWinBid = await tx.bid.findFirst({
      where: { auctionId: auction.id, buyerId: { not: null } },
      orderBy: { amount: 'desc' },
      include: { buyer: true },
    });
    // The where-filter above guarantees buyerId/buyer are non-null whenever a row comes back;
    // Prisma's generated type doesn't encode that, so narrow once here instead of asserting at
    // every later use of winBid.buyerId / winBid.buyer.
    const winBid = rawWinBid && rawWinBid.buyerId !== null && rawWinBid.buyer !== null
      ? { ...rawWinBid, buyerId: rawWinBid.buyerId, buyer: rawWinBid.buyer }
      : null;

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

  // Not awaited (BV-012): concurrency:10 lets ten close jobs run in parallel, but each job's
  // own two awaited sends still serialised its slot for ~3.3s of measured Resend latency.
  // dispatchEmail matches what the HTTP routes already do -- fire-and-forget, failure logged
  // rather than swallowed. A retried job would not resend it anyway: the FOR UPDATE check
  // above returns early once status is CLOSED, before this point is ever reached again, so
  // awaiting here never actually bought a retry of the email -- only of the job wrapper.
  if (winningBid && txResult.reserveMet === false) {
    dispatchEmail(
      sendReserveNotMetEmail(
        { email: auction.seller.email, name: auction.seller.name },
        {
          title: auction.title,
          reservePrice: auction.reservePrice!,
          bidCount: auction.bidCount,
        },
        { email: winningBid.buyer.email, name: winningBid.buyer.name, amount: winningBid.amount },
      ),
      `reserve-not-met (${auction.id})`,
    );
    return { alreadyClosed: false, reserveMet: txResult.reserveMet, sold };
  }

  dispatchEmail(
    sendAuctionEndedEmail(
      { email: auction.seller.email, name: auction.seller.name },
      { title: auction.title, finalBid: auction.currentBid, bidCount: auction.bidCount },
      winningBid
        ? { email: winningBid.buyer.email, name: winningBid.buyer.name, amount: winningBid.amount }
        : null,
      txResult.notifyWinner,
    ),
    `auction-ended (${auction.id})`,
  );

  return { alreadyClosed: false, reserveMet: txResult.reserveMet, sold };
}
