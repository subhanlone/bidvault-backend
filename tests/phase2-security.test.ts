import express from 'express';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { hash as hashLegacy } from '@node-rs/bcrypt';
import { v2 as cloudinary } from 'cloudinary';
import { rateLimit } from 'express-rate-limit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Socket } from 'socket.io';

const mail = vi.hoisted(() => ({
  send: vi.fn(async (_message: { subject: string; html: string }) => ({
    data: { id: 'email_test' },
    error: null,
  })),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mail.send };
  },
}));

const { createApp } = await import('../src/app.js');
const { env } = await import('../src/config/env.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { errorHandler } = await import('../src/middleware/error-handler.js');
const { submitListingSchema, placeBidSchema, registerSchema, rejectListingSchema } =
  await import('../src/openapi/requests.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { consumeSubscriptionToken, registerAuctionSubscriptions } =
  await import('../src/socket/auction-subscriptions.js');
const { sendBidPlacedEmail } = await import('../src/services/email.service.js');
const { DUMMY_PASSWORD_HASH, hashPassword, needsRehash, verifyPassword } =
  await import('../src/utils/password.js');
const { resetRateLimits } = await import('../src/middleware/rate-limit.js');
const { hashToken } = await import('../src/utils/token-hash.js');
const { signAccessToken, signRefreshToken, verifyAccessToken } = await import('../src/utils/jwt.js');
const { seedWorld, PASSWORD } = await import('./helpers/world.js');

type World = Awaited<ReturnType<typeof seedWorld>>;
type SocketHandler = (value: unknown) => void;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const future = () => new Date(Date.now() + 60_000);

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
  mail.send.mockClear();
});

afterEach(() => {
  // Several existing 400 response schemas are intentionally repaired in BV-065/Phase 3.
  // Drain here so those known contract records cannot leak into another test file.
  takeViolations();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('opaque error boundary', () => {
  function throwingApp(error: unknown) {
    const testApp = express();
    testApp.get('/boom', () => {
      throw error;
    });
    testApp.use(errorHandler);
    return testApp;
  }

  it('returns an opaque 500 with a correlation id', async () => {
    const res = await request(throwingApp(new Error('postgresql://secret-host/internal'))).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Internal server error',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('maps a forced Prisma P2002 without exposing its constraint', async () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`) User_email_key',
      { code: 'P2002', clientVersion: '6.19.3', meta: { target: ['email'] } },
    );
    const res = await request(throwingApp(error)).get('/boom');

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A record with these details already exists.');
    expect(JSON.stringify(res.body)).not.toContain('User_email_key');
  });

  it('maps CORS rejection to 403 rather than 500', async () => {
    const res = await request(app)
      .get(api('/health'))
      .set('Origin', 'https://attacker.invalid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Origin not allowed.');
  });
});

describe('rate limits and OTP attempt budgets', () => {
  it('limits login to ten attempts per IP and email in fifteen minutes', async () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const res = await request(app)
        .post(api('/auth/login'))
        .send({ email: 'rate-login@test.local', password: 'wrong-password' });
      expect(res.status, `attempt ${attempt}`).toBe(401);
    }

    const blocked = await request(app)
      .post(api('/auth/login'))
      .send({ email: 'rate-login@test.local', password: 'wrong-password' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('Too many login attempts. Please try again later.');
  }, 15_000);

  it('spends the login budget on failures only, so a shared address is not locked out', async () => {
    // Everyone behind one NAT or a carrier's CGNAT shares the IP key. If a correct sign-in
    // counted, the eleventh person to sign in correctly within the window would be refused --
    // an outage for a network of legitimate users, caused by them using the product properly.
    for (let attempt = 1; attempt <= 12; attempt++) {
      const res = await request(app)
        .post(api('/auth/login'))
        .send({ email: w.buyer.email, password: PASSWORD });
      expect(res.status, `successful attempt ${attempt}`).toBe(200);
    }

    // Failures still count, and still bite, on the very same key.
    for (let attempt = 1; attempt <= 10; attempt++) {
      const res = await request(app)
        .post(api('/auth/login'))
        .send({ email: w.buyer.email, password: 'wrong-password' });
      expect(res.status, `failed attempt ${attempt}`).toBe(401);
    }

    const blocked = await request(app)
      .post(api('/auth/login'))
      .send({ email: w.buyer.email, password: 'wrong-password' });
    expect(blocked.status).toBe(429);
  }, 40_000);

  it('shares a three-per-hour email budget across reset email requests', async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await request(app)
        .post(api('/auth/forgot-password'))
        .send({ email: 'rate-email@test.local' });
      expect(res.status, `attempt ${attempt}`).toBe(200);
    }
    const blocked = await request(app)
      .post(api('/auth/forgot-password'))
      .send({ email: 'rate-email@test.local' });
    expect(blocked.status).toBe(429);
  });

  it('consumes a reset token after five misses and keeps every later response neutral', async () => {
    const token = await prisma.passwordResetToken.create({
      data: { userId: w.buyer.id, code: '123456', expiresAt: future() },
    });

    for (let attempt = 1; attempt <= 11; attempt++) {
      const res = await request(app)
        .post(api('/auth/verify-reset-otp'))
        .send({ email: w.buyer.email, otp: '654321' });
      expect(res.status, `attempt ${attempt}`).toBe(422);
      expect(res.body.error).toBe('Invalid or expired code.');
    }

    const stored = await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(stored.attempts).toBe(5);
    expect(stored.consumedAt).toBeInstanceOf(Date);
  });

  it('applies the same five-miss budget to email verification tokens', async () => {
    const token = await prisma.emailVerificationToken.create({
      data: { userId: w.buyer.id, code: '123456', expiresAt: future() },
    });

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await request(app)
        .post(api('/auth/verify-email'))
        .send({ email: w.buyer.email, otp: '654321' });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Invalid or expired code.');
    }

    const stored = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(stored.attempts).toBe(5);
    expect(stored.consumedAt).toBeInstanceOf(Date);
  });
});

