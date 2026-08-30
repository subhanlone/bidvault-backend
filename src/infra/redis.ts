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
 * Settings cache invalidation (BV-025) — each process (API server, worker) caches
 * `PlatformSetting` in module scope for 10s. Without this, the settings PUT only clears the
 * cache of whichever process served it; every other process keeps answering with the old
 * values for up to 10s, so e.g. maintenanceMode can appear on in one process and off in
 * another. Publishing needs a bounded client, same reasoning as the auction-state overlay
 * above: it fires from the PUT /settings request path and must not hang if Redis is down.
 * Subscribing needs its OWN separate connection — ioredis puts a client that issues SUBSCRIBE
 * into subscriber mode, where it can no longer run ordinary commands, so it cannot be shared
 * with the publisher or anything else. The subscriber is a background listener nobody awaits;
 * a missed message during a reconnect just means that process falls back to the TTL, which is
 * the existing acceptable-interim behaviour, not a new failure mode.
 */
export const SETTINGS_INVALIDATE_CHANNEL = 'settings:invalidate';

let settingsPublishClient: Redis | undefined;

export function getSettingsPublishRedis(): Redis {
  settingsPublishClient ??= (() => {
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      commandTimeout: 2_000,
      enableReadyCheck: false,
    });
    client.on('error', (err) =>
      console.error('[redis:settings-publish] Connection error:', err.message),
    );
    return client;
  })();
  return settingsPublishClient;
}

let settingsSubscribeClient: Redis | undefined;

export function getSettingsSubscribeRedis(): Redis {
  settingsSubscribeClient ??= (() => {
    const client = new Redis(env.REDIS_URL, { enableReadyCheck: false });
    client.on('error', (err) =>
      console.error('[redis:settings-subscribe] Connection error:', err.message),
    );
    return client;
  })();
  return settingsSubscribeClient;
}
