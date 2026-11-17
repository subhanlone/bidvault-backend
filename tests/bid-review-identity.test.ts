/**
 * Who a bid or a review shows as.
 *
 * BV-039 masked the bidder ("Bidder N") on GET /:auctionId/bids and the bid:placed broadcast,
 * and the reviewer ("Reviewer N") on GET /reviews/seller/:sellerId. On 2026-11-18 the product
 * owner decided to show real names instead. What stays from BV-039:
 * - the bid feed is for signed-in members only (D10, tests/guest-browsing.test.ts);
 * - neither feed carries buyerId, an email or a phone, only the name;
 * - `isMine` still marks the caller's own bids, computed server-side from the token.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData, type Paginated } from './helpers/api.js';

interface PublicBidItem {
  bidId: string;
  auctionId: string;
  isMine: boolean;
  buyerName: string;
  amount: number;
  timestamp: string;
}

interface PublicReview {
  buyerName: string;
}

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(() => Promise.resolve({ data: { id: 'email_test' }, error: null })) };
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

async function nameOf(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } })).name;
}

/** Fails if the serialized body carries any id, email or phone of the given users. */
function expectNoContactDetails(body: unknown, users: { id: string; email: string }[]) {
  const text = JSON.stringify(body);
  for (const u of users) {
    expect(text).not.toContain(u.id);
    expect(text).not.toContain(u.email);
  }
  expect(text).not.toMatch(/"(buyerId|email|phone|buyerEmail|buyerPhone)"/);
}

async function freshAuction() {
  const listing = await prisma.listing.create({
    data: {
      listingCode: `TEST-IDENT-${Math.random().toString(36).slice(2, 8)}`,
      sellerId: w.seller.id,
      title: 'Bidder Identity Test Auction',
      category: 'Electronics & Gadgets',
      condition: 'NEW',
      description: 'Seeded by the bid and review identity suite.',
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

describe('bid feed', () => {
  it('shows every bidder by real name to the seller, a bidder and the admin, with no ids or contact details', async () => {
    const auctionId = await freshAuction();
    await request(app).post(api(`/auctions/${auctionId}/bids`)).set(auth(w.buyer.token)).send({ amount: 1_000 });
    await request(app).post(api(`/auctions/${auctionId}/bids`)).set(auth(w.otherBuyer.token)).send({ amount: 1_100 });
    const buyerName = await nameOf(w.buyer.id);
    const otherBuyerName = await nameOf(w.otherBuyer.id);

    // The seller never bid here, so nothing is marked as theirs.
    const asSeller = await request(app).get(api(`/auctions/${auctionId}/bids`)).set(auth(w.seller.token));
    expect(asSeller.status).toBe(200);
    const sellerItems = resData<Paginated<PublicBidItem>>(asSeller).items;
    // Newest first: otherBuyer's 1,100 bid, then buyer's 1,000 bid.
    expect(sellerItems.map((i) => i.buyerName)).toEqual([otherBuyerName, buyerName]);
    expect(sellerItems.every((i) => i.isMine === false)).toBe(true);
    expectNoContactDetails(asSeller.body, [w.buyer, w.otherBuyer]);

    // A bidder sees the other bidder's real name too, and only their own bid is marked as theirs.
    const asBuyer = await request(app).get(api(`/auctions/${auctionId}/bids`)).set(auth(w.buyer.token));
    const buyerItems = resData<Paginated<PublicBidItem>>(asBuyer).items;
    expect(buyerItems.map((i) => [i.buyerName, i.isMine])).toEqual([[otherBuyerName, false], [buyerName, true]]);
    expectNoContactDetails(asBuyer.body, [w.otherBuyer]);

    // The admin monitor reads the same feed: real names, nothing marked as the admin's.
    const asAdmin = await request(app).get(api(`/auctions/${auctionId}/bids`)).set(auth(w.admin.token));
    const adminItems = resData<Paginated<PublicBidItem>>(asAdmin).items;
    expect(adminItems.map((i) => i.buyerName)).toEqual([otherBuyerName, buyerName]);
    expect(adminItems.every((i) => i.isMine === false)).toBe(true);
    expectNoContactDetails(asAdmin.body, [w.buyer, w.otherBuyer]);
  });

  it('labels a bid whose account was deleted as "Deleted user"', async () => {
    const auctionId = await freshAuction();
    // BV-018: a deleted account's bid survives with buyerId cleared.
    await prisma.bid.create({ data: { auctionId, buyerId: null, amount: 1_000 } });

    const res = await request(app).get(api(`/auctions/${auctionId}/bids`)).set(auth(w.seller.token));
    expect(res.status).toBe(200);
    const items = resData<Paginated<PublicBidItem>>(res).items;
    expect(items).toHaveLength(1);
    expect(items[0].buyerName).toBe('Deleted user');
    expect(items[0].isMine).toBe(false);
  });

  it('sends the real name, and no buyerId, on the bid:placed socket broadcast', async () => {
    const auctionId = await freshAuction();

    const res = await request(app)
      .post(api(`/auctions/${auctionId}/bids`))
      .set(auth(w.buyer.token))
      .send({ amount: 1_000 });
    expect(res.status).toBe(201);
    // The bidder's own direct response keeps full identity -- it's their own action.
    expect(resData<{ buyerId: string }>(res).buyerId).toBe(w.buyer.id);

    // The seller's own room is also told (bid:received, numbers only, tests/bid-received-notification
    // .test.ts), so find the live-bidding broadcast by its event name instead of assuming it is the
    // only emit.
    const placed = emit.mock.calls.filter(([event]) => event === 'bid:placed');
    expect(placed).toHaveLength(1);
    const [, payload] = placed[0] as [string, { auctionId: string; bid: Record<string, unknown> }];
    expect(payload.bid.buyerName).toBe(await nameOf(w.buyer.id));
    expectNoContactDetails(payload, [w.buyer]);

    const received = emit.mock.calls.filter(([event]) => event === 'bid:received');
    expect(received).toHaveLength(1);
    expectNoContactDetails(received[0][1], [w.buyer]);
  });
});

describe('public seller reviews', () => {
  async function deliveredTransaction(buyerId: string, listingCodeSuffix: string) {
    const listing = await prisma.listing.create({
      data: {
        listingCode: `TEST-REVIDENT-${listingCodeSuffix}`,
        sellerId: w.seller.id,
        title: `Delivered Item ${listingCodeSuffix}`,
        category: 'Electronics & Gadgets',
        condition: 'USED',
        description: 'Seeded by the bid and review identity suite.',
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

  it('shows each reviewer by real name to a guest, with no ids or contact details', async () => {
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

    // No token: the seller's reviews are public.
    const res = await request(app).get(api(`/reviews/seller/${w.seller.id}`));
    expect(res.status).toBe(200);
    const reviews = resData<{ reviews: PublicReview[] }>(res).reviews;
    // Newest first: otherBuyer's review, then buyer's.
    expect(reviews.map((r) => r.buyerName)).toEqual([await nameOf(w.otherBuyer.id), await nameOf(w.buyer.id)]);
    expectNoContactDetails(res.body, [w.buyer, w.otherBuyer]);
  });
});
