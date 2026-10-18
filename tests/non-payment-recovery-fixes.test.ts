/**
 * Three holes in the seller's recovery options on a VOIDED sale (A5), all of them found by reading
 * auction-control.service.ts and reproduced here before they were fixed:
 *
 *  1. offerToNextBidder excluded only the *current* winner, so once the second bidder also
 *     defaulted, the offer went back to the first one -- who had already defaulted.
 *  2. relistFromVoidedTransaction checked VOIDED outside its transaction and never marked the sale,
 *     so the same sale could be relisted any number of times.
 *  3. offerToNextBidder never looked at whether the item had already been relisted, so it could be
 *     live in a new auction and offered to the old runner-up at the same time.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(() => Promise.resolve({ data: { id: 'email_test' }, error: null })) };
  },
}));

// A real listingCode collision has odds of about 1 in 10^12, so the only way to exercise the
// retry is to make the generator hand out a code that is already taken. Everything else about it
// stays real; with nothing queued it is the original function.
const codes = vi.hoisted(() => ({ next: [] as string[] }));
vi.mock('../src/modules/listings/listings.routes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/listings/listings.routes.js')>();
  return { ...actual, generateListingCode: () => codes.next.shift() ?? actual.generateListingCode() };
});

const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');
const { offerToNextBidder, relistFromVoidedTransaction } = await import(
  '../src/services/auction-control.service.js'
);

type World = Awaited<ReturnType<typeof seedWorld>>;

let w: World;
let thirdBuyerId: string;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
  const third = await prisma.user.create({
    data: { name: 'Third Buyer', email: 'third-buyer@test.local', passwordHash: 'x', role: 'BUYER', isEmailVerified: true },
  });
  thirdBuyerId = third.id;
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
async function bid(buyerId: string, amount: number) {
  await prisma.bid.create({ data: { auctionId: w.closedAuctionId, buyerId, amount } });
}

async function setStatus(status: 'VOIDED' | 'PENDING') {
  await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status } });
}

async function originalListingId() {
  const auction = await prisma.auction.findUniqueOrThrow({ where: { id: w.closedAuctionId } });
  return auction.listingId;
}

const txRow = () => prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
const offer = () => offerToNextBidder(w.transactionId, w.seller.id);
const relist = () => relistFromVoidedTransaction(w.transactionId, w.seller.id);

describe('offer-next-bidder never goes back to someone who already defaulted', () => {
  it('second chance never returns to an earlier defaulter', async () => {
    await bid(w.otherBuyer.id, 7_000);
    await setStatus('VOIDED');

    expect((await offer()).kind).toBe('ok');
    expect((await txRow()).winnerId).toBe(w.otherBuyer.id);

    // otherBuyer defaults too. The highest remaining bid is the original winner's 8,000, but
    // that bidder already defaulted, so there is nobody left to offer to.
    await setStatus('VOIDED');
    expect((await offer()).kind).toBe('no-other-bidder');

    const row = await txRow();
    expect(row.winnerId).toBe(w.otherBuyer.id);
    expect(row.status).toBe('VOIDED');
  });

  it("walks down the bids in order and skips an earlier defaulter's lower bids too", async () => {
    await bid(w.otherBuyer.id, 7_000);
    await bid(thirdBuyerId, 6_000);
    // The original winner also has an older, lower bid. A rule like "only consider bids below the
    // current sale amount" would let it back in; excluding the person does not.
    await bid(w.buyer.id, 5_000);
    await setStatus('VOIDED');

    expect((await offer()).kind).toBe('ok');
    expect((await txRow()).winnerId).toBe(w.otherBuyer.id);

    await setStatus('VOIDED');
    expect((await offer()).kind).toBe('ok');
    const second = await txRow();
    expect(second.winnerId).toBe(thirdBuyerId);
    expect(second.finalAmount).toBe(6_000);
    expect(second.previousWinnerIds).toEqual([w.buyer.id, w.otherBuyer.id]);

    await setStatus('VOIDED');
    expect((await offer()).kind).toBe('no-other-bidder');
  });
});

describe('a voided sale can be relisted once', () => {
  it('relisting records relistedFromId on the new listing', async () => {
    await setStatus('VOIDED');

    const result = await relist();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const created = await prisma.listing.findUniqueOrThrow({ where: { id: result.listingId } });
    expect(created.relistedFromId).toBe(await originalListingId());
  });

  it('a voided sale cannot be relisted twice', async () => {
    await setStatus('VOIDED');
    const listingsBefore = await prisma.listing.count();

    expect((await relist()).kind).toBe('ok');
    expect((await relist()).kind).toBe('wrong-state');

    expect(await prisma.listing.count()).toBe(listingsBefore + 1);
    expect(await prisma.listing.count({ where: { relistedFromId: await originalListingId() } })).toBe(1);
  });

  it('concurrent relists create exactly one listing', async () => {
    await setStatus('VOIDED');
    const listingsBefore = await prisma.listing.count();

    const results = await Promise.all([relist(), relist()]);

    expect(results.map((r) => r.kind).sort()).toEqual(['ok', 'wrong-state']);
    expect(await prisma.listing.count()).toBe(listingsBefore + 1);
  });
});

describe('relist survives a listingCode collision', () => {
  it('retries with a fresh code instead of failing the whole relist', async () => {
    await setStatus('VOIDED');
    // The generator's first answer is a code another listing already holds.
    const taken = await prisma.listing.findUniqueOrThrow({ where: { id: await originalListingId() } });
    codes.next.push(taken.listingCode);
    const listingsBefore = await prisma.listing.count();

    const result = await relist();

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const created = await prisma.listing.findUniqueOrThrow({ where: { id: result.listingId } });
    expect(created.listingCode).not.toBe(taken.listingCode);
    expect(await prisma.listing.count()).toBe(listingsBefore + 1);
  });
});

describe('relist and offer exclude each other', () => {
  it('a relisted sale cannot be offered to the next bidder', async () => {
    await bid(w.otherBuyer.id, 7_000);
    await setStatus('VOIDED');

    expect((await relist()).kind).toBe('ok');
    expect((await offer()).kind).toBe('wrong-state');

    const row = await txRow();
    expect(row.status).toBe('VOIDED');
    expect(row.winnerId).toBe(w.buyer.id);
  });

  it('relist and offer racing: exactly one wins', async () => {
    await bid(w.otherBuyer.id, 7_000);
    await setStatus('VOIDED');
    const listingsBefore = await prisma.listing.count();

    const [offered, relisted] = await Promise.all([offer(), relist()]);

    expect([offered.kind, relisted.kind].filter((k) => k === 'ok')).toHaveLength(1);

    // Whichever won, the state is one consistent story, never both at once.
    const row = await txRow();
    const relistCount = (await prisma.listing.count()) - listingsBefore;
    if (offered.kind === 'ok') {
      expect(row.status).toBe('PENDING');
      expect(relistCount).toBe(0);
    } else {
      expect(row.status).toBe('VOIDED');
      expect(relistCount).toBe(1);
    }
  });
});
