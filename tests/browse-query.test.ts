/**
 * The public auction list as a browse surface (guest browsing, G3): server-side sorts, the price,
 * condition and bids filters, search by item number, and the facet counts that go beside them.
 *
 * Every auction here carries the token "Zqx" in its title and every test searches for it, so the
 * live and closed auctions the shared world seeds never mix into an expected order.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

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
type Condition = 'NEW' | 'LIKE_NEW' | 'USED';

const app = createApp();
const api = (path: string) => `/api/v1${path}`;

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

const HOUR = 3_600_000;
const MINUTE = 60_000;

interface Fixture {
  key: string;
  currentBid: number;
  bidCount: number;
  endsInHours: number;
  createdMinutesAgo: number;
  condition: Condition;
  category: string;
  status?: 'ACTIVE' | 'CLOSED';
  description?: string;
}

let codeCounter = 0;
const nextCode = () => `BV-2026-${(0xa10000000 + ++codeCounter).toString(16).toUpperCase().padStart(10, '0')}`;

async function makeAuction(f: Fixture, listingCode = nextCode()): Promise<{ id: string; listingCode: string }> {
  const now = Date.now();
  const listing = await prisma.listing.create({
    data: {
      listingCode,
      sellerId: w.seller.id,
      title: `Zqx ${f.key}`,
      category: f.category,
      condition: f.condition,
      description: f.description ?? `Fixture ${f.key}`,
      startPrice: 1_000,
      minIncrement: 100,
      durationDays: 3,
      status: 'APPROVED',
    },
  });
  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id,
      sellerId: w.seller.id,
      title: listing.title,
      category: f.category,
      condition: f.condition,
      description: listing.description,
      startPrice: 1_000,
      minIncrement: 100,
      currentBid: f.currentBid,
      bidCount: f.bidCount,
      status: f.status ?? 'ACTIVE',
      startTime: new Date(now - 24 * HOUR),
      endTime: new Date(now + f.endsInHours * HOUR),
      createdAt: new Date(now - f.createdMinutesAgo * MINUTE),
    },
  });
  return { id: auction.id, listingCode };
}

// B, C and E share a price; B and E share a bid count too, so every numeric sort has ties.
const FIXTURES: Fixture[] = [
  { key: 'A', currentBid: 3_000, bidCount: 0, endsInHours: 5, createdMinutesAgo: 50, condition: 'NEW', category: 'Zqcat One' },
  { key: 'B', currentBid: 8_000, bidCount: 4, endsInHours: 2, createdMinutesAgo: 40, condition: 'USED', category: 'Zqcat One' },
  { key: 'C', currentBid: 8_000, bidCount: 2, endsInHours: 9, createdMinutesAgo: 30, condition: 'NEW', category: 'Zqcat Two' },
  { key: 'D', currentBid: 30_000, bidCount: 7, endsInHours: 1, createdMinutesAgo: 20, condition: 'USED', category: 'Zqcat Two' },
  { key: 'E', currentBid: 8_000, bidCount: 4, endsInHours: 3, createdMinutesAgo: 10, condition: 'LIKE_NEW', category: 'Zqcat One' },
  { key: 'F', currentBid: 12_000, bidCount: 0, endsInHours: 7, createdMinutesAgo: 5, condition: 'NEW', category: 'Zqcat Two' },
];

interface Seeded extends Fixture {
  id: string;
  listingCode: string;
}

async function seedFixtures(): Promise<Seeded[]> {
  const seeded: Seeded[] = [];
  for (const f of FIXTURES) seeded.push({ ...f, ...(await makeAuction(f)) });
  return seeded;
}

interface ListBody {
  success: boolean;
  data: { items: { auctionId: string; title: string; listingCode: string }[]; nextCursor: string | null };
}

const list = (query: Record<string, string | number | boolean> | string) =>
  request(app).get(api('/auctions')).query(query);

/** Follows nextCursor to the end and returns every id in the order the server gave them. */
async function allPages(query: Record<string, string | number>): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const res = await list(cursor ? { ...query, cursor } : query);
    expect(res.status).toBe(200);
    const body = res.body as ListBody;
    ids.push(...body.data.items.map((i) => i.auctionId));
    cursor = body.data.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error('a list that never ended');
}

const idsOf = (rows: Seeded[]) => rows.map((r) => r.id);

/** The field -> messages map a 400 carries. */
const detailsOf = (res: { body: unknown }) => (res.body as { details: Record<string, string[]> }).details;

