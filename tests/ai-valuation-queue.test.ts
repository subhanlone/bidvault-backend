/**
 * Agentic AI PR 2: the `ai-valuation` BullMQ queue. One job per auction at a time (a second request
 * while one waits adds nothing), and a NEW job once the last one has finished: BullMQ silently ignores
 * add() for a jobId it still holds in its completed or failed set, which would make every 6-hour
 * refresh a no-op (the Codex finding on the plan). Real Redis (the test instance), a real Worker.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Worker } from 'bullmq';

const { env } = await import('../src/config/env.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { aiValuationQueue, enqueueAiValuation, AI_VALUATION_QUEUE } = await import('../src/queues/ai-valuation.queue.js');

beforeEach(async () => {
  await aiValuationQueue.obliterate({ force: true });
});

afterAll(async () => {
  await aiValuationQueue.obliterate({ force: true });
  await aiValuationQueue.close();
  redisConnection.disconnect();
});

describe('enqueueAiValuation', () => {
  it('adds one job, and a second request while it waits adds nothing', async () => {
    expect(await enqueueAiValuation('auction-1')).toBe(true);
    expect(await enqueueAiValuation('auction-1')).toBe(false);
    expect((await aiValuationQueue.getJobCounts('waiting')).waiting).toBe(1);
  });

  it('keeps auctions apart', async () => {
    await enqueueAiValuation('auction-1');
    await enqueueAiValuation('auction-2');
    expect((await aiValuationQueue.getJobCounts('waiting')).waiting).toBe(2);
  });

  it('adds a fresh job once the previous one for that auction has finished', async () => {
    await enqueueAiValuation('auction-1');
    const worker = new Worker(AI_VALUATION_QUEUE, () => Promise.resolve(), { connection: redisConnection, prefix: env.QUEUE_PREFIX });
    const done = new Promise<void>((resolve) => worker.on('completed', () => resolve()));
    await done;
    await worker.close();

    expect(await enqueueAiValuation('auction-1')).toBe(true);
    const job = await aiValuationQueue.getJob('ai:valuate:auction-1');
    expect(await job?.getState()).toBe('waiting');
  });
});