describe('enumeration resistance and session recovery', () => {
  it('uses the same code error for an unknown account and an existing account', async () => {
    await prisma.emailVerificationToken.create({
      data: { userId: w.buyer.id, code: '123456', expiresAt: future() },
    });
    const existing = await request(app)
      .post(api('/auth/verify-email'))
      .send({ email: w.buyer.email, otp: '654321' });
    const missing = await request(app)
      .post(api('/auth/verify-email'))
      .send({ email: 'missing-user@test.local', otp: '654321' });

    expect({ status: missing.status, error: missing.body.error }).toEqual({
      status: existing.status,
      error: existing.body.error,
    });
  });

  it('changes the password and revokes every refresh session atomically', async () => {
    const tokens = await Promise.all(['one', 'two'].map(async (suffix) => {
      const id = `session-${suffix}`;
      const value = signRefreshToken({ sub: w.buyer.id, jti: id });
      await prisma.refreshToken.create({
        data: { id, userId: w.buyer.id, tokenHash: hashToken(value), expiresAt: future() },
      });
      return value;
    }));

    const res = await request(app)
      .post(api('/auth/change-password'))
      .set(auth(w.buyer.token))
      .send({ currentPassword: PASSWORD, newPassword: 'Correct-Horse-Battery-Staple-42!' });

    expect(res.status).toBe(200);
    expect(tokens).toHaveLength(2);

    // Both pre-existing sessions are gone, and exactly one survives: the replacement issued to
    // the caller. Asserting "zero active" would have been wrong -- that state is what signed the
    // user out of the device they were sitting at.
    const remaining = await prisma.refreshToken.findMany({
      where: { userId: w.buyer.id, revokedAt: null },
      select: { id: true },
    });
    expect(remaining).toHaveLength(1);
    expect(['session-one', 'session-two']).not.toContain(remaining[0].id);

    await vi.waitFor(() => expect(mail.send).toHaveBeenCalled());
  }, 15_000);

  it('hands the caller a session that works, and kills the one it arrived with', async () => {
    const oldValue = signRefreshToken({ sub: w.buyer.id, jti: 'pre-change' });
    await prisma.refreshToken.create({
      data: { id: 'pre-change', userId: w.buyer.id, tokenHash: hashToken(oldValue), expiresAt: future() },
    });

    const changed = await request(app)
      .post(api('/auth/change-password'))
      .set(auth(w.buyer.token))
      .send({ currentPassword: PASSWORD, newPassword: 'Correct-Horse-Battery-Staple-42!' });

    expect(changed.status).toBe(200);
    expect(typeof changed.body.data.accessToken).toBe('string');
    expect(typeof changed.body.data.refreshToken).toBe('string');

    // The replacement works -- the usability half, and the half that was missing.
    const fresh = await request(app)
      .post(api('/auth/refresh'))
      .send({ refreshToken: changed.body.data.refreshToken });
    expect(fresh.status).toBe(200);
    expect(typeof fresh.body.data.accessToken).toBe('string');

    // The session held before the change is dead -- the security half.
    //
    // Checked last, and that ordering is load-bearing. Presenting the revoked token is exactly
    // what reuse detection is watching for, so it revokes the whole family, the new session
    // included. Probing it first would therefore have failed the assertion above and looked
    // like a broken replacement rather than a working defence -- which is what the first draft
    // of this test did. The behaviour is right: a genuinely stolen token should cost the
    // attacker and the victim every session, password change or not.
    const stale = await request(app)
      .post(api('/auth/refresh'))
      .send({ refreshToken: oldValue });
    expect(stale.status).toBe(401);

    const afterReuse = await prisma.refreshToken.count({
      where: { userId: w.buyer.id, revokedAt: null },
    });
    expect(afterReuse).toBe(0);
  }, 20_000);

  it('revokes the whole family when a recognised revoked refresh token is reused', async () => {
    const oldId = 'old-session';
    const activeId = 'active-session';
    const oldToken = signRefreshToken({ sub: w.buyer.id, jti: oldId });
    const activeToken = signRefreshToken({ sub: w.buyer.id, jti: activeId });
    await prisma.refreshToken.createMany({
      data: [
        {
          id: oldId,
          userId: w.buyer.id,
          tokenHash: hashToken(oldToken),
          expiresAt: future(),
          revokedAt: new Date(),
          replacedByTokenId: activeId,
        },
        {
          id: activeId,
          userId: w.buyer.id,
          tokenHash: hashToken(activeToken),
          expiresAt: future(),
        },
      ],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await request(app)
      .post(api('/auth/refresh'))
      .send({ refreshToken: oldToken });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Session invalidated. Please sign in again.');
    const active = await prisma.refreshToken.findUniqueOrThrow({ where: { id: activeId } });
    expect(active.revokedAt).toBeInstanceOf(Date);

    // BV-031: reuse of a revoked token is the signature the rotation machinery exists to
    // catch, so the account owner must be told -- not just have the family revoked silently.
    await vi.waitFor(() => {
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Security alert: all BidVault sessions were signed out' }),
      );
    });
  });
});

describe('JWT and password policy', () => {
  it('requires HS256, issuer, audience and a valid payload shape', () => {
    const valid = signAccessToken({ sub: w.buyer.id, role: 'BUYER' });
    expect(verifyAccessToken(valid)).toMatchObject({ sub: w.buyer.id, role: 'BUYER' });

    const noAudience = jwt.sign(
      { sub: w.buyer.id, role: 'BUYER' },
      env.JWT_ACCESS_SECRET,
      { algorithm: 'HS256' },
    );
    expect(() => verifyAccessToken(noAudience)).toThrow();

    const malformed = jwt.sign(
      { sub: w.buyer.id, role: 'ROOT' },
      env.JWT_ACCESS_SECRET,
      { algorithm: 'HS256', issuer: 'bidvault', audience: 'bidvault-api' },
    );
    expect(() => verifyAccessToken(malformed)).toThrow();
  });

  it('rejects common passwords and hashes accepted passwords at cost 12', async () => {
    expect(registerSchema.safeParse({
      name: 'Weak Password',
      email: 'weak@test.local',
      password: 'password123',
      role: 'BUYER',
    }).success).toBe(false);

    const hash = await hashPassword('Correct-Horse-Battery-Staple-42!');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    await expect(verifyPassword('Correct-Horse-Battery-Staple-42!', hash)).resolves.toBe(true);
  }, 10_000);
});

describe('bounded values and escaped email output', () => {
  it('rejects an int32-overflow bid as a clean validation error', async () => {
    const res = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/bids`))
      .set(auth(w.buyer.token))
      .send({ amount: 2_147_483_648 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation error');
    expect(res.body.details).toHaveProperty('amount');
  });

  it('rejects a storable but abusive bid relative to the locked auction state', async () => {
    const res = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/bids`))
      .set(auth(w.buyer.token))
      .send({ amount: 2_000_000_000 });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('cannot exceed');
  });

  it('bounds listing money, emoji, rejection reason and image host', () => {
    expect(placeBidSchema.safeParse({ amount: 2_147_483_648 }).success).toBe(false);
    expect(rejectListingSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);

    const base = {
      title: 'A valid listing',
      category: 'Books & Education',
      condition: 'NEW',
      description: 'A sufficiently detailed listing description.',
      startPrice: 3_000,
      minIncrement: 100,
      durationDays: 2,
      attributes: { author: 'Writer', format: 'Physical' },
    };
    expect(submitListingSchema.safeParse({ ...base, emoji: 'x'.repeat(9) }).success).toBe(false);
    expect(submitListingSchema.safeParse({ ...base, startPrice: 2_147_483_648 }).success).toBe(false);
    expect(submitListingSchema.safeParse({
      ...base,
      imageUrl: 'https://tracking.attacker.invalid/pixel.jpg',
    }).success).toBe(false);
  });

  it('measures the emoji bound in graphemes, not UTF-16 code units', () => {
    const base = {
      title: 'A valid listing',
      category: 'Books & Education',
      condition: 'NEW',
      description: 'A sufficiently detailed listing description.',
      startPrice: 3_000,
      minIncrement: 100,
      durationDays: 2,
      attributes: { author: 'Writer', format: 'Physical' },
    };
    // Eleven UTF-16 code units, one grapheme. A .max(8) on the raw string refused this.
    const family = '👨‍👩‍👧‍👦';
    expect(family.length).toBeGreaterThan(8);
    expect(submitListingSchema.safeParse({ ...base, emoji: family }).success).toBe(true);
    expect(submitListingSchema.safeParse({ ...base, emoji: '🎸🍵' }).success).toBe(true);
    // Three graphemes is over the limit even though it is well under any length ceiling.
    expect(submitListingSchema.safeParse({ ...base, emoji: '🎸🍵📚' }).success).toBe(false);
  });

  it('escapes a hostile listing title in generated email HTML and strips header newlines', async () => {
    const title = '<img src=x onerror=1>\r\nBcc: victim@example.com';
    await sendBidPlacedEmail(
      { email: w.buyer.email, name: 'Buyer <unsafe>' },
      { title, amount: 25_000, auctionId: w.liveAuctionId },
    );

    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0][0];
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.html).toContain('&lt;img src=x onerror=1&gt;');
    expect(message.html).not.toContain('<img src=x onerror=1>');
    expect(message.html).toContain('Buyer &lt;unsafe&gt;');
  });
});

