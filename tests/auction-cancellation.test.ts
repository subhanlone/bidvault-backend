/**
 * Phase 6 (LIFECYCLE-IMPLEMENTATION-PLAN.md): B4 (seller withdraws their own bid-free auction)
 * and C4 (admin cancels any auction regardless of bid count, notifying every bidder).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mail = vi.hoisted(() => ({ send: vi.fn(async () => ({ data: { id: 'email_test' }, error: null })) }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mail.send };
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
  mail.send.mockClear();
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

async function bidFreeAuction(sellerId: string, listingCode: string) {
  const listing = await prisma.listing.create({
    data: {
      listingCode,
      sellerId,
      title: 'Bid-Free Auction',
      category: 'Electronics & Gadgets',
      condition: 'NEW',
      description: 'An auction with no bids yet, used by the cancellation suite.',
      startPrice: 5_000,
      minIncrement: 200,
      durationDays: 2,
      status: 'APPROVED',
    },
  });
  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id,
      sellerId,
      title: listing.title,
      category: listing.category,
      condition: listing.condition,
      description: listing.description,
      startPrice: listing.startPrice,
      minIncrement: listing.minIncrement,
      currentBid: listing.startPrice,
      bidCount: 0,
      status: 'ACTIVE',
      startTime: new Date(),
      endTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    },
  });
  return { listing, auction };
}

describe('seller cancels their own auction (B4)', () => {
  it('cancels a bid-free auction and lists it as CANCELLED afterward', async () => {
    const { auction } = await bidFreeAuction(w.seller.id, 'TEST-CANCEL-1');

    const res = await request(app)
      .post(api(`/auctions/${auction.id}/cancel`))
      .set(auth(w.seller.token))
      .send({ reason: 'Changed my mind about selling this.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');

    const row = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    expect(row.status).toBe('CANCELLED');
  });

  it('refuses to cancel an auction that already has a bid', async () => {
    // w.liveAuctionId has one bid seeded by world.ts.
    const res = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/cancel`))
      .set(auth(w.seller.token))
      .send({ reason: 'Trying to pull it anyway.' });
    expect(res.status).toBe(409);

    const row = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(row.status).toBe('ACTIVE');
  });

  it("refuses to cancel another seller's auction", async () => {
    const { auction } = await bidFreeAuction(w.otherSeller.id, 'TEST-CANCEL-2');
    const res = await request(app)
      .post(api(`/auctions/${auction.id}/cancel`))
      .set(auth(w.seller.token))
      .send({ reason: 'Not mine.' });
    expect(res.status).toBe(403);
  });

  it('rejects a cancel reason shorter than the minimum', async () => {
    const { auction } = await bidFreeAuction(w.seller.id, 'TEST-CANCEL-3');
    const res = await request(app)
      .post(api(`/auctions/${auction.id}/cancel`))
      .set(auth(w.seller.token))
      .send({ reason: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('admin cancels any auction (C4)', () => {
  it('cancels an auction with bids and notifies the bidder', async () => {
    const res = await request(app)
      .post(api(`/admin/auctions/${w.liveAuctionId}/cancel`))
      .set(auth(w.admin.token))
      .send({ reason: 'Suspected shill bidding.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');

    const row = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(row.status).toBe('CANCELLED');

    // Seller + the one bidder (w.buyer) both get an AUCTION_CANCELLED notification.
    const notifications = await prisma.notification.findMany({ where: { type: 'AUCTION_CANCELLED' } });
    const recipients = notifications.map((n) => n.userId).sort();
    expect(recipients).toEqual([w.buyer.id, w.seller.id].sort());

    // Email dispatch is fire-and-forget; give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.send).toHaveBeenCalled();
  });

  it('a non-admin cannot use the admin cancel route', async () => {
    const res = await request(app)
      .post(api(`/admin/auctions/${w.liveAuctionId}/cancel`))
      .set(auth(w.seller.token))
      .send({ reason: 'Trying anyway.' });
    expect(res.status).toBe(403);
  });

  it('refuses to cancel an auction that is already CLOSED', async () => {
    const res = await request(app)
      .post(api(`/admin/auctions/${w.closedAuctionId}/cancel`))
      .set(auth(w.admin.token))
      .send({ reason: 'Too late.' });
    expect(res.status).toBe(409);
  });
});
