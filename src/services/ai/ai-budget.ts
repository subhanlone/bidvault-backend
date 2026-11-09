import { env } from '../../config/env.js';
import { redisConnection } from '../../infra/redis.js';

/**
 * How many valuation runs a day. A run is one eBay search and an agent of usually two model calls
 * (choose, then answer), three to four with the web fallback. Groq's free plan allows 1,000 requests a
 * day per model (checked 2026-11-09), so 200 runs stay well inside it with room for retries and the
 * 20b fallback. Groq's rate-limit headers only show the per-minute figures, never the daily one, so
 * this counter is the only way to stop before the day's quota runs out rather than after.
 */
export const AI_DAILY_RUNS = 200;

const DAY_SECONDS = 24 * 60 * 60;
const keyFor = (day: string) => `bidvault:ai-budget:${env.NODE_ENV}:${day}`;
/** A UTC day, like Groq's daily limits. */
const today = () => new Date().toISOString().slice(0, 10);

/** Takes one run from today's budget: true if it was available, false once the day's budget is spent. */
export async function spendAiRun(): Promise<boolean> {
  const key = keyFor(today());
  const used = await redisConnection.incr(key);
  // Kept a little past the day so a run near midnight still sees its own count.
  if (used === 1) await redisConnection.expire(key, DAY_SECONDS + 3_600);
  return used <= AI_DAILY_RUNS;
}

/** Test-only: forgets today's count. */
export async function resetAiBudget(): Promise<void> {
  await redisConnection.del(keyFor(today()));
}
