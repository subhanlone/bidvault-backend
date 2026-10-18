/**
 * Three ways the non-payment recovery flow (A3/A5) could still go wrong, found by an independent
 * review of the Phase 8 work and reproduced here before they were fixed:
 *
 *  1. POST /payments/{id}/pay only refused sales that were already paid, so a VOIDED sale -- one the
 *     seller had already given up on, offered on or relisted -- could still be paid for.
 *  2. offerToNextBidder and relistFromVoidedTransaction never looked at whether an admin had
 *     REMOVED the original listing, so a takedown could be undone by calling the endpoint directly
 *     (My Items hides the action, the endpoint did not refuse it).
 *  3. The payment clock ran from the sale's createdAt. An offer re-targets the same row at the next
 *     bidder and keeps createdAt, so the new buyer's offer was already overdue and the next sweep
 *     (five minutes) voided it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resError } from './helpers/api.js';

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
const { updatePlatformSettings } = await import('../src/services/settings.service.js');
const { APPROVED_TEST_CARD } = await import('../src/services/payment-gateway.service.js');
const { findOverduePayments, offerToNextBidder, relistFromVoidedTransaction, voidOverduePayment } = await import(
  '../src/services/auction-control.service.js'
);

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const HOUR = 60 * 60 * 1000;

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

// The seeded closed auction has one bid: `buyer` at 8,000, who owes the PENDING transaction.
const txRow = () => prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
const setStatus = (status: 'VOIDED' | 'PENDING' | 'FAILED') =>
  prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status } });

async function removeOriginalListing() {
  const auction = await prisma.auction.findUniqueOrThrow({ where: { id: w.closedAuctionId } });
  await prisma.listing.update({ where: { id: auction.listingId }, data: { status: 'REMOVED', rejectionReason: 'Counterfeit' } });
  return auction.listingId;
}

const pay = (token = w.buyer.token) =>
  request(app)
    .post(api(`/payments/${w.transactionId}/pay`))
    .set(bearer(token))
    .send({ cardNumber: APPROVED_TEST_CARD, deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567' });

describe('paying a sale', () => {
  it('is refused once the sale has been voided, and the sale stays voided', async () => {
    await setStatus('VOIDED');

    const res = await pay();

    expect(res.status).toBe(409);
    expect(resError(res).error).toMatch(/no longer be paid/i);
    const row = await txRow();
    expect(row.status).toBe('VOIDED');
    expect(row.paymentReference).toBeNull();
    expect(row.paidAt).toBeNull();
  });

  it('is refused for a buyer who was offered the item and then had it voided again', async () => {
    await prisma.bid.create({ data: { auctionId: w.closedAuctionId, buyerId: w.otherBuyer.id, amount: 7_000 } });
    await setStatus('VOIDED');
    expect((await offerToNextBidder(w.transactionId, w.seller.id)).kind).toBe('ok');
    await setStatus('VOIDED');

    const res = await pay(w.otherBuyer.token);

    expect(res.status).toBe(409);
    expect((await txRow()).status).toBe('VOIDED');
  });

  it('still works for a sale that is waiting for payment, and for one whose card was declined', async () => {
    await setStatus('FAILED');

    const res = await pay();

    expect(res.status).toBe(200);
    expect((await txRow()).status).toBe('COMPLETED');
  });

  it('still tells a buyer who already paid that it was already paid', async () => {
    expect((await pay()).status).toBe(200);

    const again = await pay();

    expect(again.status).toBe(409);
    expect(resError(again).error).toMatch(/already been paid/i);
  });
});

describe('recovering a sale whose item an admin removed', () => {
  it('does not relist it, and creates nothing', async () => {
    await setStatus('VOIDED');
    await removeOriginalListing();
    const listings = await prisma.listing.count();

    const result = await relistFromVoidedTransaction(w.transactionId, w.seller.id);

    expect(result.kind).toBe('wrong-state');
    expect(await prisma.listing.count()).toBe(listings);
  });

  it('does not offer it to the next bidder, and leaves the sale as it was', async () => {
    await prisma.bid.create({ data: { auctionId: w.closedAuctionId, buyerId: w.otherBuyer.id, amount: 7_000 } });
    await setStatus('VOIDED');
    await removeOriginalListing();

    const result = await offerToNextBidder(w.transactionId, w.seller.id);

    expect(result.kind).toBe('wrong-state');
    const row = await txRow();
    expect(row.status).toBe('VOIDED');
    expect(row.winnerId).toBe(w.buyer.id);
    expect(row.previousWinnerIds).toEqual([]);
  });

  it('never produces a live copy of a removed item, however many times it is asked', async () => {
    await setStatus('VOIDED');
    const listingId = await removeOriginalListing();

    const results = await Promise.all([
      relistFromVoidedTransaction(w.transactionId, w.seller.id),
      relistFromVoidedTransaction(w.transactionId, w.seller.id),
    ]);

    expect(results.map((r) => r.kind)).toEqual(['wrong-state', 'wrong-state']);
    expect(await prisma.listing.count({ where: { relistedFromId: listingId } })).toBe(0);
  });
});

describe('the payment clock after a second-chance offer', () => {
  it('starts again at the offer: a sale offered after the first deadline is not overdue', async () => {
    await prisma.bid.create({ data: { auctionId: w.closedAuctionId, buyerId: w.otherBuyer.id, amount: 7_000 } });
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'VOIDED', createdAt: new Date(Date.now() - 3 * 24 * HOUR) },
    });

    expect((await offerToNextBidder(w.transactionId, w.seller.id)).kind).toBe('ok');

    const row = await txRow();
    const { paymentDeadlineHours } = await (await import('../src/services/settings.service.js')).getPlatformSettings();
    expect(row.paymentDueAt).not.toBeNull();
    expect(Math.abs(row.paymentDueAt!.getTime() - (Date.now() + paymentDeadlineHours * HOUR))).toBeLessThan(60_000);
    expect(await findOverduePayments()).not.toContain(w.transactionId);
  });

  it('is overdue once the new deadline passes, and then the sweep voids it', async () => {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { paymentDueAt: new Date(Date.now() - 60_000) },
    });

    expect(await findOverduePayments()).toContain(w.transactionId);
    expect((await voidOverduePayment(w.transactionId)).kind).toBe('ok');
    expect((await txRow()).status).toBe('VOIDED');
  });

  it("does not void a sale on the strength of an old sweep result: the deadline is checked again under the lock", async () => {
    // The sweep reads its list, then voids each id one by one. In between, the seller can offer the
    // item to someone else, which gives that sale a fresh deadline.
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { createdAt: new Date(Date.now() - 3 * 24 * HOUR), paymentDueAt: new Date(Date.now() + 24 * HOUR) },
    });

    expect((await voidOverduePayment(w.transactionId)).kind).toBe('wrong-state');
    expect((await txRow()).status).toBe('PENDING');
  });

  it('still reads the deadline from createdAt for a sale that has no due date of its own', async () => {
    await updatePlatformSettings({ paymentDeadlineHours: 1 });
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { createdAt: new Date(Date.now() - 2 * HOUR), paymentDueAt: null },
    });

    expect(await findOverduePayments()).toContain(w.transactionId);
    expect((await voidOverduePayment(w.transactionId)).kind).toBe('ok');
  });
});
