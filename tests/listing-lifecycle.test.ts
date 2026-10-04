/**
 * Phase 6 (LIFECYCLE-IMPLEMENTATION-PLAN.md): A1 (isLive derived from the auction join, not a
 * second ListingStatus value), A2 (edit and resubmit a REJECTED listing), B4's listing half
 * (withdraw a PENDING listing before it has ever been auctioned).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData, type Paginated } from './helpers/api.js';

interface ListingSummary {
  listingId: string;
  isLive: boolean;
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

const VALID_LISTING_BODY = {
  title: 'Resubmitted Vintage Camera',
  category: 'Electronics & Gadgets',
  condition: 'USED',
  description: 'A film camera in good working condition, fully tested before listing.',
  startPrice: 15_000,
  minIncrement: 500,
  durationDays: 5,
  attributes: { brand: 'Canon', model: 'AE-1' },
};

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

describe('isLive (A1)', () => {
  it('is true for an APPROVED listing whose auction is ACTIVE', async () => {
    // w.seller owns three listings (pending, this live one, and one whose auction is already
    // CLOSED) -- identify it by its actual auction, not by excluding pendingListingId alone.
    const liveListingId = (await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } })).listingId;
    const res = await request(app).get(api('/listings/mine')).set(auth(w.seller.token));
    expect(res.status).toBe(200);
    const live = resData<Paginated<ListingSummary>>(res).items.find((l) => l.listingId === liveListingId);
    expect(live?.isLive).toBe(true);
  });

  it('is false once the auction closes, even though the listing stays APPROVED', async () => {
    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { status: 'CLOSED' } });

    const res = await request(app).get(api('/listings/mine')).set(auth(w.seller.token));
    const listingId = (await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } })).listingId;
    const item = resData<Paginated<ListingSummary>>(res).items.find((l) => l.listingId === listingId);
    expect(item?.isLive).toBe(false);
  });

  it('is false for a PENDING listing with no auction at all', async () => {
    const res = await request(app).get(api('/listings/mine')).set(auth(w.seller.token));
    const pending = resData<Paginated<ListingSummary>>(res).items.find(
      (l) => l.listingId === w.pendingListingId,
    );
    expect(pending?.isLive).toBe(false);
  });

  it('/stats only counts live inventory, not every APPROVED listing ever', async () => {
    const before = resData<{ listingCount: number }>(await request(app).get(api('/stats'))).listingCount;
    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { status: 'CLOSED' } });
    const after = resData<{ listingCount: number }>(await request(app).get(api('/stats'))).listingCount;
    expect(after).toBe(before - 1);
  });
});

describe('resubmit a rejected listing (A2)', () => {
  async function rejectedListing() {
    return prisma.listing.create({
      data: {
        listingCode: 'TEST-REJECTED-1',
        sellerId: w.seller.id,
        title: 'Original Title',
        category: 'Electronics & Gadgets',
        condition: 'NEW',
        description: 'Original description before it was rejected by an admin.',
        startPrice: 10_000,
        minIncrement: 500,
        durationDays: 3,
        status: 'REJECTED',
        rejectionReason: 'Description too short.',
        attributes: { brand: 'Sony', model: 'A7' },
      },
    });
  }

  it('re-validates, returns to PENDING, and clears the rejection reason', async () => {
    const listing = await rejectedListing();

    const res = await request(app)
      .patch(api(`/listings/${listing.id}`))
      .set(auth(w.seller.token))
      .send(VALID_LISTING_BODY);

    expect(res.status).toBe(200);
    const data = resData<{ status: string; title: string; rejectionReason?: string }>(res);
    expect(data.status).toBe('PENDING');
    expect(data.title).toBe(VALID_LISTING_BODY.title);
    expect(data.rejectionReason).toBeUndefined();

    const row = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(row.status).toBe('PENDING');
    expect(row.rejectionReason).toBeNull();
  });

  it('refuses to edit a listing that is not REJECTED', async () => {
    const res = await request(app)
      .patch(api(`/listings/${w.pendingListingId}`))
      .set(auth(w.seller.token))
      .send(VALID_LISTING_BODY);
    expect(res.status).toBe(409);
  });

  it("refuses to edit another seller's rejected listing", async () => {
    const listing = await rejectedListing();
    const res = await request(app)
      .patch(api(`/listings/${listing.id}`))
      .set(auth(w.otherSeller.token))
      .send(VALID_LISTING_BODY);
    expect(res.status).toBe(403);
  });

  it('still enforces business rules on the resubmission (e.g. the price floor)', async () => {
    const listing = await rejectedListing();
    const res = await request(app)
      .patch(api(`/listings/${listing.id}`))
      .set(auth(w.seller.token))
      .send({ ...VALID_LISTING_BODY, startPrice: 1 });
    expect(res.status).toBe(422);
  });
});

describe('withdraw a pending listing (B4)', () => {
  it("deletes the seller's own PENDING listing", async () => {
    const res = await request(app)
      .delete(api(`/listings/${w.pendingListingId}`))
      .set(auth(w.seller.token));
    expect(res.status).toBe(200);
    expect(resData<{ status: string }>(res).status).toBe('WITHDRAWN');

    const row = await prisma.listing.findUnique({ where: { id: w.pendingListingId } });
    expect(row).toBeNull();
  });

  it('refuses to withdraw an APPROVED listing', async () => {
    const listingId = (await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } })).listingId;
    const res = await request(app)
      .delete(api(`/listings/${listingId}`))
      .set(auth(w.seller.token));
    expect(res.status).toBe(409);
  });

  it("refuses to withdraw another seller's listing", async () => {
    const res = await request(app)
      .delete(api(`/listings/${w.otherSellerListingId}`))
      .set(auth(w.seller.token));
    expect(res.status).toBe(403);
  });
});
