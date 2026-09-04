/**
 * POST /listings — listing-code collision handling (BV-014).
 *
 * The code is randomly generated and unique to the row, so a collision carries no information
 * the seller did anything wrong. It must retry with a freshly generated code rather than
 * surface a 409 that blames the seller for something they never touched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

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

describe('listing-code collision', () => {
  it('retries with a fresh code instead of failing the submission', async () => {
    const year = new Date().getFullYear();
    const collidingCode = `BV-${year}-AAAAAAAAAA`;

    await prisma.listing.create({
      data: {
        listingCode: collidingCode,
        sellerId: w.seller.id,
        title: 'Pre-existing listing occupying the code the first roll will hit',
        category: 'Electronics & Gadgets',
        condition: 'NEW',
        description: 'Seeded to force a collision on the very next generated listing code.',
        startPrice: 5_000,
        minIncrement: 100,
        durationDays: 3,
        status: 'PENDING',
      },
    });

    // The real generator would need ~2^40 tries to hit this by chance -- forcing it directly
    // is the only realistic way to exercise the retry path.
    const fixedBuffer = Buffer.from('AAAAAAAAAA', 'hex');
    // randomBytes is overloaded (sync vs. callback); the route only ever uses the sync form,
    // but TS resolves .mockReturnValueOnce against the union, hence the cast.
    vi.spyOn(crypto, 'randomBytes').mockReturnValueOnce(fixedBuffer as never);

    const res = await request(app)
      .post(api('/listings'))
      .set(auth(w.seller.token))
      .send({
        title: 'A brand new listing',
        category: 'Electronics & Gadgets',
        condition: 'NEW',
        description: 'Submitted while the first generated code collides with an existing one.',
        startPrice: 5_000,
        minIncrement: 100,
        durationDays: 3,
        attributes: { brand: 'TestBrand', model: 'TestModel' },
      });

    expect(res.status).toBe(201);
    expect(res.body.data.listingCode).not.toBe(collidingCode);
    expect(res.body.data.listingCode).toMatch(new RegExp(`^BV-${year}-[0-9A-F]{10}$`));

    expect(
      await prisma.listing.count({
        where: { sellerId: w.seller.id, title: { startsWith: 'Pre-existing' } },
      }),
    ).toBe(1);
  });
});
