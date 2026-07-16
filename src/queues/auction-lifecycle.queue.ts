import { Queue } from 'bullmq';
import { redisConnection } from '../infra/redis.js';

export type AuctionLifecycleJobName = 'auction:end';

export interface AuctionLifecycleJobData {
  auctionId: string;
}

export const auctionLifecycleQueue = new Queue<AuctionLifecycleJobData, unknown, AuctionLifecycleJobName>(
  'auction-lifecycle',
  {
    connection: redisConnection,
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
