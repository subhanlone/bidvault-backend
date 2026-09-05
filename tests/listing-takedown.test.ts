/**
 * Phase 7 (LIFECYCLE-IMPLEMENTATION-PLAN.md): C3 — approval was previously one-way. An admin can
 * now remove an APPROVED listing for cause, cancelling its live auction (if any) the same way
 * POST /admin/auctions/{id}/cancel does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'socket.io';

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
const { takedownListing } = await import('../src/services/auction-control.service.js');

/** Same minimal shape cancelAuction needs -- see auction-cancellation.test.ts. */
function mockIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to } as unknown as Server, to, emit };
}

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

describe('admin takedown', () => {
  it('removes an approved listing and cancels its live auction, notifying the bidder', async () => {
    // w.liveAuctionId's listing is APPROVED with an ACTIVE auction carrying one bid (world.ts).
    const listingId = (await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } })).listingId;

    const res = await request(app)
      .post(api(`/admin/listings/${listingId}/takedown`))
      .set(auth(w.admin.token))
      .send({ reason: 'Counterfeit item reported.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REMOVED');

    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('REMOVED');

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } });
    expect(auction.status).toBe('CANCELLED');

    const notifications = await prisma.notification.findMany({ where: { type: 'LISTING_REMOVED' } });
    expect(notifications.some((n) => n.userId === w.seller.id)).toBe(true);
    const cancelNotifications = await prisma.notification.findMany({ where: { type: 'AUCTION_CANCELLED' } });
    expect(cancelNotifications.some((n) => n.userId === w.buyer.id)).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(mail.send).toHaveBeenCalled();
  });

  it('leaves an already-closed auction untouched (history preserved)', async () => {
    const listingId = (await prisma.auction.findUniqueOrThrow({ where: { id: w.closedAuctionId } })).listingId;

    const res = await request(app)
      .post(api(`/admin/listings/${listingId}/takedown`))
      .set(auth(w.admin.token))
      .send({ reason: 'Retroactive review.' });
    expect(res.status).toBe(200);

    const auction = await prisma.auction.findUniqueOrThrow({ where: { id: w.closedAuctionId } });
    expect(auction.status).toBe('CLOSED');
  });

  it('refuses to take down a listing that is not APPROVED', async () => {
    const res = await request(app)
      .post(api(`/admin/listings/${w.pendingListingId}/takedown`))
      .set(auth(w.admin.token))
      .send({ reason: 'Testing.' });
    expect(res.status).toBe(409);
  });

  it('a non-admin cannot take down a listing', async () => {
    const listingId = (await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } })).listingId;
    const res = await request(app)
      .post(api(`/admin/listings/${listingId}/takedown`))
      .set(auth(w.seller.token))
      .send({ reason: 'Trying anyway.' });
    expect(res.status).toBe(403);
  });

  // The HTTP route above doesn't set `io` on the test app, so it can't observe the socket side
  // of cancelAuction()'s fix (see auction-cancellation.test.ts) -- calling takedownListing()
  // directly with a mock Server confirms it forwards io through to the cancel it triggers.
  it('forwards io through to the underlying cancelAuction(), which emits auction:cancelled', async () => {
    const listingId = (await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } })).listingId;
    const { io, to, emit } = mockIo();

    const result = await takedownListing(listingId, w.admin.id, 'Counterfeit item reported.', io);

    expect(result.kind).toBe('ok');
    expect(to).toHaveBeenCalledWith(`auction:${w.liveAuctionId}`);
    expect(emit).toHaveBeenCalledWith('auction:cancelled', expect.objectContaining({ auctionId: w.liveAuctionId }));
  });
});
