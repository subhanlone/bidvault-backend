/**
 * Phase 8 (LIFECYCLE-IMPLEMENTATION-PLAN.md), the data half of seller visibility:
 *  - B1: the seller reads their auctions' live numbers from the auction (a listing is the state before any auction),
 *  - B2: GET /auctions/mine, the seller counterpart of GET /auctions/mine/bids,
 *  - trust signals on every AuctionDto: the seller's `sellerMemberSince` and the auction's
 *    `watcherCount` (decided 2026-10-14, modelled on what eBay shows next to an item).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { resData, type Paginated } from './helpers/api.js';

interface AuctionItem {
  auctionId: string;
  sellerId: string;
  status: string;
  endTime: string;
  sellerMemberSince: string;
  watcherCount: number;
}

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
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
  w = await seedWorld();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

let seq = 0;

/** An auction (with its listing) for `sellerId`, ending `endsInMs` from now. */
async function makeAuction(sellerId: string, status: 'ACTIVE' | 'CLOSED' | 'CANCELLED', endTime: Date) {
  const n = ++seq;
  const listing = await prisma.listing.create({
    data: {
      listingCode: `TEST-SV-${n}`,
      sellerId,
      title: `Seller visibility probe ${n}`,
      category: 'Electronics & Gadgets',
      condition: 'NEW',
      description: 'A probe auction for the seller visibility tests.',
      startPrice: 1_000,
      minIncrement: 100,
      durationDays: 3,
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
      startPrice: 1_000,
      minIncrement: 100,
      currentBid: 1_000,
      bidCount: 0,
      status,
      startTime: new Date(endTime.getTime() - 3 * 24 * 60 * 60 * 1000),
      endTime,
    },
  });
  return auction.id;
}

describe('B1: the seller sees auction numbers through the auction, not through the listing', () => {
  it('keeps the listing to its own state plus the link to its auction', async () => {
    const res = await request(app).get(api('/listings/mine')).set(auth(w.seller.token));
    const live = resData<Paginated<Record<string, unknown>>>(res).items.find((l) => l.auctionId === w.liveAuctionId)!;

    expect(live).toMatchObject({ isLive: true, auctionId: w.liveAuctionId });
    for (const auctionField of ['currentBid', 'bidCount', 'endTime', 'auctionStatus']) {
      expect(live).not.toHaveProperty(auctionField);
    }
  });

  it('serves those numbers from GET /auctions/mine, keyed by the same auctionId', async () => {
    const res = await request(app).get(api('/auctions/mine')).set(auth(w.seller.token));
    const live = resData<Paginated<AuctionItem & { currentBid: number; bidCount: number }>>(res).items.find(
      (a) => a.auctionId === w.liveAuctionId,
    )!;

    expect(live).toMatchObject({ currentBid: 21_000, bidCount: 1, status: 'ACTIVE' });
    expect(Number.isNaN(Date.parse(live.endTime))).toBe(false);
  });
});

