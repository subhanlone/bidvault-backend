/**
 * Two check-then-act paths that can lose a race to a concurrent duplicate submit (BV-043).
 *
 * The database's unique constraints already protect the data -- nothing duplicate is ever
 * written. What they didn't protect was the *message*: a request that lost the race past the
 * pre-check used to fall through to the shared P2002 handler's generic wording instead of the
 * route's own, more specific one. A double-click on a slow connection is enough to hit this.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(async () => ({ data: { id: 'email_test' }, error: null })) };
  },
}));

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
});

afterEach(() => {
  takeViolations();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('duplicate submit past the pre-check', () => {
  it('registration: falls back to the specific 409 message, not the generic one', async () => {
    await prisma.user.create({
      data: {
        name: 'Already Registered',
        email: 'racer@test.local',
        passwordHash: 'irrelevant-for-this-test',
        role: 'BUYER',
        isEmailVerified: true,
      },
    });
    // Simulates the race: the pre-check reads no row (as it would have a moment earlier),
    // but the real unique constraint on email still catches the create.
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(null);

    const res = await request(app).post(api('/auth/register')).send({
      name: 'New Person',
      email: 'racer@test.local',
      password: 'a-good-password',
      role: 'BUYER',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('An account with this email already exists.');
  });

  it('reviews: falls back to the specific 409 message, not the generic one', async () => {
    // A DELIVERED transaction the buyer is entitled to review.
    const listing = await prisma.listing.create({
      data: {
        listingCode: 'TEST-RACE-1',
        sellerId: w.seller.id,
        title: 'Delivered Test Item',
        category: 'Electronics & Gadgets',
        condition: 'USED',
        description: 'Seeded for the duplicate-review race test.',
        startPrice: 1_000,
        minIncrement: 100,
        durationDays: 1,
        status: 'APPROVED',
      },
    });
    const deliveredAuction = await prisma.auction.create({
      data: {
        listingId: listing.id,
        sellerId: w.seller.id,
        title: listing.title,
        category: listing.category,
        condition: listing.condition,
        description: listing.description,
        startPrice: listing.startPrice,
        minIncrement: listing.minIncrement,
        currentBid: 1_000,
        bidCount: 1,
        status: 'CLOSED',
        startTime: new Date(Date.now() - 48 * 60 * 60 * 1000),
        endTime: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const transaction = await prisma.auctionTransaction.create({
      data: {
        auctionId: deliveredAuction.id,
        winnerId: w.buyer.id,
        sellerId: w.seller.id,
        finalAmount: 1_000,
        status: 'DELIVERED',
      },
    });
    await prisma.sellerReview.create({
      data: {
        transactionId: transaction.id,
        auctionId: deliveredAuction.id,
        buyerId: w.buyer.id,
        sellerId: w.seller.id,
        stars: 5,
      },
    });
    vi.spyOn(prisma.sellerReview, 'findUnique').mockResolvedValueOnce(null);

    const res = await request(app)
      .post(api('/reviews'))
      .set(auth(w.buyer.token))
      .send({ transactionId: transaction.id, stars: 3 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("You've already reviewed this seller for this purchase.");
  });
});
