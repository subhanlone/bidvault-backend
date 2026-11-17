/**
 * POST /auctions/:auctionId/end-now (2026-11-18): the seller ends their own live auction early
 * and the highest bidder wins, as if its time had run out. Only with bids and the reserve met (or
 * none set); the seller must confirm the highest bid they saw (expectedBid).
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
let emit: ReturnType<typeof vi.fn>;
let rooms: string[];

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
  emit = vi.fn();
  rooms = [];
  app.set('io', { to: vi.fn((room: string) => { rooms.push(room); return { emit }; }) });
});

afterEach(() => {
  takeViolations();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

const endNow = (token: string, expectedBid: number, auctionId = w.liveAuctionId) =>
  request(app).post(api(`/auctions/${auctionId}/end-now`)).set(auth(token)).send({ expectedBid });

/** The seeded live auction has one bid of PKR 21,000 by `buyer` and a reserve of 25,000. */
async function reserveMet() {
  await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { reservePrice: 20_000 } });
}

describe('ending an auction now', () => {
  it('sells it to the highest bidder with a payment deadline, as a normal close would', async () => {
    await reserveMet();
    const before = Date.now();

    const res = await endNow(w.seller.token, 21_000);

    expect(res.status).toBe(200);
    expect(resData(res)).toEqual({ auctionId: w.liveAuctionId, status: 'CLOSED', sold: true, finalAmount: 21_000 });
    expect(takeViolations()).toEqual([]);

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(auction.status).toBe('CLOSED');
    expect(auction.reserveMet).toBe(true);
    expect(auction.endTime.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(auction.endTime.getTime()).toBeLessThanOrEqual(Date.now());

    const sale = await prisma.auctionTransaction.findUniqueOrThrow({ where: { auctionId: w.liveAuctionId } });
    expect(sale).toMatchObject({ winnerId: w.buyer.id, sellerId: w.seller.id, finalAmount: 21_000, status: 'PENDING' });
    expect(sale.paymentDueAt).not.toBeNull();
    expect(sale.paymentDueAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('tells the winner the seller ended it early', async () => {
    await reserveMet();
    await endNow(w.seller.token, 21_000);

    // The seeded world already holds an older AUCTION_WON for `buyer` (the closed auction).
    const won = await prisma.notification.findFirstOrThrow({
      where: { userId: w.buyer.id, type: 'AUCTION_WON', message: { contains: 'Live Test Auction' } },
    });
    expect(won.message).toContain('The seller ended "Live Test Auction" early');
    expect(won.message).toContain('PKR 21,000');
  });

  it('records it in the audit log with the seller as the actor', async () => {
    await reserveMet();
    await endNow(w.seller.token, 21_000);

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'AUCTION_ENDED_EARLY', entityId: w.liveAuctionId } });
    expect(row.actorUserId).toBe(w.seller.id);
    expect(row.metadata).toMatchObject({ highestBid: 21_000, bidCount: 1 });
  });

  it('tells everyone watching the auction, guests included, that it has ended', async () => {
    await reserveMet();
    await endNow(w.seller.token, 21_000);

    const ended = emit.mock.calls.filter(([event]) => event === 'auction:ended');
    expect(ended).toHaveLength(1);
    expect(ended[0][1]).toEqual({ auctionId: w.liveAuctionId });
    expect(rooms).toContain(`auction:${w.liveAuctionId}`);
  });

  it('refuses any bid after it has ended', async () => {
    await reserveMet();
    await endNow(w.seller.token, 21_000);

    const late = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/bids`))
      .set(auth(w.otherBuyer.token))
      .send({ amount: 30_000 });
    expect(late.status).toBe(422);
    expect(await prisma.bid.count({ where: { auctionId: w.liveAuctionId } })).toBe(1);
  });

  it('works on an auction with no reserve', async () => {
    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { reservePrice: null } });
    const res = await endNow(w.seller.token, 21_000);
    expect(res.status).toBe(200);
    expect(resData<{ sold: boolean }>(res).sold).toBe(true);
  });
});

describe('what it refuses', () => {
  async function expectNothingEnded() {
    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(auction.status).toBe('ACTIVE');
    expect(auction.endTime.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.auctionTransaction.count({ where: { auctionId: w.liveAuctionId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'AUCTION_ENDED_EARLY' } })).toBe(0);
    expect(emit.mock.calls.filter(([event]) => event === 'auction:ended')).toHaveLength(0);
  }

  it('a reserve that has not been met', async () => {
    const res = await endNow(w.seller.token, 21_000);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('The reserve price has not been met yet.');
    await expectNothingEnded();
  });

  it('a highest bid that has changed since the seller looked', async () => {
    await reserveMet();
    const res = await endNow(w.seller.token, 20_500);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('PKR 21,000');
    await expectNothingEnded();
  });

  it('someone who is not the seller', async () => {
    await reserveMet();
    expect((await endNow(w.otherSeller.token, 21_000)).status).toBe(403);
    expect((await endNow(w.buyer.token, 21_000)).status).toBe(403);
    await expectNothingEnded();
  });

  it('an auction with no bids, which is cancelled instead', async () => {
    await prisma.bid.deleteMany({ where: { auctionId: w.liveAuctionId } });
    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { bidCount: 0, reservePrice: null } });
    const res = await endNow(w.seller.token, 21_000);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Cancel it instead');
  });

  it('an auction that is no longer live', async () => {
    await reserveMet();
    expect((await endNow(w.seller.token, 21_000)).status).toBe(200);
    const again = await endNow(w.seller.token, 21_000);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Only a live auction can be ended.');
    expect(await prisma.auctionTransaction.count({ where: { auctionId: w.liveAuctionId } })).toBe(1);
  });

  it('an unknown auction, and a missing or bad expectedBid', async () => {
    expect((await endNow(w.seller.token, 21_000, 'no-such-auction')).status).toBe(404);
    const bad = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/end-now`))
      .set(auth(w.seller.token))
      .send({ expectedBid: 'lots' });
    expect(bad.status).toBe(400);
    const none = await request(app).post(api(`/auctions/${w.liveAuctionId}/end-now`)).send({ expectedBid: 21_000 });
    expect(none.status).toBe(401);
  });
});
