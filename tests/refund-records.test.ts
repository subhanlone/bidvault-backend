/**
 * Every refund path writes the full refund record (when, RFD- reference, reason, who, note) in the
 * same transaction that sets REFUNDED, so no refunded sale is left unexplained.
 *
 *   seller refund        -> NOT_SHIPPED_SELLER, SELLER, the seller's reason
 *   admin refund         -> NOT_SHIPPED_ADMIN,  ADMIN,  the admin's reason
 *   unanswered report    -> NOT_SHIPPED_AUTO,   SYSTEM, no note
 *   listing takedown     -> LISTING_TAKEN_DOWN, ADMIN,  the admin's reason (the reason text already says it was removed)
 *   dispute upheld       -> DISPUTE_UPHELD,     ADMIN,  the resolution note
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return {
    ...actual,
    sendSaleRefundedEmail: vi.fn(() => Promise.resolve()),
    sendDisputeResolvedEmail: vi.fn(() => Promise.resolve()),
  };
});

const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');
const { refundUnshippedSale, refundUnansweredReport, resolveDispute, NOT_SHIPPED_RESPONSE_DAYS } =
  await import('../src/services/fulfillment.service.js');
const { takedownListing } = await import('../src/services/auction-control.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;
let w: World;

const DAY_MS = 24 * 60 * 60 * 1000;
const reload = () => prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });

/** The seeded PENDING sale, paid by card (COMPLETED, not shipped). */
async function markPaid(extra: Record<string, unknown> = {}) {
  const paidAt = new Date();
  await prisma.auctionTransaction.update({
    where: { id: w.transactionId },
    data: {
      status: 'COMPLETED', paidAt, paymentReference: `PAY-test-${Date.now()}`, paymentMethod: 'CARD',
      paymentAccountHint: 'Visa •••4242', deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567',
      ...extra,
    },
  });
}

function expectRecord(
  row: Awaited<ReturnType<typeof reload>>,
  reason: string,
  by: string,
  note: string | null,
) {
  expect(row).toMatchObject({ status: 'REFUNDED', refundReason: reason, refundedBy: by });
  expect(row.refundedAt).toBeInstanceOf(Date);
  expect(row.refundReference).toMatch(/^RFD-[A-Za-z0-9_-]{12}$/);
  expect(row.refundNote).toBe(note); // null only for NOT_SHIPPED_AUTO
}

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  w = await seedWorld();
  vi.clearAllMocks();
});
afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('every refund path writes the full refund record', () => {
  it('the seller refunds an item they cannot send', async () => {
    await markPaid();
    const r = await refundUnshippedSale(w.transactionId, { by: 'seller', userId: w.seller.id, reason: 'Item broke in storage' });
    expect(r.kind).toBe('ok');
    expectRecord(await reload(), 'NOT_SHIPPED_SELLER', 'SELLER', 'Item broke in storage');
  });

  it('an admin refunds a sale that was not shipped', async () => {
    await markPaid();
    const r = await refundUnshippedSale(w.transactionId, { by: 'admin', userId: w.admin.id, reason: 'Seller unreachable' });
    expect(r.kind).toBe('ok');
    expectRecord(await reload(), 'NOT_SHIPPED_ADMIN', 'ADMIN', 'Seller unreachable');
  });

  it('the worker refunds an unanswered not-shipped report', async () => {
    await markPaid({
      notShippedReportedAt: new Date(Date.now() - (NOT_SHIPPED_RESPONSE_DAYS + 1) * DAY_MS),
      notShippedNote: 'Nothing arrived',
    });
    const r = await refundUnansweredReport(w.transactionId);
    expect(r.kind).toBe('ok');
    expectRecord(await reload(), 'NOT_SHIPPED_AUTO', 'SYSTEM', null);
  });

  it('an admin takes the listing down after it was paid', async () => {
    await markPaid();
    const { listingId } = await prisma.auction.findUniqueOrThrow({ where: { id: w.closedAuctionId }, select: { listingId: true } });
    const r = await takedownListing(listingId, w.admin.id, 'Counterfeit item');
    expect(r.kind).toBe('ok');
    expectRecord(await reload(), 'LISTING_TAKEN_DOWN', 'ADMIN', 'Counterfeit item');
  });

  it('an admin upholds the buyer\'s dispute', async () => {
    await markPaid({ status: 'DISPUTED', shippedAt: new Date() });
    const dispute = await prisma.dispute.create({
      data: { transactionId: w.transactionId, raisedByUserId: w.buyer.id, reason: 'Arrived broken, not as described' },
    });
    const r = await resolveDispute(dispute.id, w.admin.id, 'REFUND', 'Photos show the damage');
    expect(r.kind).toBe('ok');
    expectRecord(await reload(), 'DISPUTE_UPHELD', 'ADMIN', 'Photos show the damage');
  });
});

