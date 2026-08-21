import { Worker } from 'bullmq';
import { redisConnection } from '../infra/redis.js';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import {
  enqueueAuctionEndNow,
  type AuctionLifecycleJobData,
  type AuctionLifecycleJobName,
} from '../queues/auction-lifecycle.queue.js';
import { closeAuction } from './close-auction.js';

// The close logic itself lives in ./close-auction.ts, which imports no BullMQ and opens no
// connection — so it can be tested without joining the queue. This file is only the plumbing.
const worker = new Worker<AuctionLifecycleJobData, unknown, AuctionLifecycleJobName>(
  'auction-lifecycle',
  async (job) => {
    await closeAuction(job.data.auctionId);
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
