/**
 * A cancelled auction must never be closed into a sale (FR-01 in docs/FULL-REVIEW-2026-11-08.md,
 * first raised as Codex CX-001), and a cancel must not fail because its scheduled close job could
 * not be removed (FR-07).
 *
 * How the two meet: cancelling an auction removes its `auction:end` job only after the cancel has
 * committed. That removal can fail (Redis unreachable, or BullMQ refusing to remove a job another
 * worker is running). The job then survives and fires at the auction's end time, and closeAuction
 * used to refuse only an auction that was already CLOSED, so it closed the CANCELLED one into a
 * winner, an unpaid sale and a "You won" e-mail. The same thing happens without any failure when
 * the job is already running: it waits on the auction's row lock while the cancel holds it, then
 * reads CANCELLED and carried on.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'socket.io';

const mail = vi.hoisted(() => ({ send: vi.fn(() => Promise.resolve({ data: { id: 'email_test' }, error: null })) }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mail.send };
  },
}));

// Lets a test make the job removal fail the way Redis or BullMQ can make it fail; otherwise the
// real function runs.
const queue = vi.hoisted(() => ({ failRemoval: false }));

vi.mock('../src/queues/auction-lifecycle.queue.js', async () => {
  const actual = await vi.importActual<typeof import('../src/queues/auction-lifecycle.queue.js')>(
    '../src/queues/auction-lifecycle.queue.js',
  );
  return {
    ...actual,
    cancelScheduledJob: vi.fn((auctionId: string) =>
      queue.failRemoval
        ? Promise.reject(new Error('Job auction:end:x could not be removed because it is locked by another worker'))
        : actual.cancelScheduledJob(auctionId),
    ),
  };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');
const { closeAuction } = await import('../src/workers/close-auction.js');
const { cancelAuction } = await import('../src/services/auction-control.service.js');

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
  queue.failRemoval = false;
  w = await seedWorld();
  mail.send.mockClear();
});

afterEach(() => {
  takeViolations();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

/** cancelAuction only calls `.to(room).emit(event, payload)`. */
function mockIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as unknown as Server, to, emit };
}

/** An auction whose time has run out, with one bid from `buyer` and no reserve: closing it sells. */
async function auctionPastItsEnd(code: string) {
  const listing = await prisma.listing.create({
    data: {
      listingCode: code,
      sellerId: w.seller.id,
      title: 'Cancelled Then Closed',
      category: 'Electronics & Gadgets',
      condition: 'USED',
      description: 'An auction cancelled before its close job ran.',
      startPrice: 1_000,
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
      minIncrement: listing.minIncrement,
      currentBid: 2_000,
      bidCount: 1,
      status: 'ACTIVE',
      startTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endTime: new Date(Date.now() - 60 * 1000),
    },
  });
  await prisma.bid.create({ data: { auctionId: auction.id, buyerId: w.buyer.id, amount: 2_000 } });
  return auction.id;
}

const statusOf = async (id: string) => (await prisma.auction.findUniqueOrThrow({ where: { id } })).status;
const salesFor = (id: string) => prisma.auctionTransaction.count({ where: { auctionId: id } });
const wins = () => prisma.notification.count({ where: { userId: w.buyer.id, type: 'AUCTION_WON' } });

describe('closing an auction that was cancelled', () => {
  it('leaves it cancelled: no sale, no winner notice, no e-mail', async () => {
    const id = await auctionPastItsEnd('TEST-CANCELLED-CLOSE-1');
    await prisma.auction.update({ where: { id }, data: { status: 'CANCELLED' } });
    const winsBefore = await wins();

    const result = await closeAuction(id);

    expect(result.sold).toBe(false);
    expect(await statusOf(id)).toBe('CANCELLED');
    expect(await salesFor(id)).toBe(0);
    expect(await wins()).toBe(winsBefore);
    expect((await prisma.auction.findUniqueOrThrow({ where: { id } })).reserveMet).toBeNull();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('a close job that was waiting on the row lock while the auction was cancelled does nothing', async () => {
    const id = await auctionPastItsEnd('TEST-CANCELLED-CLOSE-2');

    // The cancel's UPDATE, held open: the close job has to wait for it on the row lock.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const cancel = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Auction" WHERE id = ${id} FOR UPDATE`;
      await tx.auction.update({ where: { id }, data: { status: 'CANCELLED' } });
      held();
      await gate;
    });
    await holding;

    let settled = false;
    const closing = closeAuction(id).then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const waitedForCancel = !settled;

    release();
    await cancel;
    const result = await closing;

    expect(waitedForCancel).toBe(true);
    expect(result.sold).toBe(false);
    expect(await statusOf(id)).toBe('CANCELLED');
    expect(await salesFor(id)).toBe(0);
  });
});

describe('cancelling when the scheduled close job cannot be removed', () => {
  it('still answers 200 to the seller and leaves the auction cancelled', async () => {
    queue.failRemoval = true;
    const id = await auctionPastItsEnd('TEST-CANCELLED-CLOSE-3');
    // The seller's own path refuses an auction with bids; this one has none.
    await prisma.bid.deleteMany({ where: { auctionId: id } });
    await prisma.auction.update({ where: { id }, data: { bidCount: 0, currentBid: 1_000, endTime: new Date(Date.now() + 60 * 60 * 1000) } });

    const res = await request(app)
      .post(api(`/auctions/${id}/cancel`))
      .set(bearer(w.seller.token))
      .send({ reason: 'No longer selling this.' });

    expect(res.status).toBe(200);
    expect(await statusOf(id)).toBe('CANCELLED');
  });

  it('still tells the people watching and e-mails the seller and every bidder', async () => {
    queue.failRemoval = true;
    const { io, to, emit } = mockIo();

    const result = await cancelAuction(
      w.liveAuctionId,
      { userId: w.admin.id, isAdmin: true, reason: 'Suspected shill bidding.' },
      io,
    );

    expect(result.kind).toBe('ok');
    expect(to).toHaveBeenCalledWith(`auction:${w.liveAuctionId}`);
    expect(emit).toHaveBeenCalledWith('auction:cancelled', expect.objectContaining({ auctionId: w.liveAuctionId }));
    // The seller and the one bidder on the seeded live auction.
    await vi.waitFor(() => expect(mail.send).toHaveBeenCalledTimes(2));
  });

  it('the job that survived finds nothing to close when it fires', async () => {
    queue.failRemoval = true;
    const id = await auctionPastItsEnd('TEST-CANCELLED-CLOSE-4');

    const cancelled = await cancelAuction(id, { userId: w.admin.id, isAdmin: true, reason: 'Pricing error.' });
    expect(cancelled.kind).toBe('ok');

    // What the surviving `auction:end` job does when it runs.
    const result = await closeAuction(id);

    expect(result.sold).toBe(false);
    expect(await statusOf(id)).toBe('CANCELLED');
    expect(await salesFor(id)).toBe(0);
  });
});
