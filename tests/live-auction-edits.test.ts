/**
 * Live edits (2026-11-28, the FYP mid panel): the seller of a live auction
 *   - PATCH /auctions/:auctionId/min-increment raises or lowers the minimum increment, within the
 *     listing bounds (1 to maxBidIncrement) and never in the auction's final hour;
 *   - PATCH /auctions/:auctionId/reserve lowers a reserve the bids have not reached, at any time,
 *     to below the old one but not below the starting price; at or below the current bid it is met.
 * Only the Auction changes, never the Listing, and the auction's room is told to refetch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData, resError } from './helpers/api.js';

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

// The seeded live auction: start 20,000, reserve 25,000, increment 1,000, one bid of 21,000 by
// `buyer`, seven days left.
const setIncrement = (token: string, minIncrement: unknown, auctionId = w.liveAuctionId) =>
  request(app).patch(api(`/auctions/${auctionId}/min-increment`)).set(auth(token)).send({ minIncrement });
const setReserve = (token: string, reservePrice: unknown, auctionId = w.liveAuctionId) =>
  request(app).patch(api(`/auctions/${auctionId}/reserve`)).set(auth(token)).send({ reservePrice });
const bid = (token: string, amount: number) =>
  request(app).post(api(`/auctions/${w.liveAuctionId}/bids`)).set(auth(token)).send({ amount });
const live = () => prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
const endsIn = (ms: number) =>
  prisma.auction.update({ where: { id: w.liveAuctionId }, data: { endTime: new Date(Date.now() + ms) } });
const MINUTE = 60 * 1000;

describe('changing the minimum increment', () => {
  it('raises it: the next bid must clear the new increment, and the room is told the new value', async () => {
    const res = await setIncrement(w.seller.token, 5_000);

    expect(res.status).toBe(200);
    expect(resData(res)).toEqual({ auctionId: w.liveAuctionId, minIncrement: 5_000 });
    expect(takeViolations()).toEqual([]);
    expect((await live()).minIncrement).toBe(5_000);
    expect(rooms).toContain(`auction:${w.liveAuctionId}`);
    expect(emit).toHaveBeenCalledWith('auction:updated', { auctionId: w.liveAuctionId, minIncrement: 5_000 });

    // The bid route reads the increment under the same row lock: 21,000 + 5,000.
    expect((await bid(w.otherBuyer.token, 22_000)).status).toBe(422);
    expect((await bid(w.otherBuyer.token, 26_000)).status).toBe(201);
  });

  it('lowers it, and only the auction changes: the listing keeps its approved increment', async () => {
    const res = await setIncrement(w.seller.token, 100);

    expect(res.status).toBe(200);
    const auction = await live();
    expect(auction.minIncrement).toBe(100);
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: auction.listingId } });
    expect(listing.minIncrement).toBe(1_000);
    expect((await bid(w.otherBuyer.token, 21_100)).status).toBe(201);
  });

  it('writes an audit row with the old and new values', async () => {
    await setIncrement(w.seller.token, 2_000);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'AUCTION_INCREMENT_CHANGED', entityId: w.liveAuctionId },
    });
    expect(row.actorUserId).toBe(w.seller.id);
    expect(row.metadata).toEqual({ from: 1_000, to: 2_000 });
  });

  it('treats the same value as no change: nothing is written or announced', async () => {
    const res = await setIncrement(w.seller.token, 1_000);

    expect(res.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'AUCTION_INCREMENT_CHANGED' } })).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('is locked in the final hour, up and down', async () => {
    await endsIn(59 * MINUTE);

    for (const value of [5_000, 100]) {
      const res = await setIncrement(w.seller.token, value);
      expect(res.status).toBe(409);
      expect(resError(res).error).toBe('The minimum increment cannot be changed in the final hour of the auction.');
    }
    expect((await live()).minIncrement).toBe(1_000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('is still open just before the final hour', async () => {
    await endsIn(61 * MINUTE);
    expect((await setIncrement(w.seller.token, 5_000)).status).toBe(200);
  });

  it('is capped at the platform maxBidIncrement, as on a listing', async () => {
    const res = await setIncrement(w.seller.token, 500_001);

    expect(res.status).toBe(422);
    expect(resError(res).details).toHaveProperty('minIncrement');
    expect(resError(res).error).toBe('Minimum bid increment cannot exceed PKR 500,000.');
    expect((await live()).minIncrement).toBe(1_000);
  });

  it('refuses anything but a positive whole number', async () => {
    for (const value of [0, -500, 12.5, '1000', null]) {
      expect((await setIncrement(w.seller.token, value)).status).toBe(400);
    }
  });

  it('is for the auction\'s own seller only', async () => {
    expect((await setIncrement(w.buyer.token, 5_000)).status).toBe(403);
    expect((await setIncrement(w.otherSeller.token, 5_000)).status).toBe(403);
    expect((await request(app).patch(api(`/auctions/${w.liveAuctionId}/min-increment`)).send({ minIncrement: 5_000 })).status).toBe(401);
    expect((await live()).minIncrement).toBe(1_000);
  });

  it('answers 404 for an unknown auction and 409 for one that is not live', async () => {
    expect((await setIncrement(w.seller.token, 5_000, 'no-such-auction')).status).toBe(404);

    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { status: 'CLOSED' } });
    const res = await setIncrement(w.seller.token, 5_000);
    expect(res.status).toBe(409);
    expect(resError(res).error).toBe('Only a live auction can be changed.');
  });
});

describe('lowering the reserve', () => {
  it('lowers it while still above the current bid: not met yet, and the amount is never broadcast', async () => {
    const res = await setReserve(w.seller.token, 23_000);

    expect(res.status).toBe(200);
    expect(resData(res)).toEqual({ auctionId: w.liveAuctionId, reservePrice: 23_000, reserveMet: false });
    expect(takeViolations()).toEqual([]);
    expect((await live()).reservePrice).toBe(23_000);
    expect(emit).toHaveBeenCalledWith('auction:updated', { auctionId: w.liveAuctionId });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('23000');

    const page = await request(app).get(api(`/auctions/${w.liveAuctionId}`)).set(auth(w.buyer.token));
    expect(resData<{ reserveMet: boolean | null }>(page).reserveMet).toBe(false);
  });

  it('lowered to the current bid, the reserve is met and the seller can conclude the sale', async () => {
    const res = await setReserve(w.seller.token, 21_000);

    expect(resData(res)).toEqual({ auctionId: w.liveAuctionId, reservePrice: 21_000, reserveMet: true });
    const page = await request(app).get(api(`/auctions/${w.liveAuctionId}`)).set(auth(w.buyer.token));
    expect(resData<{ reserveMet: boolean | null }>(page).reserveMet).toBe(true);

    const ended = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/end-now`))
      .set(auth(w.seller.token))
      .send({ expectedBid: 21_000 });
    expect(ended.status).toBe(200);
    expect(resData(ended)).toMatchObject({ sold: true, finalAmount: 21_000 });
  });

  it('keeps the listing\'s approved reserve and writes an audit row', async () => {
    await setReserve(w.seller.token, 22_000);

    const auction = await live();
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: auction.listingId } });
    expect(listing.reservePrice).toBe(25_000);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'AUCTION_RESERVE_LOWERED', entityId: w.liveAuctionId },
    });
    expect(row.actorUserId).toBe(w.seller.id);
    expect(row.metadata).toEqual({ from: 25_000, to: 22_000, currentBid: 21_000 });
  });

  it('is allowed in the final hour: a lower reserve only helps the bidders', async () => {
    await endsIn(10 * MINUTE);
    expect((await setReserve(w.seller.token, 21_000)).status).toBe(200);
  });

  it('must go lower than the current reserve', async () => {
    for (const value of [25_000, 30_000]) {
      const res = await setReserve(w.seller.token, value);
      expect(res.status).toBe(422);
      expect(resError(res).details).toHaveProperty('reservePrice');
      expect(resError(res).error).toBe('The new reserve must be lower than the current one.');
    }
  });

  it('cannot go below the starting price', async () => {
    const res = await setReserve(w.seller.token, 19_999);

    expect(res.status).toBe(422);
    expect(resError(res).error).toBe('The reserve cannot be below the starting price of PKR 20,000.');
    expect((await live()).reservePrice).toBe(25_000);
  });

  it('is refused with no reserve, with no bids, or once the reserve is already met', async () => {
    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { reservePrice: 21_000 } });
    let res = await setReserve(w.seller.token, 20_500);
    expect(res.status).toBe(409);
    expect(resError(res).error).toBe('The reserve price is already met.');

    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { reservePrice: 25_000, bidCount: 0, currentBid: 20_000 } });
    res = await setReserve(w.seller.token, 22_000);
    expect(res.status).toBe(409);
    expect(resError(res).error).toBe('The reserve can be lowered once the auction has a bid. With no bids, cancel it instead.');

    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { reservePrice: null, bidCount: 1, currentBid: 21_000 } });
    res = await setReserve(w.seller.token, 22_000);
    expect(res.status).toBe(409);
    expect(resError(res).error).toBe('This auction has no reserve price.');
    expect(emit).not.toHaveBeenCalled();
  });

  it('is for the auction\'s own seller only, and for a live auction', async () => {
    expect((await setReserve(w.buyer.token, 22_000)).status).toBe(403);
    expect((await setReserve(w.otherSeller.token, 22_000)).status).toBe(403);
    expect((await setReserve(w.seller.token, 22_000, 'no-such-auction')).status).toBe(404);
    expect((await setReserve(w.seller.token, 0)).status).toBe(400);

    await endsIn(-MINUTE);
    const res = await setReserve(w.seller.token, 22_000);
    expect(res.status).toBe(409);
    expect((await live()).reservePrice).toBe(25_000);
  });
});

describe('who sees the live values', () => {
  type AuctionView = { reservePrice?: number; reserveMet: boolean | null; minIncrement: number };
  const detail = (token?: string) => {
    const req = request(app).get(api(`/auctions/${w.liveAuctionId}`));
    return token ? req.set(auth(token)) : req;
  };

  it('gives the reserve amount to the auction\'s own seller, and to nobody else', async () => {
    const own = await detail(w.seller.token);
    expect(own.status).toBe(200);
    expect(resData<AuctionView>(own).reservePrice).toBe(25_000);
    expect(takeViolations()).toEqual([]);

    for (const token of [undefined, w.buyer.token, w.otherBuyer.token, w.otherSeller.token, w.admin.token, 'not-a-token']) {
      const res = await detail(token);
      expect(res.status).toBe(200);
      expect(resData<AuctionView>(res)).not.toHaveProperty('reservePrice');
      expect(resData<AuctionView>(res).reserveMet).toBe(false);
    }
  });

  it('gives the seller the lowered reserve, and no field at all when there is none', async () => {
    await setReserve(w.seller.token, 22_000);
    expect(resData<AuctionView>(await detail(w.seller.token)).reservePrice).toBe(22_000);

    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { reservePrice: null } });
    const res = await detail(w.seller.token);
    expect(resData<AuctionView>(res)).not.toHaveProperty('reservePrice');
    expect(resData<AuctionView>(res).reserveMet).toBeNull();
  });

  it('never puts the reserve in the public auction list', async () => {
    const res = await request(app).get(api('/auctions')).set(auth(w.seller.token));
    expect(res.status).toBe(200);
    const items = resData<{ items: Array<{ auctionId: string }> }>(res).items;
    expect(items.some((a) => a.auctionId === w.liveAuctionId)).toBe(true);
    expect(JSON.stringify(items)).not.toContain('reservePrice');
  });

  it('shows My Items the auction\'s live increment and reserve, and the listing\'s approved ones', async () => {
    await setIncrement(w.seller.token, 3_000);
    await setReserve(w.seller.token, 22_000);

    const res = await request(app).get(api('/seller/items?tab=live')).set(auth(w.seller.token));
    expect(res.status).toBe(200);
    expect(takeViolations()).toEqual([]);
    type Item = {
      auction?: { auctionId: string; minIncrement: number; reservePrice?: number };
      listing: { minIncrement: number; reservePrice?: number };
    };
    const item = resData<{ items: Item[] }>(res).items.find((i) => i.auction?.auctionId === w.liveAuctionId);
    expect(item?.auction).toMatchObject({ minIncrement: 3_000, reservePrice: 22_000 });
    expect(item?.listing).toMatchObject({ minIncrement: 1_000, reservePrice: 25_000 });
  });
});
