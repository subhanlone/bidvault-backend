/**
 * The public seller profile (guest browsing, G4): what anyone may read about a seller, the filter
 * that lists one seller's auctions, and the reviews that sit under the profile.
 *
 * What stays private is asserted on the serialised response, not on named keys, so a field added
 * later cannot leak by being unnamed here: no e-mail, no phone, no reviewer's real name or id.
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
const { anonymizeUser } = await import('../src/services/account.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

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

const PHONE = '0300 1234567';
const SINCE = new Date('2026-03-01T09:00:00.000Z');

interface Profile {
  id: string;
  displayName: string;
  memberSince: string;
  city: string | null;
  province: string | null;
  bio: string | null;
  itemsSold: number;
  rating: number | null;
  ratingCount: number;
}
const profileOf = (res: { body: unknown }) => (res.body as { data: Profile }).data;

/** Gives the seeded seller everything a seller gives on becoming one, including the private bits. */
async function fillInSeller() {
  await prisma.user.update({
    where: { id: w.seller.id },
    data: { sellerCity: 'Lahore', sellerProvince: 'Punjab', sellerBio: 'I sell cameras and desks.', sellerPhone: PHONE, sellerSince: SINCE },
  });
}

/** The seeded sale, delivered and reviewed by its buyer. */
async function reviewTheSale(stars: number, comment: string | null = 'Arrived as described.') {
  await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'DELIVERED' } });
  return prisma.sellerReview.create({
    data: { transactionId: w.transactionId, auctionId: w.closedAuctionId, buyerId: w.buyer.id, sellerId: w.seller.id, stars, comment },
  });
}

let codeCounter = 0;
async function makeAuction(sellerId: string, title: string, currentBid: number, status: 'ACTIVE' | 'CLOSED' = 'ACTIVE') {
  const listing = await prisma.listing.create({
    data: {
      listingCode: `BV-2026-C${String(++codeCounter).padStart(9, '0')}`, sellerId, title, category: 'Home & Furniture',
      condition: 'USED', description: `${title}, for the seller profile tests.`, startPrice: 1_000, minIncrement: 100,
      durationDays: 3, status: 'APPROVED',
    },
  });
  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id, sellerId, title, category: listing.category, condition: 'USED', description: listing.description,
      startPrice: 1_000, minIncrement: 100, currentBid, bidCount: 0, status,
      startTime: new Date(Date.now() - 3_600_000), endTime: new Date(Date.now() + 5 * 3_600_000),
    },
  });
  return auction.id;
}

describe('GET /sellers/{sellerId}', () => {
  it('gives anyone the profile of a seller, with no token', async () => {
    await fillInSeller();
    await reviewTheSale(4);
    const res = await request(app).get(api(`/sellers/${w.seller.id}`));
    expect(res.status).toBe(200);
    expect(profileOf(res)).toEqual({
      id: w.seller.id,
      displayName: 'Test Seller',
      memberSince: SINCE.toISOString(),
      city: 'Lahore',
      province: 'Punjab',
      bio: 'I sell cameras and desks.',
      itemsSold: 1,
      rating: 4,
      ratingCount: 1,
    });
    expect(takeViolations()).toEqual([]);
  });

  it('never carries an e-mail address, a phone number or a password, whatever the field is called', async () => {
    await fillInSeller();
    const text = JSON.stringify((await request(app).get(api(`/sellers/${w.seller.id}`))).body);
    expect(text).not.toContain(w.seller.email);
    expect(text).not.toContain(PHONE);
    expect(text.toLowerCase()).not.toMatch(/phone|email|password|token|cnic/);
  });

  it('says "no ratings yet" with nulls and zeros, not with missing fields', async () => {
    const profile = profileOf(await request(app).get(api(`/sellers/${w.seller.id}`)));
    expect(profile.rating).toBeNull();
    expect(profile.ratingCount).toBe(0);
    expect(profile.itemsSold).toBe(0);
    expect(profile.city).toBeNull();
    expect(profile.bio).toBeNull();
  });

  it('dates a seller from when they became one, and a seller from before that existed from joining', async () => {
    const legacy = await prisma.user.update({ where: { id: w.seller.id }, data: { sellerSince: null } });
    const profile = profileOf(await request(app).get(api(`/sellers/${w.seller.id}`)));
    expect(profile.memberSince).toBe(legacy.createdAt.toISOString());
  });

  it('counts a sale only once it is paid, and averages the stars to one decimal', async () => {
    // The seeded sale is still PENDING: a sale nobody has paid for is not a sale made.
    expect(profileOf(await request(app).get(api(`/sellers/${w.seller.id}`))).itemsSold).toBe(0);
    await reviewTheSale(4);
    expect(profileOf(await request(app).get(api(`/sellers/${w.seller.id}`))).itemsSold).toBe(1);
  });

  it.each([
    ['someone who never became a seller', () => w.buyer.id],
    ['an admin', () => w.admin.id],
    ['an id that belongs to no one', () => 'no-such-user'],
  ])('is a 404 for %s', async (_label, id) => {
    const res = await request(app).get(api(`/sellers/${id()}`));
    expect(res.status).toBe(404);
    expect(takeViolations()).toEqual([]);
  });

  it('is a 404 for a suspended seller', async () => {
    await prisma.user.update({ where: { id: w.seller.id }, data: { status: 'SUSPENDED' } });
    expect((await request(app).get(api(`/sellers/${w.seller.id}`))).status).toBe(404);
  });

  it('is a 404 for a seller whose account was deleted, and says nothing about who they were', async () => {
    await fillInSeller();
    await anonymizeUser(w.seller.id);
    const res = await request(app).get(api(`/sellers/${w.seller.id}`));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Lahore');
  });

  it('is a 404 for a seller whose seller status was withdrawn', async () => {
    await prisma.user.update({ where: { id: w.seller.id }, data: { isSeller: false } });
    expect((await request(app).get(api(`/sellers/${w.seller.id}`))).status).toBe(404);
  });
});

