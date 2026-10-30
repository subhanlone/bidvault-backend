/**
 * B5, PR 1: one account buys and sells.
 *
 * Until now a seller was a different kind of account, chosen at sign-up and fixed by the `role`
 * value in the access token. Now every non-admin account can buy, and `isSeller` (a column,
 * read from the database -- never from the token) says whether it can also list. These tests pin
 * the three things that could quietly go wrong:
 *
 *   - the capability takes effect, and is withdrawn, on the very next request, not when a
 *     15-minute token expires;
 *   - someone who stops being a seller can still finish the sales they have already made;
 *   - the details a seller gives (and the ones they do not) end up only where they should.
 */
import { readdirSync, readFileSync } from 'node:fs';
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
const { signAccessToken } = await import('../src/utils/jwt.js');
const { invalidateUserStatusCache } = await import('../src/services/user-status.service.js');
const { SELLER_TERMS_VERSION } = await import('../src/config/seller.js');
const { anonymizeUser } = await import('../src/services/account.service.js');
const { seedWorld, PASSWORD } = await import('./helpers/world.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

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

const enrolment = (overrides: Record<string, unknown> = {}) => ({
  acceptTerms: true,
  termsVersion: SELLER_TERMS_VERSION,
  confirmAdult: true,
  city: 'Lahore',
  province: 'Punjab',
  ...overrides,
});

const enroll = (token: string, body: object = enrolment()) =>
  request(app).post(api('/seller/enroll')).set(bearer(token)).send(body);

/** A brand-new account the way registration now makes one: a buyer, not (yet) a seller. */
async function plainAccount(email = 'newcomer@test.local') {
  const user = await prisma.user.create({
    data: { name: 'New Comer', email, passwordHash: 'x', role: 'BUYER', isEmailVerified: true },
  });
  return { id: user.id, token: signAccessToken({ sub: user.id, role: 'BUYER' }) };
}

const listingBody = () => ({
  title: 'Account model probe item',
  category: 'Books & Education',
  condition: 'NEW',
  description: 'Submitted by the account-model suite, long enough to pass validation.',
  startPrice: 15_000,
  minIncrement: 500,
  durationDays: 3,
  attributes: { author: 'A Writer', format: 'Physical' },
});

// ---- becoming a seller -----------------------------------------------------------------------

describe('POST /seller/enroll', () => {
  it('makes the caller a seller and records what they agreed to and where they are', async () => {
    const me = await plainAccount();
    const res = await enroll(me.token, enrolment({ bio: 'Books and gadgets, ships in two days.', phone: '03001234567' }));
    expect(res.status).toBe(200);
    expect(resData(res)).toMatchObject({ user: { userId: me.id, isSeller: true } });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(row).toMatchObject({
      isSeller: true,
      sellerTermsVersion: SELLER_TERMS_VERSION,
      sellerCity: 'Lahore',
      sellerProvince: 'Punjab',
      sellerBio: 'Books and gadgets, ships in two days.',
      sellerPhone: '03001234567',
      // The role value is the legacy spelling; a new seller is not rewritten into it.
      role: 'BUYER',
    });
    expect(row.sellerSince).toBeInstanceOf(Date);
    expect(row.sellerTermsAcceptedAt).toBeInstanceOf(Date);
    expect(row.ageConfirmedAt).toBeInstanceOf(Date);
  });

  it('takes effect on the very next request, with the same buyer token', async () => {
    const me = await plainAccount();
    // Warm the capability cache with "not a seller" first, so this fails if enrolling does not
    // invalidate it.
    await request(app).get(api('/listings/limits')).set(bearer(me.token)).expect(403);

    await enroll(me.token).expect(200);

    await request(app).get(api('/listings/limits')).set(bearer(me.token)).expect(200);
    const created = await request(app).post(api('/listings')).set(bearer(me.token)).send(listingBody());
    expect(created.status).toBe(201);
  });

  it('is idempotent: a second call changes nothing and writes no second audit row', async () => {
    const me = await plainAccount();
    await enroll(me.token).expect(200);
    const first = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });

    const again = await enroll(me.token, enrolment({ city: 'Karachi', province: 'Sindh' }));
    expect(again.status).toBe(200);

    const second = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(second.sellerSince).toEqual(first.sellerSince);
    expect(second.sellerCity).toBe('Lahore');
    const audits = await prisma.auditLog.findMany({ where: { entityId: me.id, action: 'SELLER_ENROLLED' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(me.id);
  });

  it('two simultaneous calls make one seller and one audit row', async () => {
    const me = await plainAccount();
    // Hold the user's row lock so both requests are certainly in flight when it is released.
    let release: (() => void) | undefined;
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${me.id} FOR UPDATE`;
        await new Promise<void>((resolve) => { release = resolve; });
      },
      { timeout: 30_000 },
    );
    while (!release) await new Promise((r) => setTimeout(r, 10));

    const calls = [enroll(me.token), enroll(me.token)].map((c) => c.then((r) => r));
    await new Promise((r) => setTimeout(r, 400));
    release();
    await held;
    const results = await Promise.all(calls);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const audits = await prisma.auditLog.count({ where: { entityId: me.id, action: 'SELLER_ENROLLED' } });
    expect(audits).toBe(1);
  });

  it.each([
    ['terms not accepted', { acceptTerms: false }, 'acceptTerms'],
    ['age not confirmed', { confirmAdult: false }, 'confirmAdult'],
    ['no city', { city: '' }, 'city'],
    ['no province', { province: undefined }, 'province'],
    ['an unknown province', { province: 'Atlantis' }, 'province'],
    ['a link in the bio', { bio: 'Buy at https://example.com/shop' }, 'bio'],
    ['an email address in the bio', { bio: 'write to me@example.com' }, 'bio'],
    ['a phone number in the bio', { bio: 'call 03001234567 anytime' }, 'bio'],
    ['a malformed phone', { phone: '12' }, 'phone'],
  ])('refuses %s, naming the field', async (_label, override, field) => {
    const me = await plainAccount();
    const res = await enroll(me.token, enrolment(override));
    expect(res.status).toBe(400);
    expect(resError(res).details).toHaveProperty(field);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(row.isSeller).toBe(false);
  });

  it('refuses terms the caller did not see (an out-of-date version)', async () => {
    const me = await plainAccount();
    const res = await enroll(me.token, enrolment({ termsVersion: '1999-01' }));
    expect(res.status).toBe(409);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(row.isSeller).toBe(false);
  });

  it('is not available to an admin or without a token, and is refused for a suspended account', async () => {
    await request(app).post(api('/seller/enroll')).send(enrolment()).expect(401);
    await enroll(w.admin.token).expect(403);

    const me = await plainAccount();
    await prisma.user.update({ where: { id: me.id }, data: { status: 'SUSPENDED' } });
    invalidateUserStatusCache(me.id);
    await enroll(me.token).expect(403);
  });

  it('publishes the terms version the form has to send', async () => {
    const res = await request(app).get(api('/settings/public')).expect(200);
    expect(resData(res)).toMatchObject({ sellerTermsVersion: SELLER_TERMS_VERSION });
  });
});

// ---- the capability is read from the database, not the token ----------------------------------

describe('the seller capability', () => {
  it('a plain buyer cannot create, edit or request listing limits', async () => {
    const me = await plainAccount();
    await request(app).post(api('/listings')).set(bearer(me.token)).send(listingBody()).expect(403);
    await request(app).post(api('/listings/upload-signature')).set(bearer(me.token)).expect(403);
    await request(app).get(api('/listings/limits')).set(bearer(me.token)).expect(403);
    await request(app)
      .patch(api(`/listings/${w.pendingListingId}`))
      .set(bearer(me.token))
      .send(listingBody())
      .expect(403);
  });

  it('a token that still says SELLER does not keep the capability once it is withdrawn', async () => {
    await prisma.user.update({ where: { id: w.seller.id }, data: { isSeller: false } });
    invalidateUserStatusCache(w.seller.id);
    // w.seller.token was minted with role SELLER; the database no longer agrees.
    await request(app).post(api('/listings')).set(bearer(w.seller.token)).send(listingBody()).expect(403);
    await request(app).get(api('/listings/limits')).set(bearer(w.seller.token)).expect(403);
  });

  it('a seller whose capability is withdrawn can still see and finish the sales already made', async () => {
    const tx = await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
    await prisma.auctionTransaction.update({
      where: { id: tx.id },
      data: { status: 'COMPLETED', deliveryAddress: '123 Test Street', deliveryPhone: '03001234567' },
    });
    await prisma.user.update({ where: { id: w.seller.id }, data: { isSeller: false } });
    invalidateUserStatusCache(w.seller.id);

    await request(app).get(api('/seller/items?tab=live')).set(bearer(w.seller.token)).expect(200);
    await request(app).get(api('/payments/my-sales')).set(bearer(w.seller.token)).expect(200);
    await request(app).get(api('/payments/earnings')).set(bearer(w.seller.token)).expect(200);
    await request(app).get(api('/listings/mine')).set(bearer(w.seller.token)).expect(200);

    const shipped = await request(app).patch(api(`/payments/${tx.id}/ship`)).set(bearer(w.seller.token));
    expect(shipped.status).toBe(200);
  });

  it('someone who is not the seller of a sale still cannot act on it, capability or not', async () => {
    const tx = await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
    await prisma.auctionTransaction.update({
      where: { id: tx.id },
      data: { status: 'COMPLETED', deliveryAddress: '123 Test Street', deliveryPhone: '03001234567' },
    });
    // A buyer, and a seller who is not this sale's seller.
    await request(app).patch(api(`/payments/${tx.id}/ship`)).set(bearer(w.buyer.token)).expect(403);
    await request(app).patch(api(`/payments/${tx.id}/ship`)).set(bearer(w.otherSeller.token)).expect(403);
    const row = await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(row.status).toBe('COMPLETED');
  });

  it('a plain buyer sees empty seller screens rather than an error', async () => {
    const me = await plainAccount();
    const items = await request(app).get(api('/seller/items?tab=live')).set(bearer(me.token)).expect(200);
    expect(resData<{ items: unknown[] }>(items).items).toEqual([]);
    const sales = await request(app).get(api('/payments/my-sales')).set(bearer(me.token)).expect(200);
    expect(resData<{ items: unknown[] }>(sales).items).toEqual([]);
  });

  it('an admin is still not a seller or a buyer', async () => {
    await request(app).post(api('/listings')).set(bearer(w.admin.token)).send(listingBody()).expect(403);
    await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/bids`))
      .set(bearer(w.admin.token))
      .send({ amount: 40_000 })
      .expect(403);
  });
});

