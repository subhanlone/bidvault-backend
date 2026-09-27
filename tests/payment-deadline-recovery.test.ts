/**
 * Phase 6 (LIFECYCLE-IMPLEMENTATION-PLAN.md): A3 (a winner who never pays used to lock the item
 * forever — the worker's sweep now auto-voids an overdue PENDING transaction) and A5 (the
 * seller's two recovery options on a VOIDED transaction: offer it to the next-highest bidder at
 * their own last bid, or relist the item as a fresh Listing + Auction pair).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const mail = vi.hoisted(() => ({ send: vi.fn(async () => ({ data: { id: 'email_test' }, error: null })) }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mail.send };
  },
}));

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');
const { updatePlatformSettings } = await import('../src/services/settings.service.js');
const { findOverduePayments, voidOverduePayment } = await import('../src/services/auction-control.service.js');

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
  mail.send.mockClear();
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

describe('findOverduePayments / voidOverduePayment (A3)', () => {
  it('does not flag a transaction still inside the payment deadline', async () => {
    const overdue = await findOverduePayments();
    expect(overdue).not.toContain(w.transactionId);
  });

  it('flags and voids a transaction whose deadline has elapsed', async () => {
    await updatePlatformSettings({ paymentDeadlineHours: 1 });
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const overdue = await findOverduePayments();
    expect(overdue).toContain(w.transactionId);

    const result = await voidOverduePayment(w.transactionId);
    expect(result.kind).toBe('ok');

    const row = await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
    expect(row.status).toBe('VOIDED');

    // LIFECYCLE-IMPLEMENTATION-PLAN.md's A3 section: "writes an AuditLog row" -- system-initiated,
    // so no actor.
    const auditRow = await prisma.auditLog.findFirst({
      where: { entityId: w.transactionId, action: 'TRANSACTION_VOIDED_OVERDUE' },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorUserId).toBeNull();
    expect(auditRow?.entityType).toBe('AuctionTransaction');

    await new Promise((r) => setTimeout(r, 50));
    expect(mail.send).toHaveBeenCalled();
  });

  it('is a no-op on a transaction that is not PENDING', async () => {
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'COMPLETED' } });
    const result = await voidOverduePayment(w.transactionId);
    expect(result.kind).toBe('wrong-state');
  });
});

describe('offer-next-bidder (A5)', () => {
  async function voidedTransactionWithSecondBidder() {
    // otherBuyer bids below the winner (buyer, 8,000) on the already-closed auction, so it
    // becomes the next-highest bid once the winner's transaction is voided.
    await prisma.bid.create({ data: { auctionId: w.closedAuctionId, buyerId: w.otherBuyer.id, amount: 7_000 } });
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'VOIDED' } });
  }

  it("re-targets the same transaction row at the next bidder, at the next bidder's own amount", async () => {
    await voidedTransactionWithSecondBidder();

    const res = await request(app)
      .post(api(`/payments/${w.transactionId}/offer-next-bidder`))
      .set(auth(w.seller.token));

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING');

    const row = await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
    expect(row.status).toBe('PENDING');
    expect(row.winnerId).toBe(w.otherBuyer.id);
    expect(row.finalAmount).toBe(7_000);

    // Still the same row (auctionId is @@unique) — not a second transaction.
    const count = await prisma.auctionTransaction.count({ where: { auctionId: w.closedAuctionId } });
    expect(count).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    expect(mail.send).toHaveBeenCalled();
  });

  it('refuses when there is no other bidder to offer it to', async () => {
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'VOIDED' } });
    const res = await request(app)
      .post(api(`/payments/${w.transactionId}/offer-next-bidder`))
      .set(auth(w.seller.token));
    expect(res.status).toBe(409);
  });

  it('refuses on a transaction that is not VOIDED', async () => {
    await prisma.bid.create({ data: { auctionId: w.closedAuctionId, buyerId: w.otherBuyer.id, amount: 7_000 } });
    const res = await request(app)
      .post(api(`/payments/${w.transactionId}/offer-next-bidder`))
      .set(auth(w.seller.token));
    expect(res.status).toBe(409);
  });

  it("refuses for a seller who doesn't own the transaction", async () => {
    await voidedTransactionWithSecondBidder();
    const res = await request(app)
      .post(api(`/payments/${w.transactionId}/offer-next-bidder`))
      .set(auth(w.otherSeller.token));
    expect(res.status).toBe(403);
  });
});

describe('relist (A5)', () => {
  it('creates a fresh Listing + Auction pair, leaving the original rows untouched', async () => {
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'VOIDED' } });

    const res = await request(app)
      .post(api(`/payments/${w.transactionId}/relist`))
      .set(auth(w.seller.token));

    expect(res.status).toBe(200);
    const { listingId, auctionId } = res.body.data;
    expect(listingId).not.toBe(w.closedAuctionId);

    const newListing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(newListing.status).toBe('APPROVED');
    expect(newListing.title).toBe('Closed Test Auction');

    const newAuction = await prisma.auction.findUniqueOrThrow({ where: { id: auctionId } });
    expect(newAuction.status).toBe('ACTIVE');
    expect(newAuction.listingId).toBe(listingId);

    // The original, already-closed auction is untouched — a relist is a new cycle, not a
    // reopening (Auction.listingId is @@unique, so it could never be reopened in place).
    const originalAuction = await prisma.auction.findUniqueOrThrow({ where: { id: w.closedAuctionId } });
    expect(originalAuction.status).toBe('CLOSED');
  });

  it('refuses to relist a transaction that is not VOIDED', async () => {
    const res = await request(app)
      .post(api(`/payments/${w.transactionId}/relist`))
      .set(auth(w.seller.token));
    expect(res.status).toBe(409);
  });
});
