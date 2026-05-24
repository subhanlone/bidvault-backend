import { Queue } from 'bullmq';
import { redisConnection } from '../infra/redis.js';

export type AuctionLifecycleJobName = 'auction:start' | 'auction:end';

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

export async function scheduleAuctionLifecycle(params: {
  auctionId: string;
  startTime: Date;
  endTime: Date;
}): Promise<void> {
  const now = Date.now();
  const startDelay = Math.max(0, params.startTime.getTime() - now);
  const endDelay = Math.max(0, params.endTime.getTime() - now);

  await auctionLifecycleQueue.add(
    'auction:start',
    { auctionId: params.auctionId },
    { delay: startDelay, jobId: `auction:start:${params.auctionId}` },
  );
  await auctionLifecycleQueue.add(
    'auction:end',
    { auctionId: params.auctionId },
    { delay: endDelay, jobId: `auction:end:${params.auctionId}` },
  );
}