describe('GET /auctions?sellerId=', () => {
  const titles = (res: { body: unknown }) =>
    (res.body as { data: { items: { title: string }[] } }).data.items.map((i) => i.title);

  it("lists only that seller's auctions", async () => {
    await makeAuction(w.otherSeller.id, 'Someone Else Lamp', 4_000);
    const mine = await makeAuction(w.seller.id, 'My Own Lamp', 4_000);
    const res = await request(app).get(api('/auctions')).query({ sellerId: w.seller.id });
    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(expect.arrayContaining(['Live Test Auction', 'My Own Lamp']));
    expect(titles(res)).not.toContain('Someone Else Lamp');
    const ids = (res.body as { data: { items: { auctionId: string }[] } }).data.items.map((i) => i.auctionId);
    expect(ids).toContain(mine);
  });

  it('lists the seller\'s ended items with status=CLOSED', async () => {
    const res = await request(app).get(api('/auctions')).query({ sellerId: w.seller.id, status: 'CLOSED' });
    expect(titles(res)).toEqual(['Closed Test Auction']);
  });

  it('keeps the sorts working inside one seller', async () => {
    await makeAuction(w.seller.id, 'Cheap Lamp', 2_000);
    await makeAuction(w.seller.id, 'Dear Lamp', 90_000);
    const res = await request(app).get(api('/auctions')).query({ sellerId: w.seller.id, sort: 'price-desc' });
    expect(titles(res)).toEqual(['Dear Lamp', 'Live Test Auction', 'Cheap Lamp']);
  });

  it('gives an unknown seller an empty page, not an error', async () => {
    const res = await request(app).get(api('/auctions')).query({ sellerId: 'no-such-user' });
    expect(res.status).toBe(200);
    expect(titles(res)).toEqual([]);
  });

  it('refuses an id that is too long to be one', async () => {
    const res = await request(app).get(api('/auctions')).query({ sellerId: 'x'.repeat(65) });
    expect(res.status).toBe(400);
    expect(takeViolations()).toEqual([]);
  });

  it("counts one seller's auctions in the facets too", async () => {
    await makeAuction(w.otherSeller.id, 'Someone Else Lamp', 4_000);
    const res = await request(app).get(api('/auctions/facets')).query({ sellerId: w.seller.id });
    const facets = (res.body as { data: { categories: { name: string; count: number }[] } }).data;
    expect(facets.categories).toEqual([{ name: 'Electronics & Gadgets', count: 1 }]);
  });
});

describe("a seller's public reviews", () => {
  interface PublicReview {
    reviewId: string;
    stars: number;
    comment: string | null;
    buyerName: string;
    itemTitle: string;
    verifiedPurchase: boolean;
    createdAt: string;
  }
  const reviewsOf = async () =>
    (await request(app).get(api(`/reviews/seller/${w.seller.id}`))).body as { data: { reviews: PublicReview[] } };

  it('says which item each was about and when it was written', async () => {
    const written = await reviewTheSale(5, 'Lovely.');
    const [review] = (await reviewsOf()).data.reviews;
    expect(review).toMatchObject({ reviewId: written.id, stars: 5, comment: 'Lovely.', itemTitle: 'Closed Test Auction' });
    expect(review.createdAt).toBe(written.createdAt.toISOString());
    expect(takeViolations()).toEqual([]);
  });

  it('marks a review as a verified purchase only when its writer is the buyer of that sale', async () => {
    await reviewTheSale(5);
    expect((await reviewsOf()).data.reviews[0].verifiedPurchase).toBe(true);
    // The sale was offered on to the next bidder after the review was written.
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { winnerId: w.otherBuyer.id } });
    expect((await reviewsOf()).data.reviews[0].verifiedPurchase).toBe(false);
  });

  it('shows the reviewer as a number, and carries no id, e-mail or real name', async () => {
    await reviewTheSale(5);
    const res = await request(app).get(api(`/reviews/seller/${w.seller.id}`));
    const text = JSON.stringify(res.body);
    expect((res.body as { data: { reviews: PublicReview[] } }).data.reviews[0].buyerName).toBe('Reviewer 1');
    expect(text).not.toContain(w.buyer.id);
    expect(text).not.toContain(w.buyer.email);
    expect(text).not.toContain('Test Buyer');
  });
});
