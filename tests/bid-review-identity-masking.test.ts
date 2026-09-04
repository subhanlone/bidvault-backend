/**
 * Bidder and reviewer identity masking on the two unauthenticated feeds (BV-039).
 *
 * GET /:auctionId/bids and GET /reviews/seller/:sellerId are both public -- no requireAuth --
 * so an anonymous visitor could previously enumerate exactly who bid, how much, when, and
 * correlate one person's bidding across the whole platform via buyerId. Both now mask the
 * bidder/reviewer to a stable pseudonym; the bids feed additionally exposes `isMine`, computed
 * server-side from the caller's own token when one is present, so the caller's own bids are
 * still distinguishable without revealing anyone's real identity.
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
let emit: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
  emit = vi.fn();
  app.set('io', { to: vi.fn(() => ({ emit })) });
});

afterEach(() => {
  takeViolations();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

async function freshAuction() {
  const listing = await prisma.listing.create({
    data: {
      listingCode: `TEST-MASK-${Math.random().toString(36).slice(2, 8)}`,
      sellerId: w.seller.id,
      title: 'Identity Masking Test Auction',
      category: 'Electronics & Gadgets',
      condition: 'NEW',
      description: 'Seeded by the identity-masking suite.',
      startPrice: 1_000,
      minIncrement: 100,
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
      startPrice: listing.startPrice,
      minIncrement: listing.minIncrement,
      currentBid: listing.startPrice,
      bidCount: 0,
      status: 'ACTIVE',
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return auction.id;
}

describe('public bid feed', () => {
  it('masks every bidder, drops buyerId, and marks only the caller\'s own bids as mine', async () => {
    const auctionId = await freshAuction();
    // w.buyer bids first, then w.otherBuyer -- first-appearance order should drive numbering.
    await request(app).post(api(`/auctions/${auctionId}/bids`)).set(auth(w.buyer.token)).send({ amount: 1_000 });
    await request(app).post(api(`/auctions/${auctionId}/bids`)).set(auth(w.otherBuyer.token)).send({ amount: 1_100 });

    const anon = await request(app).get(api(`/auctions/${auctionId}/bids`));
    expect(anon.status).toBe(200);
    for (const item of anon.body.data.items) {
      expect(item).not.toHaveProperty('buyerId');
      expect(item.isMine).toBe(false);
    }
    // Newest first: otherBuyer's 1,100 bid, then buyer's 1,000 bid.
    expect(anon.body.data.items[0].buyerName).toBe('Bidder 2');
    expect(anon.body.data.items[1].buyerName).toBe('Bidder 1');

    const asBuyer = await request(app).get(api(`/auctions/${auctionId}/bids`)).set(auth(w.buyer.token));
    const mine = asBuyer.body.data.items.filter((i: { isMine: boolean }) => i.isMine);
    expect(mine).toHaveLength(1);
    expect(mine[0].buyerName).toBe('Bidder 1');

    // An authenticated caller who never bid on this auction sees the same masked view as anon.
    const asAdmin = await request(app).get(api(`/auctions/${auctionId}/bids`)).set(auth(w.admin.token));
    expect(asAdmin.body.data.items.every((i: { isMine: boolean }) => i.isMine === false)).toBe(true);
  });

  it('never sends buyerId on the bid:placed socket broadcast, and masks the name there too', async () => {
    const auctionId = await freshAuction();

    const res = await request(app)
      .post(api(`/auctions/${auctionId}/bids`))
      .set(auth(w.buyer.token))
      .send({ amount: 1_000 });
    expect(res.status).toBe(201);
    // The bidder's own direct response keeps full identity -- it's their own action.
    expect(res.body.data.buyerId).toBe(w.buyer.id);

    expect(emit).toHaveBeenCalledTimes(1);
    const [, payload] = emit.mock.calls[0] as [string, { auctionId: string; bid: Record<string, unknown> }];
    expect(payload.bid).not.toHaveProperty('buyerId');
    expect(payload.bid.buyerName).toBe('Bidder 1');
  });
});

describe('public seller reviews', () => {
  async function deliveredTransaction(buyerId: string, listingCodeSuffix: string) {
    const listing = await prisma.listing.create({
      data: {
        listingCode: `TEST-REVMASK-${listingCodeSuffix}`,
        sellerId: w.seller.id,
        title: `Delivered Item ${listingCodeSuffix}`,
        category: 'Electronics & Gadgets',
        condition: 'USED',
        description: 'Seeded by the review-masking suite.',
        startPrice: 1_000,
        minIncrement: 100,
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
        startPrice: listing.startPrice,
        minIncrement: listing.minIncrement,
        currentBid: listing.startPrice,
        bidCount: 1,
        status: 'CLOSED',
        startTime: new Date(Date.now() - 48 * 60 * 60 * 1000),
        endTime: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    return prisma.auctionTransaction.create({
      data: {
        auctionId: auction.id,
        winnerId: buyerId,
        sellerId: w.seller.id,
        finalAmount: 1_000,
        status: 'DELIVERED',
      },
    });
  }

  it('masks reviewer names to a stable pseudonym instead of the real name', async () => {
    const tx1 = await deliveredTransaction(w.buyer.id, '1');
    const tx2 = await deliveredTransaction(w.otherBuyer.id, '2');

    const first = await request(app)
      .post(api('/reviews'))
      .set(auth(w.buyer.token))
      .send({ transactionId: tx1.id, stars: 5 });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(api('/reviews'))
      .set(auth(w.otherBuyer.token))
      .send({ transactionId: tx2.id, stars: 4 });
    expect(second.status).toBe(201);

    const res = await request(app).get(api(`/reviews/seller/${w.seller.id}`));
    expect(res.status).toBe(200);
    for (const r of res.body.data.reviews) {
      expect(r.buyerName).toMatch(/^Reviewer \d+$/);
    }
    // Newest first: otherBuyer's review, then buyer's.
    expect(res.body.data.reviews[0].buyerName).toBe('Reviewer 2');
    expect(res.body.data.reviews[1].buyerName).toBe('Reviewer 1');
  });
});