// ---- one account, both directions --------------------------------------------------------------

describe('a seller can also buy', () => {
  it('bids on someone else\'s auction, but never on their own', async () => {
    const own = await request(app)
      .post(api(`/auctions/${w.liveAuctionId}/bids`))
      .set(bearer(w.seller.token))
      .send({ amount: 30_000 });
    expect(own.status).toBe(403);
    expect(await prisma.bid.count({ where: { auctionId: w.liveAuctionId, buyerId: w.seller.id } })).toBe(0);

    const otherListing = await prisma.listing.create({
      data: {
        listingCode: 'TEST-ACCT-1', sellerId: w.otherSeller.id, title: 'Other seller item',
        category: 'Books & Education', condition: 'NEW',
        description: 'An approved listing belonging to the second seller.',
        startPrice: 5_000, minIncrement: 500, durationDays: 3, status: 'APPROVED',
      },
    });
    const other = await prisma.auction.create({
      data: {
        listingId: otherListing.id, sellerId: w.otherSeller.id, title: otherListing.title,
        category: otherListing.category, condition: otherListing.condition,
        description: otherListing.description, startPrice: 5_000, minIncrement: 500,
        currentBid: 5_000, status: 'ACTIVE',
        startTime: new Date(Date.now() - 3_600_000), endTime: new Date(Date.now() + 86_400_000),
      },
    });
    const res = await request(app)
      .post(api(`/auctions/${other.id}/bids`))
      .set(bearer(w.seller.token))
      .send({ amount: 6_000 });
    expect(res.status).toBe(201);

    await request(app).get(api('/auctions/mine/bids')).set(bearer(w.seller.token)).expect(200);
    await request(app).get(api('/payments/my-wins')).set(bearer(w.seller.token)).expect(200);
    await request(app).get(api('/watchlist')).set(bearer(w.seller.token)).expect(200);
  });

  it('a seller cannot pay for, or confirm, a sale that is not theirs as buyer', async () => {
    await request(app)
      .post(api(`/payments/${w.transactionId}/confirm-receipt`))
      .set(bearer(w.seller.token))
      .expect(403);
  });
});

