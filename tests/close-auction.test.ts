/**
 * The auction-close path — the one place a bug costs somebody money.
 *
 * BUG-15 lived here: the reserve price was collected, stored, and displayed to the seller as
 * "Auction won't close below this amount", and never compared against anything. An auction
 * closed 17% under its floor, declared a winner and invoiced them. The fix has been in
 * production since 2026-08-09 with nothing testing it; these are that test.
 *
 * The rule, stated once: an auction that ends below its reserve closes UNSOLD. No winner, no
 * AuctionTransaction, nothing owed — and both parties told why.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The close path awaits its emails deliberately (a failed send should fail the job rather than
// vanish into a log). Nothing here should reach Resend, and the service no-ops without an API
// key anyway — mocked so the test does not depend on that staying true.
vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return {
    ...actual,
    sendAuctionEndedEmail: vi.fn(async () => undefined),
    sendReserveNotMetEmail: vi.fn(async () => undefined),
  };
});

const { closeAuction } = await import('../src/workers/close-auction.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');
const email = await import('../src/services/email.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;
let w: World;

beforeEach(async () => {
  w = await seedWorld();
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

/** An ACTIVE auction that has just run out of time, with one bid on it. */
async function endingAuction(opts: { reservePrice: number | null; topBid: number | null }) {
  const listing = await prisma.listing.create({
    data: {
      listingCode: `TEST-CLOSE-${Math.random().toString(36).slice(2, 8)}`,
      sellerId: w.seller.id,
      title: 'Auction Under Test',
      category: 'Electronics & Gadgets',
      condition: 'USED',
      description: 'Seeded by the close-auction suite.',
      startPrice: 1_000,
      reservePrice: opts.reservePrice ?? undefined,
      minIncrement: 100,
      durationDays: 1,
      status: 'APPROVED',
    },
  });

  const auction = await prisma.auction.create({
    data: {
      listingId: listing.id,
      sellerId: w.seller.id,
      title: listing.title,
      category: listing.category,
      condition: listing.condition,
      description: listing.description,
      startPrice: listing.startPrice,
      reservePrice: opts.reservePrice,
      minIncrement: listing.minIncrement,
      currentBid: opts.topBid ?? listing.startPrice,
      bidCount: opts.topBid === null ? 0 : 1,
      status: 'ACTIVE',
      startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endTime: new Date(Date.now() - 60 * 1000),
    },
  });

  if (opts.topBid !== null) {
    await prisma.bid.create({
      data: { auctionId: auction.id, buyerId: w.buyer.id, amount: opts.topBid },
    });
  }

  return auction.id;
}

const reload = (id: string) => prisma.auction.findUniqueOrThrow({ where: { id } });
const transactionFor = (id: string) => prisma.auctionTransaction.findFirst({ where: { auctionId: id } });

describe('closeAuction', () => {
  it('sells when the top bid clears the reserve', async () => {
    const id = await endingAuction({ reservePrice: 5_000, topBid: 6_000 });

    const result = await closeAuction(id);

    expect(result).toMatchObject({ alreadyClosed: false, reserveMet: true, sold: true });
    expect((await reload(id)).status).toBe('CLOSED');
    expect(await transactionFor(id)).toMatchObject({
      winnerId: w.buyer.id,
      sellerId: w.seller.id,
      finalAmount: 6_000,
      status: 'PENDING',
    });
  });

  it('sells at exactly the reserve — the floor is inclusive', async () => {
    // The copy says "won't close below this amount", so equal must sell. An off-by-one here
    // would refuse a sale the seller agreed to.
    const id = await endingAuction({ reservePrice: 5_000, topBid: 5_000 });

    const result = await closeAuction(id);

    expect(result.reserveMet).toBe(true);
    expect(result.sold).toBe(true);
    expect(await transactionFor(id)).not.toBeNull();
  });

  // ---- BUG-15 ---------------------------------------------------------------------------

  it('does NOT sell below the reserve, and owes nobody anything', async () => {
    const id = await endingAuction({ reservePrice: 5_000, topBid: 4_999 });

    const result = await closeAuction(id);

    expect(result).toMatchObject({ alreadyClosed: false, reserveMet: false, sold: false });

    const auction = await reload(id);
    expect(auction.status).toBe('CLOSED');
    expect(auction.reserveMet).toBe(false);

    // The whole point: no transaction, so nothing is owed and My Wins cannot show it.
    expect(await transactionFor(id)).toBeNull();

    // Both parties are told, and the bidder is told even though they did not win.
    const notes = await prisma.notification.findMany({
      where: { type: 'RESERVE_NOT_MET' },
      orderBy: { userId: 'asc' },
    });
    expect(notes.map((n) => n.userId).sort()).toEqual([w.buyer.id, w.seller.id].sort());

    expect(email.sendReserveNotMetEmail).toHaveBeenCalledTimes(1);
    expect(email.sendAuctionEndedEmail).not.toHaveBeenCalled();
  });

  // ---- the other outcomes ------------------------------------------------------------------

  it('sells to the top bidder when no reserve was set', async () => {
    const id = await endingAuction({ reservePrice: null, topBid: 2_000 });

    const result = await closeAuction(id);

    expect(result.reserveMet).toBeNull();
    expect(result.sold).toBe(true);
    expect(await transactionFor(id)).toMatchObject({ finalAmount: 2_000 });
  });

  it('closes with no transaction when nobody bid', async () => {
    const id = await endingAuction({ reservePrice: null, topBid: null });

    const result = await closeAuction(id);

    expect(result.sold).toBe(false);
    expect((await reload(id)).status).toBe('CLOSED');
    expect(await transactionFor(id)).toBeNull();
    // The seller still hears that it ended.
    expect(email.sendAuctionEndedEmail).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a retried job writes nothing and invoices nobody twice', async () => {
    // BullMQ retries three times with backoff, and reconcileOverdueAuctions re-queues every
    // five minutes. Both can deliver the same close twice; AuctionTransaction's unique
    // constraint would throw on the second, failing a job that had already succeeded.
    const id = await endingAuction({ reservePrice: 1_000, topBid: 3_000 });

    const first = await closeAuction(id);
    const second = await closeAuction(id);

    expect(first.sold).toBe(true);
    expect(second.alreadyClosed).toBe(true);
    expect(await prisma.auctionTransaction.count({ where: { auctionId: id } })).toBe(1);
    // The second pass sends nothing — the winner is not congratulated twice.
    expect(email.sendAuctionEndedEmail).toHaveBeenCalledTimes(1);
  });

  it('honours the winner opting out of win notifications', async () => {
    await prisma.user.update({ where: { id: w.buyer.id }, data: { notifyWins: false } });
    const id = await endingAuction({ reservePrice: null, topBid: 2_500 });

    // Counted as a delta: seedWorld already gives this buyer an AUCTION_WON row, so an
    // absolute count would pass or fail on the fixture rather than on this close.
    const where = { userId: w.buyer.id, type: 'AUCTION_WON' };
    const before = await prisma.notification.count({ where });

    await closeAuction(id);

    // The sale still happens and is still owed — only the announcement is suppressed.
    expect(await transactionFor(id)).not.toBeNull();
    expect(await prisma.notification.count({ where })).toBe(before);
  });

  it('does nothing for an auction that does not exist', async () => {
    const result = await closeAuction('cl00000000000000000000000');
    expect(result).toMatchObject({ alreadyClosed: false, sold: false });
  });

});
