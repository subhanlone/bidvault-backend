/**
 * Moderation decisions on a listing must be made against the listing as it is, not as it was a
 * moment ago (FR-05 and FR-22 in docs/FULL-REVIEW-2026-11-08.md).
 *
 * Approve, reject and withdraw used to read the listing's status before their transaction and then
 * write without looking again. Two decisions in flight together therefore both passed the check:
 * "Approve all", which works through up to 50 listings it read at the start, approved one an admin
 * had just rejected; a reject that landed after an approve left a REJECTED listing with a live
 * auction; a withdraw that landed after an approve tried to delete a listing an auction now
 * pointed at (a 500); and one listing withdrawn mid-batch failed the whole "Approve all".
 *
 * Each test holds the competing change open in a transaction (the row lock its UPDATE or DELETE
 * takes), starts the decision under test, then lets the change commit. The decision must wait for
 * it and then see it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Prisma } from '@prisma/client';
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
const { seedWorld } = await import('./helpers/world.js');

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

/**
 * Makes `change` inside a transaction that is held open, starts `action`, waits long enough for it
 * to reach the row lock, then commits the change. Reports whether `action` was still waiting when
 * the change committed.
 */
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

/** What an approval writes: the listing APPROVED and its live auction. */
async function approveInside(tx: Prisma.TransactionClient, listingId: string) {
  const listing = await tx.listing.update({ where: { id: listingId }, data: { status: 'APPROVED' } });
  await tx.auction.create({
    data: {
      listingId: listing.id,
      sellerId: listing.sellerId,
      title: listing.title,
      category: listing.category,
      condition: listing.condition,
      description: listing.description,
      startPrice: listing.startPrice,
      minIncrement: listing.minIncrement,
      currentBid: listing.startPrice,
      status: 'ACTIVE',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    },
  });
}

async function anotherPendingListing(code: string) {
  return prisma.listing.create({
    data: {
      listingCode: code,
      sellerId: w.seller.id,
      title: 'Another Pending Listing',
      category: 'Electronics & Gadgets',
      condition: 'NEW',
      description: 'A second listing in the review queue.',
      startPrice: 10_000,
      minIncrement: 500,
      durationDays: 3,
      status: 'PENDING',
    },
  });
}

const listing = (id: string) => prisma.listing.findUnique({ where: { id } });
const auctionOf = (listingId: string) => prisma.auction.findUnique({ where: { listingId } });

const approveAll = () => request(app).post(api('/listings/approve-all')).set(bearer(w.admin.token));
const approve = (id: string) => request(app).post(api(`/listings/${id}/approve`)).set(bearer(w.admin.token));
const reject = (id: string) =>
  request(app).post(api(`/listings/${id}/reject`)).set(bearer(w.admin.token)).send({ reason: 'Blurry photo.' });
const withdraw = (id: string) => request(app).delete(api(`/listings/${id}`)).set(bearer(w.seller.token));

describe('approve-all', () => {
  it('leaves a listing that was rejected during the batch rejected, and reports it', async () => {
    const id = w.pendingListingId;

    const { waited, result } = await whileHeld(
      (tx) => tx.listing.update({ where: { id }, data: { status: 'REJECTED', rejectionReason: 'Prohibited item.' } }),
      approveAll,
    );

    expect(waited).toBe(true);
    expect(result.status).toBe(200);
    const body = resData<{ failures: { listingId: string }[] }>(result);
    expect(body.failures.map((f) => f.listingId)).toContain(id);
    expect((await listing(id))?.status).toBe('REJECTED');
    expect(await auctionOf(id)).toBeNull();
  });

  it('carries on past a listing the seller withdrew during the batch', async () => {
    const other = await anotherPendingListing('TEST-RACE-OTHER-1');
    const id = w.pendingListingId;

    const { waited, result } = await whileHeld((tx) => tx.listing.delete({ where: { id } }), approveAll);

    expect(waited).toBe(true);
    expect(result.status).toBe(200);
    const body = resData<{ approved: number; failures: { listingId: string }[] }>(result);
    expect(body.failures.map((f) => f.listingId)).toContain(id);
    expect((await listing(other.id))?.status).toBe('APPROVED');
    expect(await auctionOf(other.id)).not.toBeNull();
  });
});

describe('a single decision against a change in flight', () => {
  it('an approve that waited for a reject is refused and creates no auction', async () => {
    const id = w.pendingListingId;

    const { waited, result } = await whileHeld(
      (tx) => tx.listing.update({ where: { id }, data: { status: 'REJECTED', rejectionReason: 'Prohibited item.' } }),
      () => approve(id),
    );

    expect(waited).toBe(true);
    expect(result.status).toBe(400);
    expect((await listing(id))?.status).toBe('REJECTED');
    expect(await auctionOf(id)).toBeNull();
  });

  it('a reject that waited for an approve is refused and the auction stays live', async () => {
    const id = w.pendingListingId;

    const { waited, result } = await whileHeld((tx) => approveInside(tx, id), () => reject(id));

    expect(waited).toBe(true);
    expect(result.status).toBe(409);
    expect((await listing(id))?.status).toBe('APPROVED');
    expect((await auctionOf(id))?.status).toBe('ACTIVE');
  });

  it('a withdraw that waited for an approve is refused, not a 500', async () => {
    const id = w.pendingListingId;

    const { waited, result } = await whileHeld((tx) => approveInside(tx, id), () => withdraw(id));

    expect(waited).toBe(true);
    expect(result.status).toBe(409);
    expect((await listing(id))?.status).toBe('APPROVED');
  });
});