describe('B2: GET /auctions/mine', () => {
  it('answers only for sellers', async () => {
    expect((await request(app).get(api('/auctions/mine'))).status).toBe(401);
    expect((await request(app).get(api('/auctions/mine')).set(auth(w.buyer.token))).status).toBe(403);
    expect((await request(app).get(api('/auctions/mine')).set(auth(w.admin.token))).status).toBe(403);
  });

  it('defaults to the seller\'s live auctions and never shows another seller\'s', async () => {
    const res = await request(app).get(api('/auctions/mine')).set(auth(w.seller.token));
    expect(res.status).toBe(200);
    const items = resData<Paginated<AuctionItem>>(res).items;

    expect(items.map((a) => a.auctionId)).toEqual([w.liveAuctionId]);
    expect(items.every((a) => a.sellerId === w.seller.id && a.status === 'ACTIVE')).toBe(true);
  });

  it('filters by status', async () => {
    const res = await request(app).get(api('/auctions/mine?status=CLOSED')).set(auth(w.seller.token));
    const items = resData<Paginated<AuctionItem>>(res).items;

    expect(items.map((a) => a.auctionId)).toEqual([w.closedAuctionId]);
  });

  it('treats an unknown status like the public list does: back to ACTIVE', async () => {
    const res = await request(app).get(api('/auctions/mine?status=NOPE')).set(auth(w.seller.token));

    expect(resData<Paginated<AuctionItem>>(res).items.map((a) => a.auctionId)).toEqual([w.liveAuctionId]);
  });

  it('lists live auctions soonest-ending first and walks the cursor without a duplicate or a gap', async () => {
    const tie = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const ids = [w.liveAuctionId];
    for (let i = 0; i < 5; i++) ids.push(await makeAuction(w.seller.id, 'ACTIVE', tie));

    const seen: string[] = [];
    const endTimes: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url: string = api(`/auctions/mine?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const res = await request(app).get(url).set(auth(w.seller.token));
      const body = resData<Paginated<AuctionItem>>(res);
      for (const a of body.items) {
        seen.push(a.auctionId);
        endTimes.push(Date.parse(a.endTime));
      }
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(endTimes).toEqual([...endTimes].sort((a, b) => a - b));
  });

  it('lists finished auctions most recent first', async () => {
    const older = await makeAuction(w.seller.id, 'CLOSED', new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const newer = await makeAuction(w.seller.id, 'CANCELLED', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));

    const closed = await request(app).get(api('/auctions/mine?status=CLOSED')).set(auth(w.seller.token));
    const closedIds = resData<Paginated<AuctionItem>>(closed).items.map((a) => a.auctionId);
    // the world's own closed auction ended an hour ago, so it is the most recent of the two closed ones
    expect(closedIds).toEqual([w.closedAuctionId, older]);

    const cancelled = await request(app).get(api('/auctions/mine?status=CANCELLED')).set(auth(w.seller.token));
    expect(resData<Paginated<AuctionItem>>(cancelled).items.map((a) => a.auctionId)).toEqual([newer]);
  });
});

describe('trust signals on every AuctionDto', () => {
  it('publishes the seller\'s member-since date, taken from the account\'s creation', async () => {
    const seller = await prisma.user.findUniqueOrThrow({ where: { id: w.seller.id } });

    const res = await request(app).get(api(`/auctions/${w.liveAuctionId}`));
    expect(res.status).toBe(200);
    expect(resData<AuctionItem>(res).sellerMemberSince).toBe(seller.createdAt.toISOString());
  });

  it('counts the people watching an auction', async () => {
    // the world has one watcher (the buyer) on the live auction
    let res = await request(app).get(api(`/auctions/${w.liveAuctionId}`));
    expect(resData<AuctionItem>(res).watcherCount).toBe(1);

    await prisma.watchlist.create({ data: { userId: w.otherBuyer.id, auctionId: w.liveAuctionId } });
    res = await request(app).get(api(`/auctions/${w.liveAuctionId}`));
    expect(resData<AuctionItem>(res).watcherCount).toBe(2);

    // an auction nobody watches reports zero rather than leaving the field out
    const unwatched = await makeAuction(w.seller.id, 'ACTIVE', new Date(Date.now() + 24 * 60 * 60 * 1000));
    res = await request(app).get(api(`/auctions/${unwatched}`));
    expect(resData<AuctionItem>(res).watcherCount).toBe(0);
  });

  it('is on every route that serves an auction, with the right count for each row', async () => {
    const list = await request(app).get(api('/auctions'));
    const live = resData<Paginated<AuctionItem>>(list).items.find((a) => a.auctionId === w.liveAuctionId)!;
    expect(live.watcherCount).toBe(1);
    expect(typeof live.sellerMemberSince).toBe('string');

    const watchlist = await request(app).get(api('/watchlist')).set(auth(w.buyer.token));
    const watched = resData<Paginated<AuctionItem>>(watchlist).items.find((a) => a.auctionId === w.liveAuctionId)!;
    expect(watched.watcherCount).toBe(1);

    const bids = await request(app).get(api('/auctions/mine/bids')).set(auth(w.buyer.token));
    const withAuction = resData<Paginated<{ auction: AuctionItem }>>(bids).items.find(
      (b) => b.auction.auctionId === w.liveAuctionId,
    )!;
    expect(withAuction.auction.watcherCount).toBe(1);
    expect(typeof withAuction.auction.sellerMemberSince).toBe('string');

    const mine = await request(app).get(api('/auctions/mine')).set(auth(w.seller.token));
    expect(resData<Paginated<AuctionItem>>(mine).items[0].watcherCount).toBe(1);
  });
});