describe('socket and Cloudinary abuse controls', () => {
  it('exhausts and lazily refills the per-socket token bucket', () => {
    const bucket = {};
    for (let i = 0; i < 50; i++) expect(consumeSubscriptionToken(bucket, 1_000)).toBe(true);
    expect(consumeSubscriptionToken(bucket, 1_000)).toBe(false);
    expect(consumeSubscriptionToken(bucket, 61_000)).toBe(true);
  });

  it('caps one socket at 25 auction rooms even with concurrent lookups', async () => {
    const handlers = new Map<string, SocketHandler>();
    const rooms = new Set<string>(['socket-id']);
    const fake = {
      connected: true,
      rooms,
      on: vi.fn((event: string, handler: SocketHandler) => {
        handlers.set(event, handler);
        return fake;
      }),
      join: vi.fn(async (room: string) => { rooms.add(room); }),
      leave: vi.fn(async (room: string) => { rooms.delete(room); }),
      disconnect: vi.fn(),
    };
    const existingAuction = await prisma.auction.findUniqueOrThrow({
      where: { id: w.liveAuctionId },
    });
    const findUnique = vi.spyOn(prisma.auction, 'findUnique').mockResolvedValue(existingAuction);
    registerAuctionSubscriptions(fake as unknown as Socket);

    const subscribe = handlers.get('auction:subscribe')!;
    for (let i = 0; i < 30; i++) subscribe(`auction-${i}`);

    await vi.waitFor(() => expect(fake.join).toHaveBeenCalledTimes(25));
    expect([...rooms].filter((room) => room.startsWith('auction:'))).toHaveLength(25);
    expect(findUnique).toHaveBeenCalledTimes(25);
  });

  it('issues one constrained Cloudinary object signature per request', async () => {
    const first = await request(app)
      .post(api('/listings/upload-signature'))
      .set(auth(w.seller.token));
    const second = await request(app)
      .post(api('/listings/upload-signature'))
      .set(auth(w.seller.token));

    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      allowedFormats: 'jpg,png,webp',
      format: 'jpg',
    });
    expect(first.body.data.publicId).toMatch(new RegExp(`^listing-${w.seller.id}-`));
    expect(second.body.data.publicId).not.toBe(first.body.data.publicId);
  });

  it('signs only parameters Cloudinary recognises', async () => {
    // Cloudinary rebuilds the signature from the parameters it knows and ignores the rest, so
    // signing one it does not know makes every upload fail with 401 Invalid Signature. That is
    // not theoretical: `max_file_size` was signed here and is not an Upload API parameter, and
    // the live API refused the upload while reporting the string it had signed — without it.
    //
    // Asserting on the published response is what keeps that from coming back, because the
    // response is what the browser posts to Cloudinary verbatim.
    const res = await request(app)
      .post(api('/listings/upload-signature'))
      .set(auth(w.seller.token));

    const CLOUDINARY_UPLOAD_PARAMS = new Set([
      'signature', 'timestamp', 'apiKey', 'cloudName', 'folder', 'format', 'publicId',
      'allowedFormats',
    ]);
    expect(new Set(Object.keys(res.body.data))).toEqual(CLOUDINARY_UPLOAD_PARAMS);

    // The signature must cover exactly the signable fields, in Cloudinary's own ordering.
    const { signature, timestamp, folder, format, publicId, allowedFormats } = res.body.data;
    const expected = cloudinary.utils.api_sign_request(
      { timestamp, folder, format, public_id: publicId, allowed_formats: allowedFormats },
      env.CLOUDINARY_API_SECRET,
    );
    expect(signature).toBe(expected);
  });
});