// ---- registration, sessions and the user object -------------------------------------------------

describe('registration and the user object', () => {
  const register = (body: Record<string, unknown>) =>
    request(app).post(api('/auth/register')).send({
      name: 'Reg User', email: 'reg@test.local', password: PASSWORD, ...body,
    });

  it('registers a plain account when no role is sent', async () => {
    const res = await register({});
    expect(res.status).toBe(201);
    expect(resData<{ user: object }>(res).user).toMatchObject({ role: 'BUYER', isSeller: false, sellerSince: null });
    const row = await prisma.user.findUniqueOrThrow({ where: { email: 'reg@test.local' } });
    expect(row.isSeller).toBe(false);
  });

  it('still accepts the legacy role field: SELLER sets the capability, BUYER does not', async () => {
    const seller = await register({ role: 'SELLER', email: 'legacy-seller@test.local' });
    expect(seller.status).toBe(201);
    expect(resData<{ user: object }>(seller).user).toMatchObject({ isSeller: true });
    const buyer = await register({ role: 'BUYER', email: 'legacy-buyer@test.local' });
    expect(resData<{ user: object }>(buyer).user).toMatchObject({ isSeller: false });
  });

  it('reports isSeller and sellerSince on /auth/me, and they change when the user enrols', async () => {
    const me = await plainAccount();
    const before = await request(app).get(api('/auth/me')).set(bearer(me.token)).expect(200);
    expect(resData<{ user: object }>(before).user).toMatchObject({ isSeller: false, sellerSince: null });

    await enroll(me.token).expect(200);
    const after = await request(app).get(api('/auth/me')).set(bearer(me.token)).expect(200);
    const data = resData<{ user: { isSeller: boolean; sellerSince: string } }>(after).user;
    expect(data.isSeller).toBe(true);
    expect(new Date(data.sellerSince).getTime()).not.toBeNaN();
  });
});

