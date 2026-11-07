/**
 * Three ways an item could reach a buyer, or take their money, after the platform should have
 * stopped it (FR-03, FR-04 and FR-08 in docs/FULL-REVIEW-2026-11-08.md):
 *
 *  - FR-03: paying only looked at the sale, never at the listing, so an item an admin had removed
 *    for cause (counterfeit, stolen, prohibited) could still be paid for, and the takedown left its
 *    unpaid sale waiting for that payment.
 *  - FR-04: approving a listing never looked at its seller, so a suspended seller's listing, or one
 *    left behind by a deleted account, could still go live and be sold.
 *  - FR-08: deleting an account was refused only for a live auction or an unpaid sale. A sale that
 *    was paid but not yet shipped, shipped but not yet received, or disputed did not count, nor did a
 *    listing waiting for review or a bid on an auction still running.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Prisma, TransactionStatus } from '@prisma/client';
import { resData } from './helpers/api.js';

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
const { APPROVED_TEST_CARD } = await import('../src/services/payment-gateway.service.js');
const { checkAccountDeletable } = await import('../src/services/account.service.js');
const { invalidateUserStatusCache } = await import('../src/services/user-status.service.js');

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
  takeViolations();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

// In the seeded world `buyer` owes the PENDING sale on the closed auction, whose listing is APPROVED.
const sale = () => prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
const closedListingId = async () =>
  (await prisma.auction.findUniqueOrThrow({ where: { id: w.closedAuctionId } })).listingId;

const pay = () =>
  request(app)
    .post(api(`/payments/${w.transactionId}/pay`))
    .set(bearer(w.buyer.token))
    .send({ cardNumber: APPROVED_TEST_CARD, deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567' });

/** Holds `change` open in a transaction, starts `action`, then commits the change. */
async function whileHeld<T>(change: (tx: Prisma.TransactionClient) => Promise<unknown>, action: () => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => { held = resolve; });
  const competing = prisma.$transaction(async (tx) => {
    await change(tx);
    held();
    await gate;
  });
  await holding;

  let settled = false;
  const running = action().then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const waited = !settled;

  release();
  await competing;
  return { waited, result: await running };
}

describe('paying for an item that was taken down', () => {
  it('is refused once the listing was removed, and the sale stays unpaid', async () => {
    await prisma.listing.update({ where: { id: await closedListingId() }, data: { status: 'REMOVED', rejectionReason: 'Counterfeit' } });

    const res = await pay();

    expect(res.status).toBe(409);
    expect((await sale()).status).toBe('PENDING');
    expect((await sale()).paymentReference).toBeNull();
  });

  it('a payment that waited for a takedown in progress is refused', async () => {
    const listingId = await closedListingId();

    const { waited, result } = await whileHeld(
      (tx) => tx.listing.update({ where: { id: listingId }, data: { status: 'REMOVED', rejectionReason: 'Stolen' } }),
      pay,
    );

    expect(waited).toBe(true);
    expect(result.status).toBe(409);
    expect((await sale()).status).toBe('PENDING');
  });

  it('a takedown cancels the unpaid sale and tells the buyer', async () => {
    const listingId = await closedListingId();
    const where = { userId: w.buyer.id, type: 'AUCTION_CANCELLED' };
    const before = await prisma.notification.count({ where });

    const res = await request(app)
      .post(api(`/admin/listings/${listingId}/takedown`))
      .set(bearer(w.admin.token))
      .send({ reason: 'Counterfeit item.' });

    expect(res.status).toBe(200);
    expect((await sale()).status).toBe('VOIDED');
    expect(await prisma.notification.count({ where })).toBe(before + 1);
    expect(
      await prisma.auditLog.count({ where: { action: 'TRANSACTION_VOIDED', entityId: w.transactionId } }),
    ).toBe(1);
  });

  it('a takedown leaves a sale that was already paid as it is', async () => {
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'COMPLETED' } });

    const res = await request(app)
      .post(api(`/admin/listings/${await closedListingId()}/takedown`))
      .set(bearer(w.admin.token))
      .send({ reason: 'Counterfeit item.' });

    expect(res.status).toBe(200);
    expect((await sale()).status).toBe('COMPLETED');
  });
});

