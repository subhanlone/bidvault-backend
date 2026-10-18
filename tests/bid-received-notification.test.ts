/**
 * The seller is told when someone bids on their auction (Phase 8, B3), in the app only: a
 * BID_RECEIVED notification and a socket event to the seller's own room.
 *
 * One unread notification per auction is kept up to date instead of one per bid. GET /notifications
 * returns the newest 50 and a busy auction would otherwise fill all of them, burying the ones that
 * matter (a payment, an approval). Once the seller reads it, the next bid starts a fresh one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData } from './helpers/api.js';

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
  app.set('io', undefined);
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

// world.ts: the seller's live auction "Live Test Auction" has one bid, buyer at 21,000, increment 1,000.
const bid = (token: string, amount: number, auctionId = w.liveAuctionId) =>
  request(app).post(api(`/auctions/${auctionId}/bids`)).set(auth(token)).send({ amount });

const received = (userId = w.seller.id) =>
  prisma.notification.findMany({ where: { userId, type: 'BID_RECEIVED' }, orderBy: { createdAt: 'asc' } });

async function secondAuction() {
  const listing = await prisma.listing.create({
    data: {
      listingCode: 'TEST-BID-B3-2', sellerId: w.seller.id, title: 'Second Live Auction', category: 'Electronics & Gadgets',
      condition: 'NEW', description: 'A second auction for the same seller.', startPrice: 5_000, minIncrement: 500,
      durationDays: 2, status: 'APPROVED',
    },
  });
  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id, sellerId: w.seller.id, title: listing.title, category: listing.category, condition: listing.condition,
      description: listing.description, startPrice: 5_000, minIncrement: 500, currentBid: 5_000, bidCount: 0, status: 'ACTIVE',
      startTime: new Date(Date.now() - 60_000), endTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    },
  });
  return auction.id;
}

describe('the notification', () => {
  it('a bid creates one BID_RECEIVED notification for the seller', async () => {
    expect((await bid(w.otherBuyer.token, 22_000)).status).toBe(201);

    const rows = await received();
    expect(rows).toHaveLength(1);
    expect(rows[0].auctionId).toBe(w.liveAuctionId);
    expect(rows[0].isRead).toBe(false);
    expect(rows[0].title).toBe('New bid on your auction');
    expect(rows[0].message).toContain('"Live Test Auction"');
    expect(rows[0].message).toContain('PKR 22,000');
    expect(rows[0].message).toContain('2 bids');
  });

  it('a later bid updates the unread one instead of adding another', async () => {
    await bid(w.otherBuyer.token, 22_000);
    const first = (await received())[0];

    await bid(w.buyer.token, 23_000);

    const rows = await received();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].message).toContain('PKR 23,000');
    expect(rows[0].message).toContain('3 bids');
    expect(rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(first.createdAt.getTime());
  });

  it('after the seller reads it, the next bid starts a fresh one', async () => {
    await bid(w.otherBuyer.token, 22_000);
    const first = (await received())[0];
    const read = await request(app).post(api(`/notifications/${first.id}/read`)).set(auth(w.seller.token));
    expect(read.status).toBe(200);

    await bid(w.buyer.token, 23_000);

    const rows = await received();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => !r.isRead)).toHaveLength(1);
    expect(rows.find((r) => r.id === first.id)?.message).toContain('PKR 22,000');
  });

  it('each auction keeps its own', async () => {
    const other = await secondAuction();

    await bid(w.otherBuyer.token, 22_000);
    await bid(w.otherBuyer.token, 5_000, other);

    const rows = await received();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.auctionId).sort()).toEqual([w.liveAuctionId, other].sort());
  });

  it('is only for the seller: the bidder gets none, the outbid notice still goes to the previous leader', async () => {
    await bid(w.otherBuyer.token, 22_000);

    expect(await received(w.otherBuyer.id)).toHaveLength(0);
    expect(await received(w.buyer.id)).toHaveLength(0);
    const outbid = await prisma.notification.findMany({ where: { userId: w.buyer.id, type: 'BID_OUTBID' } });
    expect(outbid).toHaveLength(1);
  });

  it('two simultaneous bids still leave one unread notification, showing the real bid count', async () => {
    await Promise.all([bid(w.otherBuyer.token, 22_000), bid(w.buyer.token, 23_000)]);

    const rows = await received();
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain(`${auction.bidCount} bids`);
    expect(rows[0].message).toContain(`PKR ${auction.currentBid.toLocaleString()}`);
  });

  it('a refused bid notifies nobody', async () => {
    const res = await bid(w.otherBuyer.token, 21_000); // below the minimum

    expect(res.status).toBe(422);
    expect(await received()).toHaveLength(0);
  });

  it('comes back from GET /notifications in the documented shape, without the grouping key', async () => {
    await bid(w.otherBuyer.token, 22_000);

    const res = await request(app).get(api('/notifications')).set(auth(w.seller.token));

    expect(res.status).toBe(200);
    const row = resData<Array<Record<string, unknown>>>(res).find((n) => n.type === 'BID_RECEIVED');
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('auctionId');
    expect(takeViolations()).toEqual([]);
  });
});

describe('the seller room', () => {
  it('is told about the bid with the numbers only, never who bid', async () => {
    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    app.set('io', {
      to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
    });

    await bid(w.otherBuyer.token, 22_000);

    const toSeller = emitted.filter((e) => e.room === `seller:${w.seller.id}`);
    expect(toSeller).toHaveLength(1);
    expect(toSeller[0].event).toBe('bid:received');
    expect(toSeller[0].payload).toEqual({ auctionId: w.liveAuctionId, bidCount: 2, currentBid: 22_000 });
    // the live-bidding room still gets its own event, unchanged
    expect(emitted.some((e) => e.room === `auction:${w.liveAuctionId}` && e.event === 'bid:placed')).toBe(true);
  });
});
