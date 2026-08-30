import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * The BullMQ connection.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: its blocking commands (BRPOPLPUSH and
 * friends) sit open for minutes at a time, and a retry ceiling would abort them. The cost is
 * that a command issued while Redis is unreachable waits in the offline queue indefinitely
 * rather than rejecting — correct for a background worker that has nobody waiting on it, and
 * wrong for anything on the request path. Hence the separate client below.
 */
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on('connect', () => console.log('[redis] Connected'));
redisConnection.on('error', (err) => console.error('[redis] Connection error:', err.message));

/**
 * The rate limiter's connection, which must fail rather than wait.
 *
 * express-rate-limit awaits the store on every request, so the store's failure mode becomes the
 * API's failure mode. Sharing `redisConnection` looked free and was not: with
 * `maxRetriesPerRequest: null` and an offline queue, a command issued during a Redis outage is
 * queued and never settles. `passOnStoreError` cannot fire on a promise that never rejects, so
 * the limiter — mounted globally — would hang every request to every route for as long as Redis
 * stayed down. Measured, not theorised: still pending after six seconds, held in the offline
 * queue.
 *
 * `maxRetriesPerRequest: 1` is what fixes that. Once the retry budget is spent ioredis flushes
 * the offline queue with an error, so a command during an outage rejects in well under a second
 * instead of waiting — and a rejection is exactly what `passOnStoreError: true` needs in order
 * to fail open. `commandTimeout` is the backstop for the other shape of failure, where the
 * socket is open and the server simply never answers.
 *
 * The offline queue stays ENABLED, which is not the obvious choice and is load-bearing.
 * RedisStore.init() runs synchronously while rateLimit() is being constructed at module load,
 * before the socket can possibly be ready, and it issues SCRIPT LOAD. With the queue disabled
 * that call is refused instantly — "Stream isn't writeable" — the increment script never loads,
 * every later increment fails too, and the limiter fails open permanently while looking
 * perfectly healthy. Measured against a live server: twelve login attempts, no 429, no
 * RateLimit headers, and not one key written to Redis.
 *
 * Timings behind the numbers below, against this deployment's Redis:
 *   startup, command issued at construction   1718ms  resolved
 *   steady state, already connected            169ms  resolved
 *   outage, closed port                      65-269ms rejected
 * Hence 5s: comfortably above connection setup, and far below anything a caller would call a
 * hang. Only the first command after a cold start can approach it.
 *
 * Created on first use rather than at import. The test suite uses a MemoryStore (see
 * middleware/rate-limit.ts), and constructing eagerly would open a socket in every test process
 * that nothing then closes.
 */
let rateLimitClient: Redis | undefined;

export function getRateLimitRedis(): Redis {
  rateLimitClient ??= (() => {
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      commandTimeout: 5_000,
      enableReadyCheck: false,
    });
    // Without a listener ioredis treats a connection error as an unhandled 'error' event, which
    // is fatal. The limiter is expected to survive Redis being down, so this must never throw.
    client.on('error', (err) =>
      console.error('[redis:rate-limit] Connection error:', err.message),
    );
    return client;
  })();
  return rateLimitClient;
}

/**
 * The auction-state overlay's connection (BV-010) — same reasoning as the rate limiter's
 * above, and the same mistake it was written to avoid: the overlay used to share
 * `redisConnection`, so a command issued from a bid request during a Redis outage queued
 * forever instead of rejecting, and the caller awaited it. Nobody should be sharing the
 * BullMQ connection for anything on the request path; this is the second thing that was.
 */
let auctionStateClient: Redis | undefined;

export function getAuctionStateRedis(): Redis {
  auctionStateClient ??= (() => {
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      commandTimeout: 2_000,
      enableReadyCheck: false,
    });
    // The overlay is a best-effort cache, not a control something else depends on being up —
    // an outage here must not become an unhandled 'error' event and take the process down.
    client.on('error', (err) =>
      console.error('[redis:auction-state] Connection error:', err.message),
    );
    return client;
  })();
  return auctionStateClient;
}
