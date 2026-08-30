import { prisma } from '../db/prisma.js';
import { redisConnection } from '../infra/redis.js';

/**
 * Dependency probes for GET /health.
 *
 * Every probe is raced against a timeout, which is not defensive padding — ioredis is
 * constructed with `maxRetriesPerRequest: null`, so when Redis is unreachable a command does
 * not fail, it queues forever. Without the race, an unreachable Redis would hang the health
 * endpoint rather than report Redis as down, which is precisely backwards.
 */

const PROBE_TIMEOUT_MS = 2_000;

export type ProbeState = 'up' | 'down';

export interface Probe {
  state: ProbeState;
  /** Round-trip in milliseconds. Present even on failure — it is the time to give up. */
  latencyMs: number;
}

/**
 * Exported for its own test: the timeout is the part that matters and the disconnect-based
 * test cannot reach it, because a disconnected ioredis client rejects immediately rather
 * than queueing. Only a probe that never settles exercises the race.
 */
export async function probe(run: () => Promise<unknown>): Promise<Probe> {
  const started = Date.now();
  // BV-051: the race's loser doesn't stop running. On the common path -- the dependency
  // answers well inside the timeout -- run() settles first and this timer was never
  // cancelled, left to fire up to PROBE_TIMEOUT_MS later for a race Promise.race had already
  // decided. Harmless in isolation, but /health is polled continuously, so every fast check
  // held a live timer open behind it. server.ts's graceful shutdown waits for exactly this
  // kind of handle to close on its own before Node can exit.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
      }),
    ]);
    return { state: 'up', latencyMs: Date.now() - started };
  } catch {
    return { state: 'down', latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Cheapest possible round trip that proves the connection pool works. */
export const probeDatabase = (): Promise<Probe> => probe(() => prisma.$queryRaw`SELECT 1`);

export const probeRedis = (): Promise<Probe> => probe(() => redisConnection.ping());
