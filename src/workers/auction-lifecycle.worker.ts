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
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_INTERVAL_MS } from '../infra/worker-heartbeat.js';
import { subscribeToSettingsInvalidation } from '../services/settings.service.js';
import { findTimedOutShipments, confirmDelivery } from '../services/fulfillment.service.js';

// BV-025: close-auction.ts sends email through email.service.ts, which reads
// emailNotifsEnabled via getPlatformSettings() -- this process needs the same cross-process
// invalidation the API server gets, or a settings PUT there leaves this one serving a stale
// value for up to the 10s TTL.
void subscribeToSettingsInvalidation();

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
    // BV-012: the close path is already lock-safe (SELECT ... FOR UPDATE inside the
    // transaction) and idempotency-tested (a retried job writes nothing twice), so ten
    // auctions can close in parallel without racing each other. The default is 1 --
    // strictly sequential -- which meant a burst of auctions ending at the same moment (a
    // realistic case: several listings approved together with the same duration) queued
    // behind whichever one happened to be sending an email at the time.
    concurrency: 10,
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
 * Written on startup and every WORKER_HEARTBEAT_INTERVAL_MS after -- health.service.ts reads
 * its age. redisConnection directly, not a bounded client: this is a background write with
 * nobody waiting on it, exactly the case that connection's queue-forever behaviour is
 * correct for (see infra/redis.ts). A write that queues during an outage and lands once
 * Redis returns is fine; a write that silently never happens because a bounded client
 * dropped it is the opposite of what a liveness signal needs.
 */
function writeHeartbeat(): void {
  void redisConnection.set(WORKER_HEARTBEAT_KEY, Date.now().toString())
    .catch((err: unknown) => console.error('[worker] heartbeat write failed', err));
}

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

    // console.error rather than .log (BV-012): a non-zero count here means the happy path
    // (the scheduled job) missed at least one auction, which is exactly the failure this
    // sweep exists to catch -- it belongs at the severity that gets someone's attention in
    // whatever aggregates these logs, not alongside routine informational lines.
    console.error(
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

/**
 * BV-040 / BV-047: the confirm-or-dispute window a SHIPPED transaction gets before receipt is
 * assumed. Same interval as the auction-close sweep above — reviewTimeoutHours is measured in
 * hours, so checking it every 5 minutes is more than fine-grained enough, and reusing the
 * interval means no second timer to reason about.
 *
 * confirmDelivery() is the same function the buyer's own confirm-receipt route calls; a
 * transaction this sweep picks up twice (a slow run overlapping the next tick) simply finds
 * the row already DELIVERED on the second pass and returns 'wrong-state', doing nothing.
 */
let fulfillmentSweepInFlight = false;

async function autoConfirmTimedOutShipments(): Promise<void> {
  if (fulfillmentSweepInFlight) return;
  fulfillmentSweepInFlight = true;

  try {
    const overdue = await findTimedOutShipments();
    if (overdue.length === 0) return;

    for (const transactionId of overdue) {
      const result = await confirmDelivery(transactionId, { auto: true });
      if (result.kind !== 'ok') {
        console.error(`[fulfillment-sweep] auto-confirm failed for ${transactionId}: ${result.kind}`);
      }
    }

    console.log(`[fulfillment-sweep] auto-confirmed ${overdue.length} timed-out shipment(s).`);
  } catch (error) {
    console.error('[fulfillment-sweep] Sweep failed:', error);
  } finally {
    fulfillmentSweepInFlight = false;
  }
}

const fulfillmentSweepTimer = setInterval(() => void autoConfirmTimedOutShipments(), RECONCILE_INTERVAL_MS);
fulfillmentSweepTimer.unref();

const heartbeatTimer = setInterval(writeHeartbeat, WORKER_HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();

async function shutdown() {
  clearInterval(reconcileTimer);
  clearInterval(fulfillmentSweepTimer);
  clearInterval(heartbeatTimer);
  await worker.close();
  await prisma.$disconnect();
  await redisConnection.quit();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

console.log(`Auction lifecycle worker started (queue prefix: ${env.QUEUE_PREFIX}).`);
writeHeartbeat();
void reconcileOverdueAuctions();
void autoConfirmTimedOutShipments();
