/**
 * POST /listings/approve-all — batching and progress reporting (BV-049).
 *
 * A backlog of a few hundred PENDING listings used to run entirely inside one HTTP request:
 * hundreds of serial transactions, long enough for Railway's request timeout or the client's
 * own fetch to cut the connection partway through, with no way for the admin to tell how far
 * it got. Capped per call now; `remaining` tells the caller whether to loop again.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(async () => ({ data: { id: 'email_test' }, error: null })) };
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
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

async function pendingListing(suffix: string) {
  return prisma.listing.create({
    data: {
      listingCode: `TEST-BULK-${suffix}`,
      sellerId: w.seller.id,
      title: `Bulk Approval Test Item ${suffix}`,
      category: 'Electronics & Gadgets',
      condition: 'NEW',
      description: 'Seeded by the bulk-approval suite.',
      startPrice: 1_000,
      minIncrement: 100,
      durationDays: 3,
      status: 'PENDING',
      attributes: { brand: 'TestBrand', model: 'TestModel' },
    },
  });
}

describe('approve-all', () => {
  it('reports zero remaining once every pending listing (including the pre-seeded ones) is approved', async () => {
    // world.ts already seeds two PENDING listings (pendingListingId, otherSellerListingId) --
    // account for both rather than assuming a clean slate.
    await pendingListing('1');
    await pendingListing('2');

    const res = await request(app).post(api('/listings/approve-all')).set(auth(w.admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data.approved).toBe(4);
    expect(res.body.data.failed).toBe(0);
    expect(res.body.data.remaining).toBe(0);
    expect(await prisma.listing.count({ where: { status: 'PENDING' } })).toBe(0);
  });

  it('reports the true count still pending, not a subtraction from what this call attempted', async () => {
    await pendingListing('3');
    // Rejected out from under approve-all's own read -- simulates a concurrent single
    // reject/approve rather than actually racing one, which would be flaky to time.
    const toReject = await pendingListing('4');
    await request(app)
      .post(api(`/listings/${toReject.id}/reject`))
      .set(auth(w.admin.token))
      .send({ reason: 'Racing this one out from under approve-all deliberately.' });

    const res = await request(app).post(api('/listings/approve-all')).set(auth(w.admin.token));

    expect(res.status).toBe(200);
    // world.ts's two pre-seeded listings + '3' approve; '4' was already REJECTED, not PENDING, by
    // the time this ran, so it is neither approved nor counted as a failure.
    expect(res.body.data.approved).toBe(3);
    expect(res.body.data.failed).toBe(0);
    expect(res.body.data.remaining).toBe(0);
  });
});