// ---- what other people may see ------------------------------------------------------------------

describe('where a seller\'s details appear', () => {
  it('city and province are public on the auction; phone and bio are not', async () => {
    await prisma.user.update({
      where: { id: w.seller.id },
      data: { sellerCity: 'Multan', sellerProvince: 'Punjab', sellerPhone: '03111234567', sellerBio: 'private-ish bio' },
    });
    const res = await request(app).get(api(`/auctions/${w.liveAuctionId}`)).expect(200);
    const auction = resData<Record<string, unknown>>(res);
    expect(auction).toMatchObject({ sellerCity: 'Multan', sellerProvince: 'Punjab' });
    expect(JSON.stringify(auction)).not.toContain('03111234567');
    expect(JSON.stringify(auction)).not.toContain('private-ish bio');
  });

  it('a legacy seller with no details gets null city and province, not a crash', async () => {
    const res = await request(app).get(api(`/auctions/${w.liveAuctionId}`)).expect(200);
    expect(resData(res)).toMatchObject({ sellerCity: null, sellerProvince: null });
  });

  it('the seller\'s phone reaches the buyer only once the sale is paid', async () => {
    await prisma.user.update({ where: { id: w.seller.id }, data: { sellerPhone: '03111234567' } });

    // w.transactionId is PENDING (unpaid).
    const wins = await request(app).get(api('/payments/my-wins')).set(bearer(w.buyer.token)).expect(200);
    const unpaid = resData<Array<{ transactionId: string; sellerPhone?: string }>>(wins)
      .find((t) => t.transactionId === w.transactionId);
    expect(unpaid?.sellerPhone).toBeUndefined();
    const inv = await request(app).get(api(`/payments/${w.transactionId}/invoice`)).set(bearer(w.buyer.token)).expect(200);
    expect(resData<Record<string, unknown>>(inv).sellerPhone).toBeUndefined();

    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'COMPLETED', deliveryAddress: '123 Test Street', deliveryPhone: '03001234567' },
    });
    const paidWins = await request(app).get(api('/payments/my-wins')).set(bearer(w.buyer.token)).expect(200);
    const paid = resData<Array<{ transactionId: string; sellerPhone?: string }>>(paidWins)
      .find((t) => t.transactionId === w.transactionId);
    expect(paid?.sellerPhone).toBe('03111234567');
    const paidInv = await request(app).get(api(`/payments/${w.transactionId}/invoice`)).set(bearer(w.buyer.token)).expect(200);
    expect(resData<Record<string, unknown>>(paidInv).sellerPhone).toBe('03111234567');
  });

  it('a seller with no phone gives the buyer nothing to show', async () => {
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'COMPLETED' } });
    const wins = await request(app).get(api('/payments/my-wins')).set(bearer(w.buyer.token)).expect(200);
    const row = resData<Array<{ transactionId: string; sellerPhone?: string }>>(wins)
      .find((t) => t.transactionId === w.transactionId);
    expect(row?.sellerPhone).toBeUndefined();
  });
});

