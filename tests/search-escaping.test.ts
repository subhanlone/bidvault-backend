/**
 * A search term typed by a user means what was typed: `%` and `_` are not wildcards. Covers every
 * route that hands a user-supplied string to Prisma's `contains` (the public auction browse
 * search and category filter, and the admin user directory).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData, type Paginated } from './helpers/api.js';

interface AuctionRow {
  title: string;
}

interface UserRow {
  name: string;
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
let seq = 0;

async function makeActiveAuction(title: string, description = 'A description long enough to be valid.') {
  seq += 1;
  const listing = await prisma.listing.create({
    data: {
      listingCode: `TEST-ESC-${seq}`,
      sellerId: w.seller.id,
      title,
      category: 'Books & Education',
      condition: 'USED',
      description,
      startPrice: 1_000,
      minIncrement: 100,
      durationDays: 3,
      status: 'APPROVED',
    },
  });
  const now = Date.now();
  await prisma.auction.create({
    data: {
      listingId: listing.id,
      sellerId: w.seller.id,
      title,
      category: listing.category,
      condition: listing.condition,
      description,
      startPrice: listing.startPrice,
      minIncrement: listing.minIncrement,
      currentBid: listing.startPrice,
      status: 'ACTIVE',
      startTime: new Date(now - 60_000),
      endTime: new Date(now + 3 * 24 * 60 * 60 * 1000),
    },
  });
}

async function browse(query: string): Promise<string[]> {
  const res = await request(app).get(api(`/auctions?${query}`));
  expect(res.status).toBe(200);
  return resData<Paginated<AuctionRow>>(res).items.map((a) => a.title);
}

async function directory(search: string): Promise<string[]> {
  const res = await request(app)
    .get(api(`/admin/users?search=${encodeURIComponent(search)}`))
    .set(auth(w.admin.token));
  expect(res.status).toBe(200);
  return resData<Paginated<UserRow>>(res).items.map((u) => u.name);
}

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

describe('public auction search', () => {
  it('treats % as a literal percent sign', async () => {
    await makeActiveAuction('50% off sale');
    await makeActiveAuction('50x off sale');
    expect(await browse('search=50%25')).toEqual(['50% off sale']);
  });

  it('treats _ as a literal underscore', async () => {
    await makeActiveAuction('part a_c');
    await makeActiveAuction('part abc');
    expect(await browse('search=a_c')).toEqual(['part a_c']);
  });

  it('treats a backslash as a literal backslash', async () => {
    await makeActiveAuction('path a\\b');
    await makeActiveAuction('path ab');
    expect(await browse('search=a%5Cb')).toEqual(['path a\\b']);
  });

  it('applies the same rule to the description', async () => {
    await makeActiveAuction('Plain one', 'Genuine 100% cotton, never worn.');
    await makeActiveAuction('Plain two', 'Genuine 100x cotton, never worn.');
    expect(await browse('search=100%25')).toEqual(['Plain one']);
  });

  it('still matches ordinary text case-insensitively', async () => {
    await makeActiveAuction('Vintage Camera');
    expect(await browse('search=vintage')).toContain('Vintage Camera');
  });
});

describe('public auction category filter', () => {
  it('does not let % match every category', async () => {
    expect(await browse('category=Electronics%25')).toEqual([]);
  });

  it('still matches a category by a case-insensitive fragment', async () => {
    expect(await browse('category=electronics')).toEqual(['Live Test Auction']);
  });
});

describe('admin user directory search', () => {
  it('treats % as a literal percent sign in names', async () => {
    await prisma.user.createMany({
      data: [
        { name: '50% Ali', email: 'pct@test.local', passwordHash: 'x', role: 'BUYER' },
        { name: '50x Ali', email: 'plain@test.local', passwordHash: 'x', role: 'BUYER' },
      ],
    });
    expect(await directory('50%')).toEqual(['50% Ali']);
  });

  it('treats _ as a literal underscore in emails', async () => {
    await prisma.user.createMany({
      data: [
        { name: 'Under Score', email: 'a_c@test.local', passwordHash: 'x', role: 'BUYER' },
        { name: 'No Score', email: 'abc@test.local', passwordHash: 'x', role: 'BUYER' },
      ],
    });
    expect(await directory('a_c@')).toEqual(['Under Score']);
  });
});