describe('availability of the controls themselves', () => {
  it('clears every limiter so one test cannot spend another test\'s budget', async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await request(app)
        .post(api('/auth/forgot-password'))
        .send({ email: 'budget@test.local' });
      expect(res.status, `attempt ${attempt}`).toBe(200);
    }
    expect(
      (await request(app).post(api('/auth/forgot-password')).send({ email: 'budget@test.local' }))
        .status,
    ).toBe(429);

    await resetRateLimits();

    expect(
      (await request(app).post(api('/auth/forgot-password')).send({ email: 'budget@test.local' }))
        .status,
    ).toBe(200);
  });

  it('fails open rather than hanging when the limiter store is unreachable', async () => {
    // The store's failure mode is the API's failure mode: express-rate-limit awaits it on every
    // request. Sharing the BullMQ client made this unsafe — with maxRetriesPerRequest null and
    // an offline queue, a command issued during a Redis outage never settles, so the request
    // hangs instead of erroring and passOnStoreError never gets a rejection to act on.
    //
    // Simulated here by a store that rejects, which is what the dedicated client is configured
    // to produce. The requirement is that the request still completes.
    const failing = express();
    failing.use(
      rateLimit({
        windowMs: 60_000,
        limit: 1,
        passOnStoreError: true,
        store: {
          init: () => undefined,
          increment: () => Promise.reject(new Error('Redis unreachable')),
          decrement: () => Promise.reject(new Error('Redis unreachable')),
          resetKey: () => Promise.reject(new Error('Redis unreachable')),
        },
      }),
    );
    failing.get('/probe', (_req, res) => void res.json({ ok: true }));

    const res = await request(failing).get('/probe');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('configures the limiter connection to fail fast without breaking its own startup', async () => {
    // A configuration test, because the failure it guards against is invisible at runtime.
    //
    // RedisStore.init() issues SCRIPT LOAD synchronously while rateLimit() is constructed, before
    // the socket can be ready. Disabling the offline queue — the obvious way to make commands
    // reject instead of hang — refuses that call, so the increment script never loads, every
    // later increment fails, and passOnStoreError turns the limiter into a no-op that still
    // reports itself healthy. Live, that looked like: twelve login attempts, no 429, no
    // RateLimit headers, nothing written to Redis.
    //
    // maxRetriesPerRequest is the setting that actually delivers fail-fast: once the budget is
    // spent ioredis flushes the queue with an error, which is the rejection passOnStoreError
    // needs. null — the BullMQ value — means retry forever, which is the original hang.
    const { getRateLimitRedis } = await import('../src/infra/redis.js');
    const client = getRateLimitRedis();
    try {
      expect(client.options.enableOfflineQueue).not.toBe(false);
      expect(client.options.maxRetriesPerRequest).toBe(1);
      expect(client.options.commandTimeout).toBeGreaterThan(0);
    } finally {
      client.disconnect();
    }
  });

  it('exempts the Stripe webhook from the global limit', async () => {
    // Every event for every seller arrives from Stripe's small address pool, so they share one
    // key. The endpoint authenticates by signature, so skipping the counter does not open it —
    // an unsigned request is still refused, which is what this asserts.
    const res = await request(app)
      .post(api('/payments/webhook'))
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).not.toBe(429);
    expect(res.status).toBe(400);
  });
});