// ---- deletion and migration ---------------------------------------------------------------------

describe('anonymising an account', () => {
  it('clears every seller detail and the capability', async () => {
    const me = await plainAccount();
    await enroll(me.token, enrolment({ bio: 'About me', phone: '03001234567' })).expect(200);

    await anonymizeUser(me.id);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(row).toMatchObject({
      isSeller: false, sellerSince: null, sellerTermsAcceptedAt: null, sellerTermsVersion: null,
      sellerCity: null, sellerProvince: null, sellerBio: null, sellerPhone: null, ageConfirmedAt: null,
    });
  });
});

describe('the account-model migration', () => {
  it('turns every pre-existing SELLER account into a seller and leaves the rest alone', async () => {
    const dir = new URL('../prisma/migrations/', import.meta.url);
    const folder = readdirSync(dir).find((n) => n.endsWith('_seller_account_model'));
    expect(folder, 'a migration named *_seller_account_model').toBeDefined();
    const sql = readFileSync(new URL(`${folder}/migration.sql`, dir), 'utf8');
    const backfill = sql
      .split(';')
      .map((chunk) => chunk.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join(' ').trim())
      .find((chunk) => /^UPDATE "User"/i.test(chunk));
    expect(backfill, 'the backfill UPDATE statement').toBeDefined();

    const legacy = await prisma.user.create({
      data: { name: 'Legacy', email: 'legacy@test.local', passwordHash: 'x', role: 'SELLER', isEmailVerified: true },
    });
    const buyer = await prisma.user.create({
      data: { name: 'Plain', email: 'plain@test.local', passwordHash: 'x', role: 'BUYER', isEmailVerified: true },
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } })).isSeller).toBe(false);

    await prisma.$executeRawUnsafe(backfill!);

    expect((await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } })).isSeller).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).isSeller).toBe(false);
    const stamped = await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(stamped.sellerSince).toBeInstanceOf(Date);
  });
});
