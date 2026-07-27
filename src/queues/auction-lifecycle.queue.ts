import { Queue } from 'bullmq';
import { redisConnection } from '../infra/redis.js';
import { env } from '../config/env.js';

export type AuctionLifecycleJobName = 'auction:end';

export interface AuctionLifecycleJobData {
  auctionId: string;
}

export const auctionLifecycleQueue = new Queue<AuctionLifecycleJobData, unknown, AuctionLifecycleJobName>(
  'auction-lifecycle',
  {
    connection: redisConnection,
    prefix: env.QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: 500,
      removeOnFail: 1000,
    },
  },
);

// Auctions go ACTIVE the moment a listing is approved, so only the end job is scheduled.
export async function scheduleAuctionLifecycle(params: {
  auctionId: string;
  endTime: Date;
}): Promise<void> {
  const endDelay = Math.max(0, params.endTime.getTime() - Date.now());

  await auctionLifecycleQueue.add(
    'auction:end',
    { auctionId: params.auctionId },
    { delay: endDelay, jobId: `auction:end:${params.auctionId}` },
  );
}

/**
 * Queues an immediate close for an auction that is already past its end time.
 *
 * Used by the reconciliation sweep to recover auctions whose scheduled job was
 * never created (e.g. rows inserted directly by a seed script) or was consumed
 * without effect. BullMQ silently ignores add() when the jobId already exists —
 * *including* in the completed/failed sets, which removeOnComplete/removeOnFail
 * retain — so a terminal job has to be cleared before re-adding, or the retry
 * would be a no-op and the auction would stay open forever. Jobs still pending
 * are left alone; they will run on their own.
 */
export async function enqueueAuctionEndNow(auctionId: string): Promise<boolean> {
  const jobId = `auction:end:${auctionId}`;
  const existing = await auctionLifecycleQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') {
      return false;
    }
    await existing.remove();
  }

  await auctionLifecycleQueue.add('auction:end', { auctionId }, { jobId });
  return true;
}