/** The order a sort promises, ties broken by id in the direction of the sort. */
function expected(rows: Seeded[], by: (r: Seeded) => number, dir: 'asc' | 'desc'): Seeded[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * (by(a) - by(b)) || sign * a.id.localeCompare(b.id));
}

describe('sorts', () => {
  const endsAt = (r: Seeded) => r.endsInHours;
  const createdAt = (r: Seeded) => -r.createdMinutesAgo;

  it('keeps today\'s order and today\'s cursor shape when no new parameter is sent', async () => {
    const rows = await seedFixtures();
    const first = await list({ search: 'Zqx', limit: 2 });
    expect(first.status).toBe(200);
    const body = first.body as ListBody;
    expect(body.data.items.map((i) => i.auctionId)).toEqual(idsOf(expected(rows, endsAt, 'asc')).slice(0, 2));
    // The cursor is the old two-field one, so a link saved before this change still works.
    const decoded = JSON.parse(Buffer.from(body.data.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(['id', 'sortValue']);
    expect(takeViolations()).toEqual([]);
  });

  it.each([
    ['ending-soonest', endsAt, 'asc'],
    ['newly-listed', createdAt, 'desc'],
    ['price-asc', (r: Seeded) => r.currentBid, 'asc'],
    ['price-desc', (r: Seeded) => r.currentBid, 'desc'],
    ['bids-desc', (r: Seeded) => r.bidCount, 'desc'],
    ['bids-asc', (r: Seeded) => r.bidCount, 'asc'],
  ] as const)('%s returns every auction once, in order, across pages of two', async (sort, by, dir) => {
    const rows = await seedFixtures();
    const got = await allPages({ search: 'Zqx', sort, limit: 2 });
    expect(got).toEqual(idsOf(expected(rows, by, dir)));
    expect(new Set(got).size).toBe(got.length);
    expect(takeViolations()).toEqual([]);
  });

  it('pages correctly through a price that three auctions share, one row at a time', async () => {
    const rows = await seedFixtures();
    const got = await allPages({ search: 'Zqx', sort: 'price-asc', limit: 1 });
    expect(got).toEqual(idsOf(expected(rows, (r) => r.currentBid, 'asc')));
  });

  it('ending-soonest-with-bids is ending-soonest without the auctions nobody has bid on', async () => {
    const rows = await seedFixtures();
    const got = await allPages({ search: 'Zqx', sort: 'ending-soonest-with-bids', limit: 2 });
    expect(got).toEqual(idsOf(expected(rows.filter((r) => r.bidCount > 0), endsAt, 'asc')));
  });

  it('answers a sort it does not know with 400 and the field named', async () => {
    const res = await list({ sort: 'cheapest' });
    expect(res.status).toBe(400);
    expect(detailsOf(res)).toHaveProperty('sort');
    expect(takeViolations()).toEqual([]);
  });

  it('refuses a cursor made under another sort, in both directions, and an old cursor under a new sort', async () => {
    await seedFixtures();
    const underPrice = (await list({ search: 'Zqx', sort: 'price-asc', limit: 1 })).body as ListBody;
    const replayed = await list({ search: 'Zqx', sort: 'newly-listed', limit: 1, cursor: underPrice.data.nextCursor! });
    expect(replayed.status).toBe(400);
    expect(detailsOf(replayed)).toHaveProperty('cursor');

    const underDefault = (await list({ search: 'Zqx', limit: 1 })).body as ListBody;
    const old = await list({ search: 'Zqx', sort: 'price-asc', limit: 1, cursor: underDefault.data.nextCursor! });
    expect(old.status).toBe(400);

    const sameSort = await list({ search: 'Zqx', sort: 'price-asc', limit: 1, cursor: underPrice.data.nextCursor! });
    expect(sameSort.status).toBe(200);
    expect(takeViolations()).toEqual([]);
  });

  it('still reads a damaged cursor as "first page", as it always has', async () => {
    const rows = await seedFixtures();
    const res = await list({ search: 'Zqx', sort: 'price-asc', cursor: 'not-a-cursor' });
    expect(res.status).toBe(200);
    expect((res.body as ListBody).data.items.map((i) => i.auctionId)).toEqual(idsOf(expected(rows, (r) => r.currentBid, 'asc')));
  });
});

describe('filters', () => {
  it('price bounds are inclusive and read against the current bid', async () => {
    const rows = await seedFixtures();
    const got = await allPages({ search: 'Zqx', sort: 'price-asc', minPrice: 8_000, maxPrice: 12_000 });
    expect(got).toEqual(idsOf(expected(rows.filter((r) => r.currentBid >= 8_000 && r.currentBid <= 12_000), (r) => r.currentBid, 'asc')));
  });

  it('a minimum above the maximum is a 400 naming both', async () => {
    const res = await list({ minPrice: 9_000, maxPrice: 1_000 });
    expect(res.status).toBe(400);
    expect(detailsOf(res)).toHaveProperty('minPrice');
    expect(takeViolations()).toEqual([]);
  });

  it.each<Record<string, string>>([{ minPrice: 'abc' }, { maxPrice: '-5' }, { minPrice: '12.5' }, { maxPrice: '99999999999' }, { withBids: 'maybe' }, { condition: 'BROKEN' }])(
    'rejects %j with 400',
    async (query) => {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(takeViolations()).toEqual([]);
    },
  );

  it('withBids=true leaves out the auctions with no bids, withBids=false changes nothing', async () => {
    const rows = await seedFixtures();
    const withBids = await allPages({ search: 'Zqx', withBids: 'true' });
    expect(new Set(withBids)).toEqual(new Set(idsOf(rows.filter((r) => r.bidCount > 0))));
    const all = await allPages({ search: 'Zqx', withBids: 'false' });
    expect(new Set(all)).toEqual(new Set(idsOf(rows)));
  });

  it('condition takes one value or several', async () => {
    const rows = await seedFixtures();
    const one = await allPages({ search: 'Zqx', condition: 'USED' });
    expect(new Set(one)).toEqual(new Set(idsOf(rows.filter((r) => r.condition === 'USED'))));
    const res = await list('search=Zqx&condition=NEW&condition=LIKE_NEW');
    expect(res.status).toBe(200);
    expect(new Set((res.body as ListBody).data.items.map((i) => i.auctionId))).toEqual(
      new Set(idsOf(rows.filter((r) => r.condition !== 'USED'))),
    );
  });

  it('filters and a sort work together across pages', async () => {
    const rows = await seedFixtures();
    const got = await allPages({ search: 'Zqx', condition: 'NEW', minPrice: 3_000, sort: 'price-desc', limit: 1 });
    expect(got).toEqual(idsOf(expected(rows.filter((r) => r.condition === 'NEW'), (r) => r.currentBid, 'desc')));
  });
});

describe('search by item number', () => {
  it('finds the auction by its exact code, typed in lower case, and only that one', async () => {
    const rows = await seedFixtures();
    const target = rows[2];
    const res = await list({ search: target.listingCode.toLowerCase() });
    expect(res.status).toBe(200);
    expect((res.body as ListBody).data.items.map((i) => i.auctionId)).toEqual([target.id]);
  });

  it('finds nothing from a code that is only part of one', async () => {
    const rows = await seedFixtures();
    const res = await list({ search: rows[0].listingCode.slice(0, -2) });
    expect((res.body as ListBody).data.items).toEqual([]);
  });

  it('takes a % or _ in a code-shaped term literally', async () => {
    const rows = await seedFixtures();
    const wildcard = `${rows[0].listingCode.slice(0, -1)}_`;
    expect(((await list({ search: wildcard })).body as ListBody).data.items).toEqual([]);
    expect(((await list({ search: 'BV-2026-%' })).body as ListBody).data.items).toEqual([]);
  });

  it('does not return another auction that merely mentions the code in its text', async () => {
    const rows = await seedFixtures();
    const target = rows[2];
    const mention = await makeAuction({
      ...FIXTURES[0],
      key: 'Mention',
      description: `Same make as item ${target.listingCode}, but a different item.`,
    });
    const res = await list({ search: target.listingCode });
    const found = (res.body as ListBody).data.items.map((i) => i.auctionId);
    expect(found).toEqual([target.id]);
    expect(found).not.toContain(mention.id);
  });

  it('leaves a word search as it was', async () => {
    const rows = await seedFixtures();
    const res = await list({ search: 'zqx', limit: 100 });
    expect(new Set((res.body as ListBody).data.items.map((i) => i.auctionId))).toEqual(new Set(idsOf(rows)));
  });

  it('still finds a code the way the seller sees it when the auction is closed', async () => {
    const closed = await makeAuction({ ...FIXTURES[0], key: 'Closed', status: 'CLOSED' });
    const res = await list({ search: closed.listingCode, status: 'CLOSED' });
    expect((res.body as ListBody).data.items.map((i) => i.auctionId)).toEqual([closed.id]);
  });
});

describe('facets', () => {
  interface Facets {
    categories: { name: string; count: number }[];
    conditions: { value: Condition; count: number }[];
    priceBands: { id: string; count: number }[];
    withBids: number;
  }
  const facets = (query: Record<string, string | number> | string = { search: 'Zqx' }) =>
    request(app).get(api('/auctions/facets')).query(query);
  const body = (res: { body: unknown }) => (res.body as { data: Facets }).data;
  const countOf = <T extends { count: number }>(rows: T[], pick: (r: T) => boolean) => rows.find(pick)?.count ?? 0;

  it('is public and is not mistaken for an auction id', async () => {
    await seedFixtures();
    const res = await facets();
    expect(res.status).toBe(200);
    expect((res.body as { success: boolean }).success).toBe(true);
    expect(takeViolations()).toEqual([]);
  });

  it('every count equals the number of rows the list gives for the same filter', async () => {
    await seedFixtures();
    const f = body(await facets());

    for (const c of f.categories) {
      const rows = (await list({ search: 'Zqx', category: c.name, limit: 100 })).body as ListBody;
      expect(rows.data.items.length, c.name).toBe(c.count);
    }
    for (const c of f.conditions) {
      const rows = (await list({ search: 'Zqx', condition: c.value, limit: 100 })).body as ListBody;
      expect(rows.data.items.length, c.value).toBe(c.count);
    }
    const bands: Record<string, { minPrice?: number; maxPrice?: number }> = {
      'under-5000': { maxPrice: 4_999 },
      '5000-25000': { minPrice: 5_000, maxPrice: 25_000 },
      'over-25000': { minPrice: 25_001 },
    };
    for (const band of f.priceBands) {
      const rows = (await list({ search: 'Zqx', limit: 100, ...bands[band.id] })).body as ListBody;
      expect(rows.data.items.length, band.id).toBe(band.count);
    }
    const withBids = (await list({ search: 'Zqx', withBids: 'true', limit: 100 })).body as ListBody;
    expect(withBids.data.items.length).toBe(f.withBids);
  });

  it('a group ignores its own filter but honours the others', async () => {
    const rows = await seedFixtures();
    const f = body(await facets({ search: 'Zqx', category: 'Zqcat One', minPrice: 5_000 }));
    // Category ignores category, obeys minPrice: One has B (8k) and E (8k) over 5k, Two has C, D, F.
    expect(countOf(f.categories, (c) => c.name === 'Zqcat One')).toBe(rows.filter((r) => r.category === 'Zqcat One' && r.currentBid >= 5_000).length);
    expect(countOf(f.categories, (c) => c.name === 'Zqcat Two')).toBe(rows.filter((r) => r.category === 'Zqcat Two' && r.currentBid >= 5_000).length);
    // Conditions obey both filters.
    expect(countOf(f.conditions, (c) => c.value === 'USED')).toBe(rows.filter((r) => r.condition === 'USED' && r.category === 'Zqcat One' && r.currentBid >= 5_000).length);
    // Price bands ignore the price filter but obey the category.
    expect(countOf(f.priceBands, (b) => b.id === 'under-5000')).toBe(rows.filter((r) => r.category === 'Zqcat One' && r.currentBid < 5_000).length);
  });

  it('gives zero counts, not missing keys, when nothing matches', async () => {
    await seedFixtures();
    const f = body(await facets({ search: 'nothing-has-this-word' }));
    expect(f.categories).toEqual([]);
    expect(f.conditions.map((c) => c.value).sort()).toEqual(['LIKE_NEW', 'NEW', 'USED']);
    expect(f.conditions.every((c) => c.count === 0)).toBe(true);
    expect(f.priceBands.map((b) => b.id)).toEqual(['under-5000', '5000-25000', 'over-25000']);
    expect(f.priceBands.every((b) => b.count === 0)).toBe(true);
    expect(f.withBids).toBe(0);
    expect(takeViolations()).toEqual([]);
  });

  it('refuses the same malformed filters the list refuses', async () => {
    const res = await facets({ minPrice: 9_000, maxPrice: 1_000 });
    expect(res.status).toBe(400);
    expect(takeViolations()).toEqual([]);
  });
});
