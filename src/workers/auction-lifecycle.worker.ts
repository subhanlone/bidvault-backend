import { Worker } from 'bullmq';
import { AuctionStatus } from '@prisma/client';
import { redisConnection } from '../infra/redis.js';
import { prisma } from '../db/prisma.js';
import type { AuctionLifecycleJobData, AuctionLifecycleJobName } from '../queues/auction-lifecycle.queue.js';
import { triggerN8nWorkflow } from '../services/n8n.service.js';

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

    if (job.name === 'auction:start') {
      if (auction.status === AuctionStatus.SCHEDULED && auction.startTime <= new Date()) {
        await prisma.auction.update({
          where: { id: auction.id },
          data: { status: AuctionStatus.ACTIVE },
        });

        await triggerN8nWorkflow('auction.started', {
          auctionId: auction.id,
          listingId: auction.listingId,
          title: auction.title,
          startedAt: new Date().toISOString(),
          sellerName: auction.seller.name,
          sellerEmail: auction.seller.email,
        });
      }
      return;
    }

    if (job.name === 'auction:end') {
      // NEW-09: fetch winningBid inside the transaction under a FOR UPDATE lock
      // to prevent a race where two retries both read status=ACTIVE and create duplicate transactions.
      const txResult = await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM "Auction" WHERE id = ${auction.id} FOR UPDATE
        `;
        if (!locked || locked.status === 'CLOSED') return { alreadyClosed: true, winningBid: null };

        const winBid = await tx.bid.findFirst({
          where: { auctionId: auction.id },
          orderBy: { amount: 'desc' },
          include: { buyer: true },
        });

        await tx.auction.update({
          where: { id: auction.id },
          data: { status: AuctionStatus.CLOSED },
        });

        if (winBid) {
          await tx.auctionTransaction.create({
            data: {
              auctionId: auction.id,
              winnerId: winBid.buyerId,
              sellerId: auction.sellerId,
              finalAmount: winBid.amount,
              status: 'PENDING',
            },
          });

          await tx.notification.create({
            data: {
              userId: winBid.buyerId,
              type: 'AUCTION_WON',
              title: 'You won the auction!',
              message: `Congratulations! You won "${auction.title}" with a bid of PKR ${winBid.amount.toLocaleString()}. Complete your payment to claim it.`,
            },
          });
        }

        return { alreadyClosed: false, winningBid: winBid ?? null };
      });

      if (txResult.alreadyClosed) return;
      const winningBid = txResult.winningBid;

      await triggerN8nWorkflow('auction.ended', {
        auctionId: auction.id,
        listingId: auction.listingId,
        title: auction.title,
        endedAt: new Date().toISOString(),
        finalBid: auction.currentBid,
        bidCount: auction.bidCount,
        sellerName: auction.seller.name,
        sellerEmail: auction.seller.email,
        winnerId: winningBid?.buyerId ?? null,
        winnerName: winningBid?.buyer.name ?? null,
        winnerEmail: winningBid?.buyer.email ?? null,
        finalAmount: winningBid?.amount ?? null,
      });
    }
  },
  {
    connection: redisConnection,
  },
);

worker.on('completed', (job) => {
  console.log(`Auction lifecycle job completed: ${job.name} (${job.id})`);
});

worker.on('failed', (job, error) => {
  console.error(`Auction lifecycle job failed: ${job?.name} (${job?.id})`, error);
});

async function shutdown() {
  await worker.close();
  await prisma.$disconnect();
  await redisConnection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

console.log('Auction lifecycle worker started.');
