/**
 * B5 PR 3a (docs/B5-SELLER-ACCOUNT-RESEARCH.md sections 3.3, 3.6 and 9): the monthly selling limit.
 *
 * A seller with fewer than `sellerGraduationSales` (3) completed sales may list at most
 * `newSellerMonthlyItems` (10) items worth `newSellerMonthlyValue` (PKR 150,000) of starting price
 * per calendar month in Asia/Karachi. What counts: every listing submitted this month that is not
 * rejected or withdrawn, plus every earlier listing still live. A per-user override replaces the
 * platform numbers (and applies to an established seller too, to restrain them).
 *
 * Graduation is reversible (decided 2026-11-09): the limit returns when, among the last 12 months of
 * paid sales, at least 2 ended in a refund, with at least 2 different buyers, and the refund rate is
 * above 10%. Every refunded paid sale is a defect, whatever route led to the refund.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { hash } from '@node-rs/bcrypt';
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
const { seedWorld, PASSWORD } = await import('./helpers/world.js');
const { signAccessToken } = await import('../src/utils/jwt.js');
const { invalidateSettingsCache } = await import('../src/services/settings.service.js');
const { karachiMonthStart } = await import('../src/services/seller-limit.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

interface Limits {
  items: { used: number; limit: number | null };
  value: { used: number; limit: number | null };
  resetsAt: string;
  completedSales: number;
  salesToGraduate: number;
  standing: 'NEW' | 'ESTABLISHED' | 'RESTRICTED';
}

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const DAY = 24 * 60 * 60 * 1000;

let w: World;
let n = 0;

const body = (startPrice = 1_000) => ({
  title: `Limit Spec Item ${++n}`,
  category: 'Electronics & Gadgets',
  condition: 'USED',
  description: 'An item listed by the monthly limit specs.',
  startPrice,
  minIncrement: 100,
  durationDays: 5,
  attributes: { brand: 'Canon', model: 'AE-1' },
});

/** An account that enrolled as a seller today, with no sales: a new seller. */
async function makeSeller(email: string, extra: Record<string, unknown> = {}) {
  const now = new Date();
  const user = await prisma.user.create({
    data: {
      name: 'Limit Seller', email, passwordHash: await hash(PASSWORD, 4), role: 'BUYER', isEmailVerified: true,
      isSeller: true, sellerSince: now, sellerTermsAcceptedAt: now, sellerTermsVersion: '2026-10',
      ageConfirmedAt: now, sellerCity: 'Lahore', sellerProvince: 'Punjab', ...extra,
    },
  });
  return { id: user.id, token: signAccessToken({ sub: user.id, role: 'BUYER' }) };
}

/** A closed auction of `sellerId` won by `buyerId`, with a sale in `status`. */
async function makeSale(sellerId: string, buyerId: string, status: 'COMPLETED' | 'SHIPPED' | 'DELIVERED' | 'REFUNDED', paidAt = new Date()) {
  const code = `LIMIT-SALE-${++n}`;
  const listing = await prisma.listing.create({
    data: {
      listingCode: code, sellerId, title: `Sold ${code}`, category: 'Electronics & Gadgets', condition: 'USED',
      description: 'A sold item for the limit specs.', startPrice: 1_000, minIncrement: 100, durationDays: 3,
      status: 'APPROVED', submittedAt: new Date(paidAt.getTime() - 40 * DAY),
    },
  });
  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id, sellerId, title: listing.title, category: listing.category, condition: listing.condition,
      description: listing.description, startPrice: 1_000, minIncrement: 100, currentBid: 2_000, bidCount: 1,
      status: 'CLOSED', startTime: new Date(paidAt.getTime() - 10 * DAY), endTime: new Date(paidAt.getTime() - DAY),
    },
  });
  return prisma.auctionTransaction.create({
    data: {
      auctionId: auction.id, winnerId: buyerId, sellerId, finalAmount: 2_000, status, paidAt,
      shipByAt: new Date(paidAt.getTime() + 3 * DAY),
      deliveryAddress: '1 Test Street, Lahore', deliveryPhone: '03001234567',
      ...(status === 'SHIPPED' || status === 'DELIVERED' ? { shippedAt: paidAt } : {}),
    },
  });
}

