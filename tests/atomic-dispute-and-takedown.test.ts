/**
 * Two admin actions that used to be two transactions each, so that a failure or a race between
 * them left the records disagreeing (FR-06 and FR-09 in docs/FULL-REVIEW-2026-11-08.md, first
 * raised as Codex CX-006 and CX-007):
 *
 *  - FR-06: resolving a dispute in the seller's favour committed the dispute as resolved, then
 *    delivered the sale and paid the seller in a second transaction whose outcome was ignored. If
 *    the payout failed, the dispute was closed (so it left the admin's list) while the sale stayed
 *    DISPUTED and the seller was never paid, with nothing anywhere to retry it.
 *  - FR-09: a takedown checked the listing outside any lock, committed REMOVED, then cancelled the
 *    auction separately. A close job running at that moment turned the auction into a sale after
 *    the takedown had looked for one, so the removed item's sale stayed open; and two takedowns of
 *    one listing both went through.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(() => Promise.resolve({ data: { id: 'email_test' }, error: null })) };
  },
}));

const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');
const { markShipped, raiseDispute, resolveDispute } = await import('../src/services/fulfillment.service.js');
const { takedownListing } = await import('../src/services/auction-control.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;
let w: World;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

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

describe('resolving a dispute in the seller\'s favour', () => {
  // The seeded sale: buyer owes seller 8,000 on the closed auction. Paid, shipped, then disputed.
  async function disputed() {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'COMPLETED', deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567' },
    });
    await markShipped(w.transactionId, w.seller.id);
    await raiseDispute(w.transactionId, w.buyer.id, 'Arrived damaged.');
    return prisma.dispute.findUniqueOrThrow({ where: { transactionId: w.transactionId } });
  }

  // The payout adds 8,000 to the seller's balance, an int4 column: from here that overflows, and
  // the database refuses the write. A real failure of the payout, not a mocked one.
  const INT4_MAX = 2_147_483_647;
  const setBalance = (ledgerBalance: number) => prisma.user.update({ where: { id: w.seller.id }, data: { ledgerBalance } });

  it('leaves everything as it was when the payout cannot be written', async () => {
    const dispute = await disputed();
    await setBalance(INT4_MAX - 1_000);

    await expect(resolveDispute(dispute.id, w.admin.id, 'RELEASE', 'Seller showed proof of delivery.')).rejects.toThrow();

    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })).status).toBe('OPEN');
    expect((await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } })).status).toBe('DISPUTED');
    expect(await prisma.ledgerEntry.count({ where: { transactionId: w.transactionId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'DISPUTE_RESOLVED_RELEASED', entityId: dispute.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: w.buyer.id, type: 'DISPUTE_RESOLVED' } })).toBe(0);
  });

  it('can be retried once the cause is fixed, and then pays the seller', async () => {
    const dispute = await disputed();
    await setBalance(INT4_MAX - 1_000);
    await expect(resolveDispute(dispute.id, w.admin.id, 'RELEASE', 'First try.')).rejects.toThrow();

    await setBalance(0);
    const retry = await resolveDispute(dispute.id, w.admin.id, 'RELEASE', 'Second try.');

    expect(retry.kind).toBe('ok');
    expect((await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } })).status).toBe('DELIVERED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.seller.id } })).ledgerBalance).toBe(8_000);
    expect((await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } })).status).toBe('RESOLVED_RELEASED');
  });
});

describe('a takedown', () => {
  const liveListingId = async () =>
    (await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } })).listingId;

  it('that waits for a close in progress cancels the sale that close created', async () => {
    const listingId = await liveListingId();
    const live = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });

    // What closeAuction does under the auction's row lock: CLOSED, and a sale for the top bidder.
    const { waited, result } = await whileHeld(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${w.liveAuctionId} FOR UPDATE`;
        await tx.auction.update({ where: { id: w.liveAuctionId }, data: { status: 'CLOSED' } });
        await tx.auctionTransaction.create({
          data: { auctionId: w.liveAuctionId, winnerId: w.buyer.id, sellerId: w.seller.id, finalAmount: live.currentBid, status: 'PENDING' },
        });
      },
      () => takedownListing(listingId, w.admin.id, 'Stolen item.'),
    );

    expect(waited).toBe(true);
    expect(result.kind).toBe('ok');
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe('REMOVED');
    const sale = await prisma.auctionTransaction.findUniqueOrThrow({ where: { auctionId: w.liveAuctionId } });
    expect(sale.status).toBe('VOIDED');
  });

  it('of a listing another takedown is removing at that moment is refused', async () => {
    const listingId = await liveListingId();

    const { waited, result } = await whileHeld(
      (tx) => tx.listing.update({ where: { id: listingId }, data: { status: 'REMOVED', rejectionReason: 'Counterfeit.' } }),
      () => takedownListing(listingId, w.admin.id, 'Counterfeit, reported twice.'),
    );

    expect(waited).toBe(true);
    expect(result.kind).toBe('wrong-state');
    expect(await prisma.auditLog.count({ where: { action: 'LISTING_REMOVED', entityId: listingId } })).toBe(0);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).rejectionReason).toBe('Counterfeit.');
  });
});
