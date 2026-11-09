/**
 * B5 PR 3b (docs/B5-SELLER-ACCOUNT-RESEARCH.md sections 3.3, 3.4 and D4/D7): an admin pauses or
 * restores someone's selling, sets their personal monthly limit, and sellers ask for a higher limit.
 *
 * Revoke (D4, refined 2026-11-09): live auctions finish (unless the admin ticks "end live auctions",
 * with the reason given to bidders), pending listings are withdrawn with the reason, and sales already
 * made keep working end to end. The person keeps their account; only selling stops.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { hash } from '@node-rs/bcrypt';
import { resData, resError, type Paginated } from './helpers/api.js';

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
const { anonymizeUser } = await import('../src/services/account.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

interface DirectoryRow {
  userId: string;
  sellerStatus: 'NONE' | 'ACTIVE' | 'REVOKED';
  sellerLimitOverrideItems: number | null;
  sellerLimitOverrideValue: number | null;
}

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

const LISTING = {
  title: 'Revoke Spec Item',
  category: 'Electronics & Gadgets',
  condition: 'USED',
  description: 'An item listed by the revoke specs.',
  startPrice: 1_000,
  minIncrement: 100,
  durationDays: 5,
  attributes: { brand: 'Canon', model: 'AE-1' },
};

const revoke = (userId: string, body: object = { reason: 'Several buyers report items not as described.' }) =>
  request(app).post(api(`/admin/users/${userId}/revoke-seller`)).set(auth(w.admin.token)).send(body);
const restore = (userId: string) =>
  request(app).post(api(`/admin/users/${userId}/restore-seller`)).set(auth(w.admin.token)).send({});
const setLimit = (userId: string, body: object) =>
  request(app).put(api(`/admin/users/${userId}/seller-limit`)).set(auth(w.admin.token)).send(body);
const askForMore = (token: string, body: object = { note: 'I sell cameras and have 50 to list.' }) =>
  request(app).post(api('/seller/limit-request')).set(auth(token)).send(body);

async function directoryRow(userId: string): Promise<DirectoryRow> {
  const res = await request(app).get(api('/admin/users?limit=100')).set(auth(w.admin.token));
  return resData<Paginated<DirectoryRow>>(res).items.find((r) => r.userId === userId)!;
}

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

describe('POST /admin/users/{userId}/revoke-seller', () => {
  it('stops selling at once, withdraws pending listings with the reason, lets live auctions finish, and tells the person', async () => {
    const res = await revoke(w.seller.id);
    expect(res.status).toBe(200);
    expect(resData<{ sellerStatus: string }>(res).sellerStatus).toBe('REVOKED');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: w.seller.id } });
    expect(user.isSeller).toBe(false);
    expect(user.sellerRevokedAt).not.toBeNull(); // marked as paused, so it can be restored

    const pending = await prisma.listing.findUniqueOrThrow({ where: { id: w.pendingListingId } });
    expect(pending.status).toBe('REJECTED');
    expect(pending.rejectionReason).toMatch(/Several buyers report/);

    const live = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(live.status).toBe('ACTIVE');

    expect((await request(app).post(api('/listings')).set(auth(w.seller.token)).send(LISTING)).status).toBe(403);
    expect(await prisma.notification.count({ where: { userId: w.seller.id, type: 'SELLER_REVOKED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'SELLER_REVOKED', entityId: w.seller.id } })).toBe(1);
  });

  it('can end live auctions too, telling the bidders why', async () => {
    const res = await revoke(w.seller.id, { reason: 'Selling counterfeit goods.', endLiveAuctions: true });
    expect(res.status).toBe(200);

    const live = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(live.status).toBe('CANCELLED');
    const notice = await prisma.notification.findFirst({ where: { userId: w.buyer.id, type: 'AUCTION_CANCELLED' } });
    expect(notice?.message).toMatch(/Selling counterfeit goods/);
  });

  it('leaves sales already made working: the revoked seller can still ship', async () => {
    const sale = await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'COMPLETED', paidAt: new Date(), deliveryAddress: '1 Test Street, Lahore', deliveryPhone: '03001234567' },
    });
    await revoke(w.seller.id);

    const res = await request(app).patch(api(`/payments/${sale.id}/ship`)).set(auth(w.seller.token)).send({});
    expect(res.status).toBe(200);
  });

  it('refuses someone who is not selling, an admin, a deleted account, and an unknown one', async () => {
    expect((await revoke(w.buyer.id)).status).toBe(409);
    expect((await revoke(w.admin.id)).status).toBe(409);
    await revoke(w.otherSeller.id);
    expect((await revoke(w.otherSeller.id)).status).toBe(409); // already revoked
    const gone = await prisma.user.create({
      data: {
        name: 'Gone Seller', email: 'gone-seller@test.local', passwordHash: await hash(PASSWORD, 4), role: 'BUYER',
        isEmailVerified: true, isSeller: true, sellerTermsAcceptedAt: new Date(),
      },
    });
    await anonymizeUser(gone.id);
    expect((await revoke(gone.id)).status).toBe(409);
    expect((await revoke('no-such-user')).status).toBe(404);
  });

  it('needs a reason', async () => {
    expect((await revoke(w.seller.id, {})).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.seller.id } })).isSeller).toBe(true);
  });
});

describe('POST /admin/users/{userId}/restore-seller', () => {
  it('gives selling back and tells the person', async () => {
    await revoke(w.seller.id);
    const res = await restore(w.seller.id);
    expect(res.status).toBe(200);
    expect(resData<{ sellerStatus: string }>(res).sellerStatus).toBe('ACTIVE');
    expect((await request(app).post(api('/listings')).set(auth(w.seller.token)).send(LISTING)).status).toBe(201);
    expect(await prisma.notification.count({ where: { userId: w.seller.id, type: 'SELLER_RESTORED' } })).toBe(1);
  });

  it('refuses someone who is selling already, or who never became a seller', async () => {
    expect((await restore(w.seller.id)).status).toBe(409);
    expect((await restore(w.buyer.id)).status).toBe(409);
  });
});

describe('PUT /admin/users/{userId}/seller-limit', () => {
  it('sets a personal monthly limit that replaces the platform numbers, and clears it with null', async () => {
    const res = await setLimit(w.seller.id, { items: 25, value: 500_000 });
    expect(res.status).toBe(200);
    expect(resData<{ items: number; value: number }>(res)).toMatchObject({ items: 25, value: 500_000 });
    expect(await directoryRow(w.seller.id)).toMatchObject({ sellerLimitOverrideItems: 25, sellerLimitOverrideValue: 500_000 });
    expect(await prisma.notification.count({ where: { userId: w.seller.id, type: 'SELLER_LIMIT_CHANGED' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'SELLER_LIMIT_SET', entityId: w.seller.id } })).toBe(1);

    await setLimit(w.seller.id, { items: null, value: null });
    expect(await directoryRow(w.seller.id)).toMatchObject({ sellerLimitOverrideItems: null, sellerLimitOverrideValue: null });
  });

  it('refuses a zero or negative number, and an admin or deleted account', async () => {
    expect((await setLimit(w.seller.id, { items: 0, value: null })).status).toBe(400);
    expect((await setLimit(w.seller.id, { items: -3, value: null })).status).toBe(400);
    expect((await setLimit(w.admin.id, { items: 5, value: null })).status).toBe(409);
    await anonymizeUser(w.otherBuyer.id);
    expect((await setLimit(w.otherBuyer.id, { items: 5, value: null })).status).toBe(409);
  });
});

describe('GET /admin/users seller fields', () => {
  it('says whether each account sells, was stopped, or never did', async () => {
    await revoke(w.otherSeller.id);
    expect((await directoryRow(w.seller.id)).sellerStatus).toBe('ACTIVE');
    expect((await directoryRow(w.otherSeller.id)).sellerStatus).toBe('REVOKED');
    expect((await directoryRow(w.buyer.id)).sellerStatus).toBe('NONE');
  });
});

describe('POST /seller/limit-request', () => {
  it('records the request and tells every active admin, once a month', async () => {
    const second = await prisma.user.create({
      data: { name: 'Second Admin', email: 'admin-two@test.local', passwordHash: await hash(PASSWORD, 4), role: 'ADMIN', isEmailVerified: true },
    });
    const first = await askForMore(w.seller.token);
    expect(first.status).toBe(200);
    expect(resData<{ alreadyRequested: boolean }>(first).alreadyRequested).toBe(false);
    expect(await prisma.notification.count({ where: { type: 'SELLER_LIMIT_REQUESTED', userId: { in: [w.admin.id, second.id] } } })).toBe(2);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'SELLER_LIMIT_REQUESTED', entityId: w.seller.id } });
    expect(audit?.metadata).toMatchObject({ note: 'I sell cameras and have 50 to list.' });

    const again = await askForMore(w.seller.token);
    expect(again.status).toBe(200);
    expect(resData<{ alreadyRequested: boolean }>(again).alreadyRequested).toBe(true);
    expect(await prisma.notification.count({ where: { type: 'SELLER_LIMIT_REQUESTED' } })).toBe(2);
  });

  it('refuses a seller who has no limit to raise', async () => {
    const established = await prisma.user.create({
      data: {
        name: 'Established', email: 'established@test.local', passwordHash: await hash(PASSWORD, 4), role: 'BUYER',
        isEmailVerified: true, isSeller: true, sellerTermsAcceptedAt: new Date(),
      },
    });
    await prisma.platformSetting.upsert({
      where: { id: 'singleton' }, update: { sellerGraduationSales: 0 }, create: { id: 'singleton', sellerGraduationSales: 0 },
    });
    const { invalidateSettingsCache } = await import('../src/services/settings.service.js');
    invalidateSettingsCache();
    const res = await askForMore(signAccessToken({ sub: established.id, role: 'BUYER' }));
    expect(res.status).toBe(409);
    expect(resError(res).error).toMatch(/no monthly limit/i);
  });

  it('is for sellers only, and the note is at most 500 characters', async () => {
    expect((await askForMore(w.buyer.token)).status).toBe(403);
    expect((await askForMore(w.seller.token, { note: 'x'.repeat(501) })).status).toBe(400);
  });
});

describe('a paused seller cannot undo it themselves', () => {
  const ENROL = { acceptTerms: true, termsVersion: '2026-10', confirmAdult: true, city: 'Lahore', province: 'Punjab' };

  it('enrolling again is refused while selling is paused', async () => {
    await revoke(w.seller.id);
    const res = await request(app).post(api('/seller/enroll')).set(auth(w.seller.token)).send(ENROL);
    expect(res.status).toBe(403);
    expect(resError(res).error).toMatch(/paused by an administrator/i);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.seller.id } })).isSeller).toBe(false);
  });

  it('after a restore the account sells again without enrolling', async () => {
    await revoke(w.seller.id);
    await restore(w.seller.id);
    const res = await request(app).post(api('/seller/enroll')).set(auth(w.seller.token)).send(ENROL);
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.seller.id } })).isSeller).toBe(true);
  });

  it('the signed-in user says when selling was paused, so the screens can say so', async () => {
    const before = await request(app).get(api('/auth/me')).set(auth(w.seller.token));
    expect(resData<{ user: { sellerRevokedAt: string | null } }>(before).user.sellerRevokedAt).toBeNull();
    await revoke(w.seller.id);
    const after = await request(app).get(api('/auth/me')).set(auth(w.seller.token));
    const user = resData<{ user: { isSeller: boolean; sellerRevokedAt: string | null } }>(after).user;
    expect(user.isSeller).toBe(false);
    expect(user.sellerRevokedAt).not.toBeNull();
  });
});
