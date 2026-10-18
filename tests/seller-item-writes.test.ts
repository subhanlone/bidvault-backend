/**
 * Two facts the seller's My Items read model needs from the write paths:
 *
 *  - paidAt: when the charge succeeded. The platform has no ship-by deadline, so "paid X ago" is
 *    the only urgency signal a seller gets for a sale waiting to be shipped.
 *  - a taken-down listing keeps the admin's reason on the listing itself. It used to live only in
 *    AuditLog, which no seller can read, so a seller saw "Removed" with no explanation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

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
const { offerToNextBidder } = await import('../src/services/auction-control.service.js');
const { APPROVED_TEST_CARD, DECLINED_TEST_CARD } = await import('../src/services/payment-gateway.service.js');

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

const pay = (cardNumber: string) =>
  request(app)
    .post(api(`/payments/${w.transactionId}/pay`))
    .set(auth(w.buyer.token))
    .send({ cardNumber, deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567' });

const txRow = () => prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });

describe('paidAt', () => {
  it('paying a sale sets paidAt', async () => {
    const before = Date.now();

    const res = await pay(APPROVED_TEST_CARD);

    expect(res.status).toBe(200);
    const row = await txRow();
    expect(row.status).toBe('COMPLETED');
    expect(row.paidAt).not.toBeNull();
    expect(row.paidAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.paidAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('a declined card leaves paidAt empty', async () => {
    const res = await pay(DECLINED_TEST_CARD);

    expect(res.status).toBe(200);
    const row = await txRow();
    expect(row.status).toBe('PENDING');
    expect(row.paidAt).toBeNull();
  });

  it('offering to the next bidder resets paidAt along with the rest of the previous buyer\'s payment', async () => {
    await prisma.bid.create({ data: { auctionId: w.closedAuctionId, buyerId: w.otherBuyer.id, amount: 7_000 } });
    // A VOIDED sale is never paid, so this state cannot arise through the app; forcing it checks
    // that the retarget leaves nothing of the old buyer's payment behind (it already resets
    // paymentReference, delivery details and shippedAt the same way).
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'VOIDED', paidAt: new Date() },
    });

    expect((await offerToNextBidder(w.transactionId, w.seller.id)).kind).toBe('ok');

    expect((await txRow()).paidAt).toBeNull();
  });
});

describe('takedown reason', () => {
  it('takedown stores the reason on the listing', async () => {
    const listingId = (await prisma.auction.findUniqueOrThrow({ where: { id: w.liveAuctionId } })).listingId;

    const res = await request(app)
      .post(api(`/admin/listings/${listingId}/takedown`))
      .set(auth(w.admin.token))
      .send({ reason: 'Counterfeit item reported.' });

    expect(res.status).toBe(200);
    const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
    expect(listing.status).toBe('REMOVED');
    expect(listing.rejectionReason).toBe('Counterfeit item reported.');
  });
});
