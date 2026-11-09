import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { redisConnection } from '../infra/redis.js';

/** The agentic valuation runs here, in the worker process, never inside a page request. */
export const AI_VALUATION_QUEUE = 'ai-valuation';

export type AiValuationJobName = 'ai:valuate';

export interface AiValuationJobData {
  auctionId: string;
}

export const aiValuationQueue = new Queue<AiValuationJobData, unknown, AiValuationJobName>(AI_VALUATION_QUEUE, {
  connection: redisConnection,
  prefix: env.QUEUE_PREFIX,
  defaultJobOptions: {
    // runAiValuation records every business outcome itself (READY, INSUFFICIENT_DATA, FAILED); only
    // a database failure escapes, and one retry a minute later covers a blip.
    attempts: 2,
    backoff: { type: 'fixed', delay: 60_000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

const jobIdFor = (auctionId: string) => `ai:valuate:${auctionId}`;

/**
 * Asks for a valuation run. True when a job was added; false when one for this auction is already
 * waiting or running (so many viewers of one page start one run).
 *
 * BullMQ ignores add() for a jobId it still keeps in its completed or failed set, which would make
 * every later refresh a silent no-op; a finished job is removed first (the same fix as
 * enqueueAuctionEndNow in auction-lifecycle.queue.ts).
 */
export async function enqueueAiValuation(auctionId: string): Promise<boolean> {
  const jobId = jobIdFor(auctionId);
  const existing = await aiValuationQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') return false;
    await existing.remove();
  }
  await aiValuationQueue.add('ai:valuate', { auctionId }, { jobId });
  return true;
}