describe('approving a listing whose seller can no longer sell', () => {
  const approve = (id: string) => request(app).post(api(`/listings/${id}/approve`)).set(bearer(w.admin.token));
  const auctionOf = (listingId: string) => prisma.auction.findUnique({ where: { listingId } });
  const setSeller = async (data: Prisma.UserUpdateInput) => {
    await prisma.user.update({ where: { id: w.seller.id }, data });
    invalidateUserStatusCache(w.seller.id);
  };

  it('is refused for a suspended seller, and the listing stays in review', async () => {
    await setSeller({ status: 'SUSPENDED' });

    const res = await approve(w.pendingListingId);

    expect(res.status).toBe(400);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: w.pendingListingId } })).status).toBe('PENDING');
    expect(await auctionOf(w.pendingListingId)).toBeNull();
  });

  it('is refused for an account that is no longer a seller (withdrawn, or deleted)', async () => {
    await setSeller({ isSeller: false });

    const res = await approve(w.pendingListingId);

    expect(res.status).toBe(400);
    expect(await auctionOf(w.pendingListingId)).toBeNull();
  });

  it('approve-all reports such a listing instead of making it live', async () => {
    await setSeller({ status: 'SUSPENDED' });

    const res = await request(app).post(api('/listings/approve-all')).set(bearer(w.admin.token));

    expect(res.status).toBe(200);
    const body = resData<{ failures: { listingId: string }[] }>(res);
    expect(body.failures.map((f) => f.listingId)).toContain(w.pendingListingId);
    expect(await auctionOf(w.pendingListingId)).toBeNull();
  });
});

describe('deleting an account with something unfinished', () => {
  // otherBuyer won otherSeller's closed auction; the seeded sale is COMPLETED (paid, not shipped).
  // otherSeller also has a listing waiting for review.
  const setOtherSale = (status: TransactionStatus) =>
    prisma.auctionTransaction.update({ where: { id: w.otherBuyerTransactionId }, data: { status } });
  const withdrawOtherListing = () => prisma.listing.delete({ where: { id: w.otherSellerListingId } });

  it.each<TransactionStatus>(['COMPLETED', 'SHIPPED', 'DISPUTED'])(
    'is refused to the buyer and to the seller of a %s sale',
    async (status) => {
      await setOtherSale(status);
      await withdrawOtherListing();

      expect((await checkAccountDeletable(w.otherBuyer.id)).allowed).toBe(false);
      expect((await checkAccountDeletable(w.otherSeller.id)).allowed).toBe(false);
    },
  );

  it('is refused to a seller with a listing waiting for review', async () => {
    await setOtherSale('DELIVERED');

    expect((await checkAccountDeletable(w.otherSeller.id)).allowed).toBe(false);
  });

  it('is refused to a bidder on an auction that is still running', async () => {
    await setOtherSale('DELIVERED');
    await prisma.bid.create({ data: { auctionId: w.liveAuctionId, buyerId: w.otherBuyer.id, amount: 30_000 } });

    expect((await checkAccountDeletable(w.otherBuyer.id)).allowed).toBe(false);
  });

  it('is allowed once everything is finished', async () => {
    await setOtherSale('DELIVERED');
    await withdrawOtherListing();

    expect((await checkAccountDeletable(w.otherBuyer.id)).allowed).toBe(true);
    expect((await checkAccountDeletable(w.otherSeller.id)).allowed).toBe(true);
  });

  it('the delete-account route answers 409 to a buyer whose purchase is paid but not delivered', async () => {
    const res = await request(app)
      .post(api('/auth/delete-account'))
      .set(bearer(w.otherBuyer.token))
      .send({ password: PASSWORD });

    expect(res.status).toBe(409);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: w.otherBuyer.id } });
    expect(row.email).toBe(w.otherBuyer.email);
  });
});
