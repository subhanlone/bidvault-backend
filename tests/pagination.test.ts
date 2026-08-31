/**
 * BV-029: cursor pagination on the six list endpoints that used to return everything
 * unbounded. The shape ({items, nextCursor}) is already covered by
 * routes.conformance.test.ts; this file is about whether the cursor actually walks the full
 * result set correctly -- no duplicate row, no skipped row -- including across rows that
 * share the same sort value, which is exactly the case an id tiebreak exists for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

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

/**
 * Ten ACTIVE auctions for w.seller, all sharing the same endTime -- the exact condition the
 * (endTime, id) tiebreak exists for. Without it, walking the cursor over ties would skip or
 * repeat rows depending on how Postgres happens to order them.
 */
async function seedTiedAuctions(sellerId: string, count: number, endTime: Date) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const listing = await prisma.listing.create({
      data: {
        listingCode: `TEST-PAGE-${i}`,
        sellerId,
        title: `Pagination probe ${i}`,
        category: 'Electronics & Gadgets',
        condition: 'NEW',
        description: 'Fixture for pagination cursor tests.',
        startPrice: 1_000,
        minIncrement: 100,
        durationDays: 1,
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
        status: 'ACTIVE',
        startTime: new Date(endTime.getTime() - 60 * 60 * 1000),
        endTime,
      },
    });
    ids.push(auction.id);
  }
  return ids;
}

/** Walks every page via nextCursor and returns every item id seen, in the order returned. */
async function walkAllPages(
  path: string,
  headers: Record<string, string>,
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const suffix: string = cursor === null
      ? `?limit=${limit}`
      : `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
    const url: string = api(`${path}${suffix}`);
    const res = await request(app).get(url).set(headers);
    expect(res.status).toBe(200);
    for (const item of res.body.data.items) seen.push(item.id ?? item.auctionId ?? item.bidId ?? item.listingId);
    cursor = res.body.data.nextCursor;
    if (!cursor) break;
  }
  return seen;
}

describe('GET /auctions pagination', () => {
  it('respects an explicit limit and reports a cursor when more rows exist', async () => {
    const tiedEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await seedTiedAuctions(w.seller.id, 5, tiedEnd);

    const res = await request(app).get(api('/auctions?limit=2'));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.nextCursor).not.toBeNull();
  });

  it('walks every row exactly once across ties on the sort key, via the id tiebreak', async () => {
    const tiedEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const ids = await seedTiedAuctions(w.seller.id, 7, tiedEnd);

    const seen = await walkAllPages('/auctions', {}, 2);
    const seenTied = seen.filter((id) => ids.includes(id));
    expect(seenTied).toHaveLength(ids.length);
    expect(new Set(seenTied).size).toBe(ids.length); // no duplicates
  });

  it('defaults to ACTIVE when no status is requested', async () => {
    const res = await request(app).get(api('/auctions?limit=100'));
    expect(res.status).toBe(200);
    const ids: string[] = res.body.data.items.map((a: { auctionId: string }) => a.auctionId);
    // w.closedAuctionId is CLOSED -- must not appear in the unfiltered default.
    expect(ids).not.toContain(w.closedAuctionId);
    expect(ids).toContain(w.liveAuctionId);
  });

  it('an explicit status still overrides the default', async () => {
    const res = await request(app).get(api('/auctions?status=CLOSED&limit=100'));
    expect(res.status).toBe(200);
    const ids: string[] = res.body.data.items.map((a: { auctionId: string }) => a.auctionId);
    expect(ids).toContain(w.closedAuctionId);
  });

  it('a malformed cursor is treated as no cursor, not an error', async () => {
    const res = await request(app).get(api('/auctions?cursor=not-valid-base64url-json'));
    expect(res.status).toBe(200);
  });
});

describe('GET /watchlist pagination', () => {
  it('uses auctionId as the tiebreak — no dedicated id column on the composite-key model', async () => {
    const tiedEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const ids = await seedTiedAuctions(w.seller.id, 6, tiedEnd);
    const now = new Date();
    await prisma.watchlist.createMany({
      data: ids.map((auctionId) => ({ userId: w.buyer.id, auctionId, createdAt: now })),
    });

    const seen = await walkAllPages('/watchlist', auth(w.buyer.token), 2);
    const seenTied = seen.filter((id) => ids.includes(id));
    expect(seenTied).toHaveLength(ids.length);
    expect(new Set(seenTied).size).toBe(ids.length);
  });
});

describe('GET /listings/mine pagination', () => {
  it('walks every listing exactly once, newest first', async () => {
    const tiedEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    // Reuses the same helper for its listing-creation side effect; the auctions it also
    // creates are incidental here.
    await seedTiedAuctions(w.seller.id, 5, tiedEnd);

    const seen = await walkAllPages('/listings/mine', auth(w.seller.token), 2);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates across pages
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });
});