describe('password hashes upgrade in place', () => {
  it('recognises a stale cost and leaves a current one alone', () => {
    expect(needsRehash('$2a$10$' + 'x'.repeat(53))).toBe(true);
    expect(needsRehash('$2b$12$' + 'x'.repeat(53))).toBe(false);
    // Same cost, older variant: identical work, so rewriting it would buy nothing.
    expect(needsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
    expect(needsRehash('$2a$12$' + 'x'.repeat(53))).toBe(false);
    expect(needsRehash('not-a-bcrypt-hash')).toBe(false);
  });

  it('re-hashes an account still on the old cost when it signs in', async () => {
    // The dummy-hash comparison only levels login timing for accounts at the current cost: a
    // cost-10 hash verifies about four times faster than the cost-12 dummy, which leaks the
    // same "does this address exist" fact with the sign reversed.
    const legacy = await hashLegacy('legacy-password-value', 10);
    await prisma.user.update({
      where: { id: w.buyer.id },
      data: { passwordHash: legacy },
    });

    const res = await request(app)
      .post(api('/auth/login'))
      .send({ email: w.buyer.email, password: 'legacy-password-value' });
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: w.buyer.id } });
    expect(needsRehash(after.passwordHash)).toBe(false);
    expect(after.passwordHash).not.toBe(legacy);
    // Still the same password — the upgrade must not lock the user out.
    expect(
      (await request(app).post(api('/auth/login'))
        .send({ email: w.buyer.email, password: 'legacy-password-value' })).status,
    ).toBe(200);
  }, 15_000);
});