describe('refund notifications explain the refund in full', () => {
  const noticesOf = (userId: string) =>
    prisma.notification.findMany({ where: { userId, type: { in: ['SALE_REFUNDED', 'DISPUTE_RESOLVED'] } }, orderBy: { createdAt: 'desc' } });

  it('a JazzCash sale refunded by the seller tells the buyer where the money went, why and the references', async () => {
    await markPaid({ paymentMethod: 'JAZZCASH', paymentAccountHint: '0300•••567' });
    await refundUnshippedSale(w.transactionId, { by: 'seller', userId: w.seller.id, reason: 'Item broke in storage' });

    const [notice] = await noticesOf(w.buyer.id);
    expect(notice?.message).toContain('PKR');
    expect(notice?.message).toContain('JazzCash 0300•••567');
    expect(notice?.message).toContain('The seller could not send the item');
    expect(notice?.message).toContain('Item broke in storage');
    expect(notice?.message).toContain('RFD-');
    expect(notice?.message).toContain('PAY-');
    expect(notice?.message).toContain('Immediately (simulated: no real money moves)');
    expect(notice?.message).toContain('Back to: JazzCash 0300•••567.');
  });

  it('a refund of a sale paid before methods existed says it went back to the card, in plain words', async () => {
    await markPaid({ paymentMethod: null, paymentAccountHint: null });
    await refundUnshippedSale(w.transactionId, { by: 'admin', userId: w.admin.id, reason: 'Seller unreachable' });
    const [notice] = await noticesOf(w.buyer.id);
    expect(notice?.message).toContain('Back to: Card.');
    expect(notice?.message).not.toContain('to your');
  });

  it('an admin refund tells the seller why, who and when, but not the buyer\'s account', async () => {
    await markPaid({ paymentMethod: 'EASYPAISA', paymentAccountHint: '0345•••567' });
    await refundUnshippedSale(w.transactionId, { by: 'admin', userId: w.admin.id, reason: 'Seller unreachable' });

    const [notice] = await noticesOf(w.seller.id);
    expect(notice?.message).toContain('The item was not sent, so BidVault refunded the buyer');
    expect(notice?.message).toContain('Seller unreachable');
    expect(notice?.message).toContain('Decided by BidVault');
    expect(notice?.message).toContain('No payout will be made');
    expect(notice?.message).not.toContain('•••');
  });

  it('a bank-transfer sale refunded through a dispute: the buyer is told the transfer, the seller never is', async () => {
    await markPaid({ status: 'DISPUTED', shippedAt: new Date(), paymentMethod: 'BANK_TRANSFER', paymentAccountHint: null, bankTransferReference: 'FT2611110001' });
    const dispute = await prisma.dispute.create({
      data: { transactionId: w.transactionId, raisedByUserId: w.buyer.id, reason: 'Arrived broken, not as described' },
    });
    await resolveDispute(dispute.id, w.admin.id, 'REFUND', 'Photos show the damage');

    const [buyerNotice] = await noticesOf(w.buyer.id);
    expect(buyerNotice?.message).toContain('Bank transfer (ref FT2611110001)');
    expect(buyerNotice?.message).toContain('Your dispute was decided in your favour');
    const [sellerNotice] = await noticesOf(w.seller.id);
    expect(sellerNotice?.message).not.toContain('FT2611110001');
    expect(sellerNotice?.message).not.toContain('•••');
    expect(sellerNotice?.message).toContain("The buyer's dispute was decided in their favour");
  });
});
