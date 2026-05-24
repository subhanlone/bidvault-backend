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
      if (auction.status !== AuctionStatus.CLOSED) {
        const winningBid = await prisma.bid.findFirst({
          where: { auctionId: auction.id },
          orderBy: { amount: 'desc' },
          include: { buyer: true },
        });

        await prisma.$transaction(async (tx) => {
          await tx.auction.update({
            where: { id: auction.id },
            data: { status: AuctionStatus.CLOSED },
          });

          if (winningBid) {
            await tx.auctionTransaction.create({
              data: {
                auctionId: auction.id,
                winnerId: winningBid.buyerId,
                sellerId: auction.sellerId,
                finalAmount: winningBid.amount,
                status: 'PENDING',
              },
            });
          }
        });

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
