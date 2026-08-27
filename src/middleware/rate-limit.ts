import type { Request, Response } from 'express';
import { ipKeyGenerator, MemoryStore, rateLimit, type Store } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { getRateLimitRedis } from '../infra/redis.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Every store handed to a limiter, so the suite can clear them between tests.
 *
 * Limiter state is process-global and deliberately outlives a request, which means it also
 * outlives a test. Without a way to clear it, whether a test passes depends on how many
 * requests the tests before it happened to make — `resend-verification` returning 429 because
 * three earlier cases had already spent the per-address budget is exactly that failure, and it
 * is indistinguishable from a real regression until you go looking.
 */
const stores: Store[] = [];

/**
 * Clears every limiter's counters. Test-only; see tests/helpers/world.ts.
 *
 * Sequential rather than Promise.all because `resetAll` is optional and may return void — the
 * aggregate would be handed a mix of promises and undefined, which is exactly what
 * `await-thenable` objects to and is not worth the parallelism on a handful of in-memory maps.
 */
export async function resetRateLimits(): Promise<void> {
  for (const store of stores) await store.resetAll?.();
}

function storeFor(name: string): Store {
  // The store is always constructed here rather than left to rateLimit()'s own default,
  // because the middleware it returns does not expose the store it chose — and without a
  // reference there is nothing for resetRateLimits() to clear.
  //
  // Tests get a process-local MemoryStore. Production uses Redis so limits hold across API
  // replicas; development also uses Redis so local behaviour matches the deployment rather
  // than quietly diverging from it.
  if (env.NODE_ENV === 'test') return new MemoryStore();

  const client = getRateLimitRedis();
  return new RedisStore({
    prefix: `bidvault:rate-limit:${env.NODE_ENV}:${name}:`,
    sendCommand: (command: string, ...args: string[]) =>
      client.call(command, ...args) as Promise<RedisReply>,
  });
}

function keyByIp(req: Request): string {
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
}

function keyByEmail(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'invalid';
  return email;
}

function tooMany(res: Response, message: string): void {
  res.status(429).json({ success: false, error: message });
}

function makeLimiter(params: {
  name: string;
  windowMs: number;
  limit: number;
  keyGenerator?: (req: Request) => string;
  message: string;
  skip?: (req: Request) => boolean;
}) {
  const store = storeFor(params.name);
  stores.push(store);

  return rateLimit({
    windowMs: params.windowMs,
    limit: params.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: params.keyGenerator,
    handler: (_req, res) => tooMany(res, params.message),
    ...(params.skip && { skip: params.skip }),
    // A Redis outage must not turn the limiter into a platform outage. This is only true
    // because getRateLimitRedis() rejects on an outage rather than queueing — see the note
    // in infra/redis.ts. The global and route-specific controls fail open; the OTP attempt
    // counters, which are the control that actually bounds the OTP keyspace, are in SQL and
    // are unaffected.
    passOnStoreError: true,
    store,
  });
}

export const globalRateLimit = makeLimiter({
  name: 'global',
  windowMs: MINUTE,
  limit: 300,
  keyGenerator: keyByIp,
  message: 'Too many requests. Please try again shortly.',
  // Stripe delivers webhooks from a small pool of addresses, so every event for every seller
  // shares one key. A 429 is retried, so nothing is lost, but the retry storm would arrive
  // while the original burst is still counted — and payment completion is the one path where
  // delay is least acceptable. The endpoint authenticates by signature, so it is not open.
  skip: (req) => req.path === '/api/v1/payments/webhook',
});

export const loginIpRateLimit = makeLimiter({
  name: 'login-ip',
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: keyByIp,
  message: 'Too many login attempts. Please try again later.',
});

export const loginEmailRateLimit = makeLimiter({
  name: 'login-email',
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: keyByEmail,
  message: 'Too many login attempts. Please try again later.',
});

// Shared by forgot-password and resend-verification, so alternating endpoints does not
// double the allowance.
export const authEmailIpRateLimit = makeLimiter({
  name: 'auth-email-ip',
  windowMs: HOUR,
  limit: 10,
  keyGenerator: keyByIp,
  message: 'Too many email requests. Please try again later.',
});

export const authEmailAddressRateLimit = makeLimiter({
  name: 'auth-email-address',
  windowMs: HOUR,
  limit: 3,
  keyGenerator: keyByEmail,
  message: 'Too many email requests. Please try again later.',
});

export const uploadSignatureRateLimit = makeLimiter({
  name: 'upload-signature-user',
  windowMs: HOUR,
  limit: 10,
  keyGenerator: (req) => req.auth?.userId ?? keyByIp(req),
  message: 'Too many upload requests. Please try again later.',
});
