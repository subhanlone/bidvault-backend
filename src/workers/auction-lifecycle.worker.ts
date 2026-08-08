import { Worker } from 'bullmq';
import { AuctionStatus } from '@prisma/client';
import { redisConnection } from '../infra/redis.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import {
  enqueueAuctionEndNow,
  type AuctionLifecycleJobData,
  type AuctionLifecycleJobName,
} from '../queues/auction-lifecycle.queue.js';
import { sendAuctionEndedEmail, sendReserveNotMetEmail } from '../services/email.service.js';

const worker = new Worker<AuctionLifecycleJobData, unknown, AuctionLifecycleJobName>(
  'auction-lifecycle',
  async (job) => {
    const auction = await prisma.auction.findUnique({
      where: { id: job.data.auctionId },
      include: { seller: true },
    });

    if (!auction) {
      return;
    }

    // Only 'auction:end' is scheduled (auctions launch ACTIVE on approval).
    // NEW-09: fetch winningBid inside the transaction under a FOR UPDATE lock
    // to prevent a race where two retries both read status=ACTIVE and create duplicate transactions.
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

    if (txResult.alreadyClosed) return;
    const winningBid = txResult.winningBid;

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
      return;
    }

    await sendAuctionEndedEmail(
      { email: auction.seller.email, name: auction.seller.name },
      { title: auction.title, finalBid: auction.currentBid, bidCount: auction.bidCount },
      winningBid
        ? { email: winningBid.buyer.email, name: winningBid.buyer.name, amount: winningBid.amount }
        : null,
      txResult.notifyWinner,
    );
  },
  {
    connection: redisConnection,
    prefix: env.QUEUE_PREFIX,
  },
);

worker.on('completed', (job) => {
  console.log(`Auction lifecycle job completed: ${job.name} (${job.id})`);
});

worker.on('failed', (job, error) => {
  console.error(`Auction lifecycle job failed: ${job?.name} (${job?.id})`, error);
});

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Safety net for auctions that are past their end time but still ACTIVE.
 *
 * The scheduled job is the happy path, but it can be missing entirely: rows
 * written straight to the database bypass the approval route that schedules it,
 * and listings.routes.ts deliberately swallows scheduling errors so an approval
 * still succeeds when Redis is briefly unavailable. Without this sweep any such
 * auction stays open forever, because the API serves the stored status and
 * nothing else ever re-checks endTime.
 *
 * Re-queuing is safe to repeat: the job closes the auction inside a transaction
 * that takes a FOR UPDATE lock and returns early when the row is already CLOSED.
 */
let sweepInFlight = false;

async function reconcileOverdueAuctions(): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;

  try {
    const overdue = await prisma.auction.findMany({
      where: { status: 'ACTIVE', endTime: { lt: new Date() } },
      select: { id: true },
    });

    if (overdue.length === 0) return;

    let requeued = 0;
    for (const auction of overdue) {
      try {
        if (await enqueueAuctionEndNow(auction.id)) requeued += 1;
      } catch (error) {
        console.error(`[reconcile] Failed to re-queue auction ${auction.id}:`, error);
      }
    }

    console.log(
      `[reconcile] ${overdue.length} overdue auction(s) still ACTIVE; re-queued ${requeued}, ${overdue.length - requeued} already pending.`,
    );
  } catch (error) {
    console.error('[reconcile] Sweep failed:', error);
  } finally {
    sweepInFlight = false;
  }
}

const reconcileTimer = setInterval(() => void reconcileOverdueAuctions(), RECONCILE_INTERVAL_MS);
reconcileTimer.unref();

async function shutdown() {
  clearInterval(reconcileTimer);
  await worker.close();
  await prisma.$disconnect();
  await redisConnection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

console.log(`Auction lifecycle worker started (queue prefix: ${env.QUEUE_PREFIX}).`);
void reconcileOverdueAuctions();