async function makeBuyer(email: string) {
  const user = await prisma.user.create({
    data: { name: `Buyer ${email}`, email, passwordHash: await hash(PASSWORD, 4), role: 'BUYER', isEmailVerified: true },
  });
  return { id: user.id, token: signAccessToken({ sub: user.id, role: 'BUYER' }) };
}

const submit = (token: string, startPrice?: number) =>
  request(app).post(api('/listings')).set(auth(token)).send(body(startPrice));

async function limitsOf(token: string): Promise<Limits> {
  const res = await request(app).get(api('/seller/items/summary')).set(auth(token));
  expect(res.status).toBe(200);
  return resData<{ limits: Limits }>(res).limits;
}

const notificationsOf = (userId: string, type: string) => prisma.notification.count({ where: { userId, type } });

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
});

afterEach(() => {
  expect(takeViolations()).toEqual([]);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('the calendar month is Asia/Karachi', () => {
  it('starts at midnight Karachi time (19:00 UTC the day before)', () => {
    expect(karachiMonthStart(new Date('2026-10-31T19:30:00Z')).toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect(karachiMonthStart(new Date('2026-10-31T18:59:59Z')).toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(karachiMonthStart(new Date('2026-01-15T00:00:00Z')).toISOString()).toBe('2025-12-31T19:00:00.000Z');
  });
});

describe('a new seller', () => {
  it('may submit 10 items in a month; the 11th is refused with SELLER_LIMIT_REACHED and nothing is created', async () => {
    const s = await makeSeller('new@test.local');
    for (let i = 0; i < 10; i++) expect((await submit(s.token)).status).toBe(201);

    const res = await submit(s.token);
    expect(res.status).toBe(422);
    expect(resError(res).code).toBe('SELLER_LIMIT_REACHED');
    expect(resError(res).error).toMatch(/10 items/);
    expect(await prisma.listing.count({ where: { sellerId: s.id } })).toBe(10);
  });

  it('is refused a listing whose starting price would take the month over PKR 150,000', async () => {
    const s = await makeSeller('value@test.local');
    expect((await submit(s.token, 100_000)).status).toBe(201);
    const res = await submit(s.token, 60_000);
    expect(res.status).toBe(422);
    expect(resError(res).code).toBe('SELLER_LIMIT_REACHED');
    expect(resError(res).error).toMatch(/150,000/);
    expect((await submit(s.token, 50_000)).status).toBe(201);
  });

  it('a rejected or withdrawn listing stops counting', async () => {
    const s = await makeSeller('freed@test.local');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(resData<{ listingId: string }>(await submit(s.token)).listingId);
    await prisma.listing.update({ where: { id: ids[0] }, data: { status: 'REJECTED', rejectionReason: 'Blurry photo.' } });
    expect((await request(app).delete(api(`/listings/${ids[1]}`)).set(auth(s.token))).status).toBe(200);

    expect((await submit(s.token)).status).toBe(201);
    expect((await submit(s.token)).status).toBe(201);
    expect((await submit(s.token)).status).toBe(422);
  });

  it('an earlier month\'s listing counts while it is still live, and not once it has ended', async () => {
    const s = await makeSeller('carried@test.local');
    const lastMonth = new Date(karachiMonthStart(new Date()).getTime() - 5 * DAY);
    for (let i = 0; i < 9; i++) {
      const listing = await prisma.listing.create({
        data: {
          listingCode: `LIMIT-OLD-${++n}`, sellerId: s.id, title: `Old ${n}`, category: 'Electronics & Gadgets', condition: 'USED',
          description: 'Submitted last month.', startPrice: 1_000, minIncrement: 100, durationDays: 30, status: 'APPROVED', submittedAt: lastMonth,
        },
      });
      await prisma.auction.create({
        data: {
          listingId: listing.id, sellerId: s.id, title: listing.title, category: listing.category, condition: listing.condition,
          description: listing.description, startPrice: 1_000, minIncrement: 100, currentBid: 1_000, bidCount: 0,
          status: i < 8 ? 'ACTIVE' : 'CLOSED', startTime: lastMonth, endTime: new Date(Date.now() + (i < 8 ? DAY : -DAY)),
        },
      });
    }
    // 8 live from last month + 2 now = 10; the ended one does not count.
    expect((await submit(s.token)).status).toBe(201);
    expect((await submit(s.token)).status).toBe(201);
    expect((await submit(s.token)).status).toBe(422);
  });

  it('resubmitting a rejected listing counts again, and is refused at the limit', async () => {
    const s = await makeSeller('resubmit@test.local');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(resData<{ listingId: string }>(await submit(s.token)).listingId);
    await prisma.listing.update({ where: { id: ids[0] }, data: { status: 'REJECTED', rejectionReason: 'Blurry photo.' } });
    expect((await submit(s.token)).status).toBe(201);

    const res = await request(app).patch(api(`/listings/${ids[0]}`)).set(auth(s.token)).send(body());
    expect(res.status).toBe(422);
    expect(resError(res).code).toBe('SELLER_LIMIT_REACHED');
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: ids[0] } })).status).toBe('REJECTED');
  });

  it('two submissions at once with one item left: one passes, one is refused', async () => {
    const s = await makeSeller('race@test.local');
    for (let i = 0; i < 9; i++) await submit(s.token);
    const results = await Promise.all([submit(s.token), submit(s.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await prisma.listing.count({ where: { sellerId: s.id } })).toBe(10);
  });

  it('the admin\'s settings change the numbers', async () => {
    await prisma.platformSetting.upsert({
      where: { id: 'singleton' }, update: { newSellerMonthlyItems: 2 }, create: { id: 'singleton', newSellerMonthlyItems: 2 },
    });
    invalidateSettingsCache();
    const s = await makeSeller('settings@test.local');
    await submit(s.token);
    await submit(s.token);
    expect((await submit(s.token)).status).toBe(422);
  });

  it('a per-user override replaces the platform numbers', async () => {
    const s = await makeSeller('override@test.local', { sellerLimitOverrideItems: 12 });
    for (let i = 0; i < 12; i++) expect((await submit(s.token)).status).toBe(201);
    expect((await submit(s.token)).status).toBe(422);
  });

  it('is told once a month when 80% is used', async () => {
    const s = await makeSeller('near@test.local');
    for (let i = 0; i < 7; i++) await submit(s.token);
    expect(await notificationsOf(s.id, 'SELLER_LIMIT_NEAR')).toBe(0);
    await submit(s.token);
    expect(await notificationsOf(s.id, 'SELLER_LIMIT_NEAR')).toBe(1);
    await submit(s.token);
    expect(await notificationsOf(s.id, 'SELLER_LIMIT_NEAR')).toBe(1);
  });

  it('sees the limit, what is used and when it resets in the summary', async () => {
    const s = await makeSeller('summary@test.local');
    await submit(s.token, 20_000);
    const limits = await limitsOf(s.token);
    expect(limits).toMatchObject({
      items: { used: 1, limit: 10 }, value: { used: 20_000, limit: 150_000 },
      completedSales: 0, salesToGraduate: 3, standing: 'NEW',
    });
    const resetsAt = new Date(limits.resetsAt);
    expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
    expect(resetsAt.toISOString()).toMatch(/T19:00:00\.000Z$/);
  });
});

describe('graduation', () => {
  it('a seller with 3 completed sales has no limit', async () => {
    const s = await makeSeller('established@test.local');
    for (let i = 0; i < 3; i++) await makeSale(s.id, w.buyer.id, 'DELIVERED');
    for (let i = 0; i < 11; i++) expect((await submit(s.token)).status).toBe(201);
    expect(await limitsOf(s.token)).toMatchObject({ items: { limit: null }, value: { limit: null }, standing: 'ESTABLISHED', salesToGraduate: 0 });
  });

  it('an override restrains an established seller too', async () => {
    const s = await makeSeller('restrained@test.local', { sellerLimitOverrideItems: 1 });
    for (let i = 0; i < 3; i++) await makeSale(s.id, w.buyer.id, 'DELIVERED');
    expect((await submit(s.token)).status).toBe(201);
    expect((await submit(s.token)).status).toBe(422);
  });

  it('the third delivered sale lifts the limit and tells the seller', async () => {
    const s = await makeSeller('graduating@test.local');
    for (let i = 0; i < 2; i++) await makeSale(s.id, w.buyer.id, 'DELIVERED');
    const third = await makeSale(s.id, w.buyer.id, 'SHIPPED');

    const res = await request(app).post(api(`/payments/${third.id}/confirm-receipt`)).set(auth(w.buyer.token));
    expect(res.status).toBe(200);
    expect(await notificationsOf(s.id, 'SELLER_GRADUATED')).toBe(1);
    expect((await limitsOf(s.token)).standing).toBe('ESTABLISHED');
  });
});

describe('the limit returns on refunds (reversible graduation)', () => {
  it('a second refund with a second buyer, above 10% of paid sales, brings the limit back and tells the seller', async () => {
    const s = await makeSeller('slipping@test.local');
    const other = await makeBuyer('other-refund@test.local');
    for (let i = 0; i < 8; i++) await makeSale(s.id, w.buyer.id, 'DELIVERED');
    await makeSale(s.id, w.buyer.id, 'REFUNDED');
    const unshipped = await makeSale(s.id, other.id, 'COMPLETED');
    expect((await limitsOf(s.token)).standing).toBe('ESTABLISHED');

    // The seller refunds the unshipped sale themselves (FR-02): still a defect.
    const res = await request(app).post(api(`/payments/${unshipped.id}/refund`)).set(auth(s.token)).send({ reason: 'It broke while packing.' });
    expect(res.status).toBe(200);

    // 2 refunds, 2 buyers, 2 of 10 paid sales = 20%.
    const limits = await limitsOf(s.token);
    expect(limits.standing).toBe('RESTRICTED');
    expect(limits.items.limit).toBe(10);
    expect(await notificationsOf(s.id, 'SELLER_LIMIT_RETURNED')).toBe(1);
  });

  it('two refunds to the same buyer do not bring it back', async () => {
    const s = await makeSeller('one-buyer@test.local');
    for (let i = 0; i < 3; i++) await makeSale(s.id, w.buyer.id, 'DELIVERED');
    await makeSale(s.id, w.buyer.id, 'REFUNDED');
    await makeSale(s.id, w.buyer.id, 'REFUNDED');
    expect((await limitsOf(s.token)).standing).toBe('ESTABLISHED');
  });

  it('two refunds with two buyers at 10% or less do not bring it back', async () => {
    const s = await makeSeller('low-rate@test.local');
    const other = await makeBuyer('other-low@test.local');
    for (let i = 0; i < 18; i++) await makeSale(s.id, w.buyer.id, 'DELIVERED');
    await makeSale(s.id, w.buyer.id, 'REFUNDED');
    await makeSale(s.id, other.id, 'REFUNDED');
    expect((await limitsOf(s.token)).standing).toBe('ESTABLISHED'); // 2 of 20 = 10%, not above it
  });

  it('refunds older than 12 months do not count', async () => {
    const s = await makeSeller('old-refunds@test.local');
    const other = await makeBuyer('other-old@test.local');
    const longAgo = new Date(Date.now() - 400 * DAY);
    for (let i = 0; i < 3; i++) await makeSale(s.id, w.buyer.id, 'DELIVERED');
    await makeSale(s.id, w.buyer.id, 'REFUNDED', longAgo);
    await makeSale(s.id, other.id, 'REFUNDED', longAgo);
    expect((await limitsOf(s.token)).standing).toBe('ESTABLISHED');
  });
});

describe('becoming a seller', () => {
  it('the welcome notification states the monthly limit', async () => {
    const buyer = await makeBuyer('enrolling@test.local');
    const res = await request(app).post(api('/seller/enroll')).set(auth(buyer.token)).send({
      acceptTerms: true, termsVersion: '2026-10', confirmAdult: true, city: 'Lahore', province: 'Punjab',
    });
    expect(res.status).toBe(200);
    const welcome = await prisma.notification.findFirst({ where: { userId: buyer.id, type: 'SELLER_WELCOME' } });
    expect(welcome?.message).toMatch(/10 items/);
    expect(welcome?.message).toMatch(/150,000/);
  });
});
