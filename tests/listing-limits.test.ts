/**
 * The two admin-set listing rules (minListingPrice, maxBidIncrement): where a seller reads them,
 * and how a violation is reported.
 *
 * They used to be published on the unauthenticated GET /settings/public, which also left the
 * create-listing form guessing (hard-coded fallbacks) whenever that request failed. GET
 * /listings/limits is the seller-only source, and a violation now names the request field in
 * `details` -- the same shape validation failures use -- so a client can show it at the field.
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
const { updatePlatformSettings } = await import('../src/services/settings.service.js');
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
  // A response whose body its own schema forbids is recorded rather than thrown; this turns "no
  // violation recorded" into an assertion for every test below.
  expect(takeViolations()).toEqual([]);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

const listing = (overrides: Record<string, unknown> = {}) => ({
  title: 'A Limit Probe Item',
  category: 'Books & Education',
  condition: 'NEW',
  description: 'Submitted by the limits suite, long enough to pass validation.',
  startPrice: 3_000,
  minIncrement: 250,
  durationDays: 5,
  attributes: { author: 'A Writer', format: 'Physical' },
  ...overrides,
});

describe('GET /listings/limits', () => {
  it('returns the settings an admin has set, not a copy', async () => {
    await updatePlatformSettings({ minListingPrice: 5_000, maxBidIncrement: 250_000 });
    const res = await request(app).get(api('/listings/limits')).set(auth(w.seller.token));
    expect(res.status).toBe(200);
    expect(resData(res)).toEqual({ minListingPrice: 5_000, maxBidIncrement: 250_000 });
  });

  it('is not served to a buyer, an admin or an anonymous caller', async () => {
    await request(app).get(api('/listings/limits')).expect(401);
    await request(app).get(api('/listings/limits')).set(auth(w.buyer.token)).expect(403);
    await request(app).get(api('/listings/limits')).set(auth(w.admin.token)).expect(403);
  });
});

describe('a listing that breaks a limit', () => {
  it('POST /listings: a starting price under the minimum names startPrice', async () => {
    await updatePlatformSettings({ minListingPrice: 5_000 });
    const res = await request(app).post(api('/listings')).set(auth(w.seller.token)).send(listing({ startPrice: 2_000 }));
    expect(res.status).toBe(422);
    expect(resError(res).error).toBe('Starting price must be at least PKR 5,000.');
    expect(resError(res).details).toEqual({ startPrice: ['Starting price must be at least PKR 5,000.'] });
  });

  it('POST /listings: an increment over the maximum names minIncrement', async () => {
    await updatePlatformSettings({ maxBidIncrement: 200 });
    const res = await request(app).post(api('/listings')).set(auth(w.seller.token)).send(listing({ minIncrement: 250 }));
    expect(res.status).toBe(422);
    expect(resError(res).details).toEqual({ minIncrement: ['Minimum bid increment cannot exceed PKR 200.'] });
  });

  it('POST /listings: a value between an old limit and a new one is judged by the new one', async () => {
    // 800 is below the default minimum (1,000) and above the lowered one -- the case a hard-coded
    // copy of the limit gets wrong in the seller's disfavour.
    await updatePlatformSettings({ minListingPrice: 500 });
    const res = await request(app).post(api('/listings')).set(auth(w.seller.token)).send(listing({ startPrice: 800, minIncrement: 100 }));
    expect(res.status).toBe(201);
  });

  it('PATCH /listings/{id} reports it the same way', async () => {
    await updatePlatformSettings({ minListingPrice: 5_000 });
    const rejected = await prisma.listing.update({
      where: { id: w.pendingListingId },
      data: { status: 'REJECTED', rejectionReason: 'Needs clearer photos.' },
    });
    const res = await request(app)
      .patch(api(`/listings/${rejected.id}`))
      .set(auth(w.seller.token))
      .send(listing({ category: 'Electronics & Gadgets', attributes: { brand: 'Sony', model: 'A7' }, startPrice: 2_000 }));
    expect(res.status).toBe(422);
    expect(resError(res).details).toEqual({ startPrice: ['Starting price must be at least PKR 5,000.'] });
  });

  it('other 422s still carry no details: only a rule about one field names it', async () => {
    const res = await request(app)
      .post(api('/listings'))
      .set(auth(w.seller.token))
      .send(listing({ attributes: { format: 'Physical' } }));
    expect(res.status).toBe(422);
    expect(resError(res).details).toBeUndefined();
  });
});
