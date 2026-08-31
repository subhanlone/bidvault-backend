/**
 * Every documented operation, exercised once against a real database.
 *
 * The point is coverage, not depth: each of the 43 entries in openapi.json gets at least
 * one request that reaches its handler and returns its documented success status. Deep
 * behavioural cases belong in their own files.
 *
 * This is also the substrate the response-contract middleware runs on — once that lands,
 * every request below is checked against its published schema for free, so a route added
 * here is a route whose shape is guarded.
 *
 * A guard at the bottom fails if openapi.json ever documents an operation this file does
 * not touch, so the two cannot drift apart silently.
 */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Stripe is the one dependency here that would otherwise make a network call. Only the
// PaymentIntent methods are replaced; webhooks keeps the real implementation so signature
// verification is genuinely exercised rather than waved through. Constructing a Stripe
// instance opens no connection.
vi.mock('stripe', async () => {
  const actual = await vi.importActual<typeof import('stripe')>('stripe');
  const real = new actual.default('sk_test_placeholder_for_signature_verification_only');
  const intent = {
    id: 'pi_test_conformance',
    client_secret: 'pi_test_conformance_secret_abc',
    status: 'requires_payment_method',
  };
  class MockStripe {
    webhooks = real.webhooks;
    paymentIntents = {
      create: vi.fn(async () => intent),
      retrieve: vi.fn(async () => intent),
    };
  }
  // Spread first: `actual` carries its own `default`, which would otherwise replace the mock.
  return { ...actual, default: MockStripe };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld, PASSWORD } = await import('./helpers/world.js');
const { takeViolations, contractSize } = await import('../src/middleware/response-contract.js');
type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` } as Record<string, string>);

/** Records which documented operations this file actually reached. */
const covered = new Set<string>();
function hit(method: string, path: string) {
  covered.add(`${method.toUpperCase()} ${path}`);
}

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  w = await seedWorld();
});

// The response-contract middleware records any response that does not match the schema
// openapi.json publishes for it. Draining it here turns each of the requests below into a
// schema assertion as well as a status assertion, with no per-test bookkeeping.
afterEach(() => {
  const violations = takeViolations();
  expect(violations, 'the response did not match its published schema').toEqual([]);
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

// ---- platform ---------------------------------------------------------------------

describe('platform', () => {
  it('GET /health', async () => {
    hit('get', '/health');
    const res = await request(app).get(api('/health'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
  });

  it('GET /stats', async () => {
    hit('get', '/stats');
    const res = await request(app).get(api('/stats'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('userCount');
  });
});

// ---- auth -------------------------------------------------------------------------

describe('auth', () => {
  it('POST /auth/register', async () => {
    hit('post', '/auth/register');
    const res = await request(app).post(api('/auth/register')).send({
      name: 'Fresh User',
      email: 'fresh@test.local',
      password: 'a-good-password',
      role: 'BUYER',
    });
    expect(res.status).toBe(201);
  });

  it('POST /auth/verify-email', async () => {
    hit('post', '/auth/verify-email');
    // Registration issues the code; read it back rather than guessing.
    await request(app).post(api('/auth/register')).send({
      name: 'Verify Me',
      email: 'verify@test.local',
      password: 'a-good-password',
      role: 'BUYER',
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'verify@test.local' } });
    const token = await prisma.emailVerificationToken.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const res = await request(app)
      .post(api('/auth/verify-email'))
      .send({ email: 'verify@test.local', otp: token.code });
    expect(res.status).toBe(200);
  });

  it('POST /auth/login', async () => {
    hit('post', '/auth/login');
    const res = await request(app)
      .post(api('/auth/login'))
      .send({ email: w.buyer.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('accessToken');
  });

  it('POST /auth/refresh', async () => {
    hit('post', '/auth/refresh');
    const login = await request(app)
      .post(api('/auth/login'))
      .send({ email: w.buyer.email, password: PASSWORD });
    const res = await request(app)
      .post(api('/auth/refresh'))
      .send({ refreshToken: login.body.data.refreshToken });
    expect(res.status).toBe(200);
  });

  it('POST /auth/logout', async () => {
    hit('post', '/auth/logout');
    const login = await request(app)
      .post(api('/auth/login'))
      .send({ email: w.buyer.email, password: PASSWORD });
    const res = await request(app)
      .post(api('/auth/logout'))
      .send({ refreshToken: login.body.data.refreshToken });
    expect(res.status).toBe(200);
  });

  it('POST /auth/forgot-password', async () => {
    hit('post', '/auth/forgot-password');
    const res = await request(app).post(api('/auth/forgot-password')).send({ email: w.buyer.email });
    expect(res.status).toBe(200);
  });

  it('POST /auth/verify-reset-otp', async () => {
    hit('post', '/auth/verify-reset-otp');
    await request(app).post(api('/auth/forgot-password')).send({ email: w.buyer.email });
    const code = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: w.buyer.id },
      orderBy: { createdAt: 'desc' },
    });
    const res = await request(app)
      .post(api('/auth/verify-reset-otp'))
      .send({ email: w.buyer.email, otp: code.code });
    expect(res.status).toBe(200);
  });

  it('POST /auth/reset-password', async () => {
    hit('post', '/auth/reset-password');
    await request(app).post(api('/auth/forgot-password')).send({ email: w.buyer.email });
    const code = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: w.buyer.id },
      orderBy: { createdAt: 'desc' },
    });
    const res = await request(app)
      .post(api('/auth/reset-password'))
      .send({ email: w.buyer.email, otp: code.code, password: 'a-brand-new-password' });
    expect(res.status).toBe(200);
  });

  it('POST /auth/resend-verification', async () => {
    hit('post', '/auth/resend-verification');
    // Must be an *unverified* account, or this takes the neutral exit and never produces
    // the codeExpiresAt branch. The seeded buyer is verified, so register a fresh one.
    await request(app).post(api('/auth/register')).send({
      name: 'Unverified Person',
      email: 'unverified@test.local',
      password: 'a-good-password',
      role: 'BUYER',
    });
    const res = await request(app)
      .post(api('/auth/resend-verification'))
      .send({ email: 'unverified@test.local' });
    expect(res.status).toBe(200);
    expect(res.body.data.codeExpiresAt).toEqual(expect.any(String));
  });

  // Both OTP routes have a neutral early exit that answers without an expiry, so that the
  // response cannot be used to tell whether an account exists. Nothing covered those paths,
  // and OtpIssuedDto declared codeExpiresAt required — so the contract described a response
  // the server never sends. The response-contract middleware caught it; these keep it caught.
  it('POST /auth/forgot-password — unknown address takes the neutral path', async () => {
    const res = await request(app)
      .post(api('/auth/forgot-password'))
      .send({ email: 'nobody-here@test.local' });
    expect(res.status).toBe(200);
    expect(res.body.data.codeExpiresAt).toBeUndefined();
  });

  it('POST /auth/resend-verification — verified account takes the neutral path', async () => {
    // The seeded buyer is already verified, so this is the short-circuit.
    const res = await request(app)
      .post(api('/auth/resend-verification'))
      .send({ email: w.buyer.email });
    expect(res.status).toBe(200);
    expect(res.body.data.codeExpiresAt).toBeUndefined();
  });

  it('POST /auth/change-password', async () => {
    hit('post', '/auth/change-password');
    const res = await request(app)
      .post(api('/auth/change-password'))
      .set(auth(w.buyer.token))
      .send({ currentPassword: PASSWORD, newPassword: 'another-good-password' });
    expect(res.status).toBe(200);
  });

  it('GET /auth/me', async () => {
    hit('get', '/auth/me');
    const res = await request(app).get(api('/auth/me')).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(w.buyer.email);
  });

  it('GET /auth/me/preferences', async () => {
    hit('get', '/auth/me/preferences');
    const res = await request(app).get(api('/auth/me/preferences')).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
  });

  it('PATCH /auth/me/preferences', async () => {
    hit('patch', '/auth/me/preferences');
    const res = await request(app)
      .patch(api('/auth/me/preferences'))
      .set(auth(w.buyer.token))
      .send({ notifyOutbid: false });
    expect(res.status).toBe(200);
  });

  it('POST /auth/delete-account', async () => {
    hit('post', '/auth/delete-account');
    // otherBuyer, not buyer: buyer has a PENDING transaction in this world and would 409.
    const res = await request(app)
      .post(api('/auth/delete-account'))
      .set(auth(w.otherBuyer.token))
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

// ---- auctions ---------------------------------------------------------------------

describe('auctions', () => {
  it('GET /auctions', async () => {
    hit('get', '/auctions');
    const res = await request(app).get(api('/auctions'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('GET /auctions/{auctionId}', async () => {
    hit('get', '/auctions/{auctionId}');
    const res = await request(app).get(api(`/auctions/${w.liveAuctionId}`));
    expect(res.status).toBe(200);
    expect(res.body.data.auctionId).toBe(w.liveAuctionId);
  });

  it('GET /auctions/{auctionId}/bids', async () => {
    hit('get', '/auctions/{auctionId}/bids');
    const res = await request(app).get(api(`/auctions/${w.liveAuctionId}/bids`));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('POST /auctions/{auctionId}/bids', async () => {
    hit('post', '/auctions/{auctionId}/bids');
    const res = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/bids`))
      .set(auth(w.buyer.token))
      .send({ amount: 25_000 });
    expect(res.status).toBe(201);
  });

  it('GET /auctions/mine/bids', async () => {
    hit('get', '/auctions/mine/bids');
    const res = await request(app).get(api('/auctions/mine/bids')).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  // BV-065: this operation's 400 is validateBody's ValidationErrorBody; the bid-floor
  // rejection below is a business rule the handler checks itself, on the same auction the
  // happy-path test above already bid on (currentBid 21,000, minIncrement 1,000 — 22,000 is
  // the floor). It used to leave the same 400 slot with a body that shape did not describe.
  // The afterEach above turns "no violation recorded" into an assertion for free.
  it('POST /auctions/{auctionId}/bids — below the floor answers 422, not the 400 ValidationError shape', async () => {
    const res = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/bids`))
      .set(auth(w.buyer.token))
      .send({ amount: 21_500 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ success: false, error: expect.stringContaining('at least PKR') });
  });
});

// ---- listings ---------------------------------------------------------------------

describe('listings', () => {
  it('POST /listings', async () => {
    hit('post', '/listings');
    const res = await request(app)
      .post(api('/listings'))
      .set(auth(w.seller.token))
      .send({
        title: 'A Newly Submitted Item',
        category: 'Books & Education',
        condition: 'NEW',
        description: 'Submitted by the conformance suite, long enough to pass validation.',
        startPrice: 3_000,
        minIncrement: 250,
        durationDays: 5,
        // Required by category-attributes.ts for this category.
        attributes: { author: 'A Writer', format: 'Physical' },
      });
    expect(res.status).toBe(201);
  });

  it('GET /listings/mine', async () => {
    hit('get', '/listings/mine');
    const res = await request(app).get(api('/listings/mine')).set(auth(w.seller.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('GET /listings/pending', async () => {
    hit('get', '/listings/pending');
    const res = await request(app).get(api('/listings/pending')).set(auth(w.admin.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('POST /listings/upload-signature', async () => {
    hit('post', '/listings/upload-signature');
    const res = await request(app)
      .post(api('/listings/upload-signature'))
      .set(auth(w.seller.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('signature');
  });

  it('POST /listings/{listingId}/approve', async () => {
    hit('post', '/listings/{listingId}/approve');
    const res = await request(app)
      .post(api(`/listings/${w.pendingListingId}/approve`))
      .set(auth(w.admin.token));
    expect(res.status).toBe(200);

    // BV-050: written in the same transaction as the approval itself now, not a best-effort
    // call afterward -- so it exists exactly when the approval that produced it does.
    const entry = await prisma.auditLog.findFirst({
      where: { entityId: w.pendingListingId, action: 'LISTING_APPROVED' },
    });
    expect(entry).not.toBeNull();
    expect(entry?.actorUserId).toBe(w.admin.id);
    expect((entry?.metadata as { auctionId?: string } | null)?.auctionId).toBe(res.body.data.auctionId);
  });

  it('POST /listings/{listingId}/reject', async () => {
    hit('post', '/listings/{listingId}/reject');
    const res = await request(app)
      .post(api(`/listings/${w.pendingListingId}/reject`))
      .set(auth(w.admin.token))
      .send({ reason: 'Does not meet the listing guidelines.' });
    expect(res.status).toBe(200);
  });

  it('POST /listings/approve-all', async () => {
    hit('post', '/listings/approve-all');
    const res = await request(app).post(api('/listings/approve-all')).set(auth(w.admin.token));
    expect(res.status).toBe(200);
  });
});

// ---- watchlist --------------------------------------------------------------------

describe('watchlist', () => {
  it('GET /watchlist', async () => {
    hit('get', '/watchlist');
    const res = await request(app).get(api('/watchlist')).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });

  it('POST /watchlist/{auctionId}', async () => {
    hit('post', '/watchlist/{auctionId}');
    const res = await request(app)
      .post(api(`/watchlist/${w.closedAuctionId}`))
      .set(auth(w.buyer.token));
    expect(res.status).toBe(201);
  });

  it('DELETE /watchlist/{auctionId}', async () => {
    hit('delete', '/watchlist/{auctionId}');
    const res = await request(app)
      .delete(api(`/watchlist/${w.liveAuctionId}`))
      .set(auth(w.buyer.token));
    expect(res.status).toBe(200);
  });
});

// ---- payments ---------------------------------------------------------------------

describe('payments', () => {
  it('GET /payments/my-wins', async () => {
    hit('get', '/payments/my-wins');
    const res = await request(app).get(api('/payments/my-wins')).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('GET /payments/seller-stats', async () => {
    hit('get', '/payments/seller-stats');
    const res = await request(app).get(api('/payments/seller-stats')).set(auth(w.seller.token));
    expect(res.status).toBe(200);
  });

  it('POST /payments/create-intent', async () => {
    hit('post', '/payments/create-intent');
    const res = await request(app)
      .post(api('/payments/create-intent'))
      .set(auth(w.buyer.token))
      .send({ transactionId: w.transactionId });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('clientSecret');
  });

  // create-intent was the one route validating its body by hand, so its 400 was an
  // ErrorResponse while the contract documented a ValidationError. Now it goes through
  // validateBody like everything else; this covers the branch that was mis-described.
  it('POST /payments/create-intent — rejects a missing body as a ValidationError', async () => {
    const res = await request(app)
      .post(api('/payments/create-intent'))
      .set(auth(w.buyer.token))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation error');
    expect(res.body.details).toHaveProperty('transactionId');
  });

  // BV-065: the outcome.status branch in the handler can answer 409 for a transaction that
  // is already COMPLETED — a business rule, not a validateBody failure — on the same 400
  // slot ValidationErrorBody had claimed. The afterEach above turns "no violation recorded"
  // into an assertion for free.
  it('POST /payments/create-intent — an already-paid transaction answers 409, not 400', async () => {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'COMPLETED' },
    });
    const res = await request(app)
      .post(api('/payments/create-intent'))
      .set(auth(w.buyer.token))
      .send({ transactionId: w.transactionId });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, error: expect.stringContaining('already') });
  });

  it('POST /payments/webhook', async () => {
    hit('post', '/payments/webhook');
    // Attach the intent id the handler looks the transaction up by.
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { stripePaymentIntentId: 'pi_test_conformance' },
    });

    const { default: Stripe } = await vi.importActual<typeof import('stripe')>('stripe');
    const payload = JSON.stringify({
      id: 'evt_test_conformance',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_test_conformance', object: 'payment_intent' } },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });

    const res = await request(app)
      .post(api('/payments/webhook'))
      .set('stripe-signature', signature)
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(200);
  });
});

// ---- notifications ----------------------------------------------------------------

describe('notifications', () => {
  it('GET /notifications', async () => {
    hit('get', '/notifications');
    const res = await request(app).get(api('/notifications')).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('POST /notifications/{notificationId}/read', async () => {
    hit('post', '/notifications/{notificationId}/read');
    const res = await request(app)
      .post(api(`/notifications/${w.notificationId}/read`))
      .set(auth(w.buyer.token));
    expect(res.status).toBe(200);
  });

  it('POST /notifications/read-all', async () => {
    hit('post', '/notifications/read-all');
    const res = await request(app).post(api('/notifications/read-all')).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
  });
});

// ---- reviews ----------------------------------------------------------------------

describe('reviews', () => {
  it('POST /reviews', async () => {
    hit('post', '/reviews');
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'COMPLETED' },
    });
    const res = await request(app)
      .post(api('/reviews'))
      .set(auth(w.buyer.token))
      .send({ transactionId: w.transactionId, stars: 5, comment: 'Smooth transaction.' });
    expect(res.status).toBe(201);
  });

  it('GET /reviews/seller/{sellerId}', async () => {
    hit('get', '/reviews/seller/{sellerId}');
    const res = await request(app).get(api(`/reviews/seller/${w.seller.id}`));
    expect(res.status).toBe(200);
  });
});

// ---- settings ---------------------------------------------------------------------

describe('settings', () => {
  it('GET /settings/public', async () => {
    hit('get', '/settings/public');
    const res = await request(app).get(api('/settings/public'));
    expect(res.status).toBe(200);
  });

  it('GET /settings', async () => {
    hit('get', '/settings');
    const res = await request(app).get(api('/settings')).set(auth(w.admin.token));
    expect(res.status).toBe(200);
  });

  it('PUT /settings', async () => {
    hit('put', '/settings');
    const res = await request(app)
      .put(api('/settings'))
      .set(auth(w.admin.token))
      .send({ minListingPrice: 1_500 });
    expect(res.status).toBe(200);
  });
});

// ---- admin ------------------------------------------------------------------------

describe('admin', () => {
  it('GET /admin/analytics', async () => {
    hit('get', '/admin/analytics');
    const res = await request(app).get(api('/admin/analytics')).set(auth(w.admin.token));
    expect(res.status).toBe(200);
  });

  // BV-008: the monthly buckets used to be JS Date math over every fetched row -- getFullYear()
  // / getMonth() read in the *server's local* timezone, so a record near a month boundary
  // could land one month off depending on where the process runs. Now it's date_trunc(...
  // AT TIME ZONE 'UTC') in Postgres, which cannot drift with the app server's zone. A fixed
  // relative offset (two months back) rather than a hardcoded date, so this keeps testing
  // something regardless of when it runs.
  it('GET /admin/analytics — buckets revenue and bids by UTC month', async () => {
    const now = new Date();
    const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1, 0, 0, 0));
    const monthLabel = boundary.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });

    await prisma.auctionTransaction.create({
      data: {
        auctionId: w.liveAuctionId,
        winnerId: w.buyer.id,
        sellerId: w.seller.id,
        finalAmount: 77_000,
        status: 'COMPLETED',
        createdAt: boundary,
      },
    });
    await prisma.bid.create({
      data: { auctionId: w.liveAuctionId, buyerId: w.buyer.id, amount: 21_500, createdAt: boundary },
    });

    const res = await request(app).get(api('/admin/analytics')).set(auth(w.admin.token));
    expect(res.status).toBe(200);

    const bucket = res.body.data.monthlyRevenue.find((m: { month: string }) => m.month === monthLabel);
    expect(bucket).toBeDefined();
    expect(bucket.value).toBeGreaterThanOrEqual(77_000);
    expect(bucket.bids).toBeGreaterThanOrEqual(1);
  });

  it('GET /admin/transactions', async () => {
    hit('get', '/admin/transactions');
    const res = await request(app).get(api('/admin/transactions')).set(auth(w.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.some((tx: { transactionId: string }) => tx.transactionId === w.transactionId)).toBe(true);
  });

  it('POST /admin/transactions/{transactionId}/void', async () => {
    hit('post', '/admin/transactions/{transactionId}/void');
    const res = await request(app)
      .post(api(`/admin/transactions/${w.transactionId}/void`))
      .set(auth(w.admin.token))
      .send({ reason: 'Buyer unreachable after repeated attempts.' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('VOIDED');

    const row = await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
    expect(row.status).toBe('VOIDED');

    // Restore PENDING so later tests in this file that depend on w.transactionId are unaffected.
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'PENDING' } });
  });

  it('GET /admin/users', async () => {
    hit('get', '/admin/users');
    const res = await request(app)
      .get(api(`/admin/users?email=${encodeURIComponent(w.otherSeller.email)}`))
      .set(auth(w.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.some((u: { userId: string }) => u.userId === w.otherSeller.id)).toBe(true);
  });

  it('POST /admin/users/{userId}/anonymize', async () => {
    hit('post', '/admin/users/{userId}/anonymize');
    const res = await request(app)
      .post(api(`/admin/users/${w.otherSeller.id}/anonymize`))
      .set(auth(w.admin.token))
      .send({ reason: 'Requested via support ticket.' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ANONYMIZED');
  });
});

// ---- the guard --------------------------------------------------------------------

describe('coverage', () => {
  it('touches every operation documented in openapi.json', () => {
    const spec = JSON.parse(
      readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> };

    const documented: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          documented.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    const missing = documented.filter((op) => !covered.has(op)).sort();
    expect(
      missing,
      `openapi.json documents ${documented.length} operations; these have no test here:\n` +
        missing.map((m) => `  ${m}`).join('\n'),
    ).toEqual([]);
    expect(covered.size).toBe(documented.length);

    // The middleware builds its own lookup from the same document. If that ever knows about
    // fewer operations than the spec has, some route is being served unchecked.
    expect(contractSize).toBe(documented.length);
  });
});
