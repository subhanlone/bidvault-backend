/**
 * The bid floor on POST /auctions/:id/bids — BV-013.
 *
 * currentBid is seeded to startPrice when an auction is created, so requiring every bid to
 * clear it by a full minIncrement made the advertised starting price itself unbiddable: the
 * real floor was one increment above what both the seller set and the buyer was shown. The
 * first bid is now allowed at the start price, matching eBay's convention; every bid after
 * that must still clear the previous one by a full increment, unchanged.
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

/** A freshly APPROVED-and-ACTIVE auction with no bids yet — liveAuctionId in world.ts already has one. */
async function freshAuction(startPrice: number, minIncrement: number) {
  const listing = await prisma.listing.create({
    data: {
      listingCode: `TEST-BID-${Math.random().toString(36).slice(2, 8)}`,
      sellerId: w.seller.id,
      title: 'Fresh Zero-Bid Auction',
      category: 'Electronics & Gadgets',
      condition: 'NEW',
      description: 'Seeded by the bid-placement suite, no bids placed yet.',
      startPrice,
      minIncrement,
      durationDays: 1,
      status: 'APPROVED',
    },
  });
  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id,
      sellerId: w.seller.id,
      title: listing.title,
      category: listing.category,
      condition: listing.condition,
      description: listing.description,
      startPrice,
      minIncrement,
      currentBid: startPrice,
      bidCount: 0,
      status: 'ACTIVE',
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return auction.id;
}

describe('starting-price bid floor', () => {
  it('accepts a first bid at exactly the advertised starting price', async () => {
    const auctionId = await freshAuction(10_000, 500);

    const res = await request(app)
      .post(api(`/auctions/${auctionId}/bids`))
      .set(auth(w.buyer.token))
      .send({ amount: 10_000 });

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(10_000);
    expect((await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } })).currentBid).toBe(10_000);
  });

  it('still rejects a first bid below the starting price', async () => {
    const auctionId = await freshAuction(10_000, 500);

    const res = await request(app)
      .post(api(`/auctions/${auctionId}/bids`))
      .set(auth(w.buyer.token))
      .send({ amount: 9_999 });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('PKR 10,000');
  });

  it('requires a full increment above the first bid for the second one', async () => {
    const auctionId = await freshAuction(10_000, 500);
    await request(app).post(api(`/auctions/${auctionId}/bids`)).set(auth(w.buyer.token)).send({ amount: 10_000 });

    const tooLow = await request(app)
      .post(api(`/auctions/${auctionId}/bids`))
      .set(auth(w.otherBuyer.token))
      .send({ amount: 10_400 });
    expect(tooLow.status).toBe(422);
    expect(tooLow.body.error).toContain('PKR 10,500');

    const ok = await request(app)
      .post(api(`/auctions/${auctionId}/bids`))
      .set(auth(w.otherBuyer.token))
      .send({ amount: 10_500 });
    expect(ok.status).toBe(201);
  });
});
