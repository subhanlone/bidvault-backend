/**
 * BV-047 — the post-payment half of a sale, absent entirely before this
 * (LIFECYCLE-GAPS.md A4/C5/E6). Exercises fulfillment.service.ts directly rather than through
 * HTTP, the same way close-auction.test.ts tests closeAuction() directly: every state
 * transition lives there, and routes.conformance.test.ts / authz.test.ts already cover that
 * the HTTP layer wires it up and gates it by role/ownership.
 *
 * No Stripe (or any other) mock here: the payout is a local ledger write inside the same
 * transaction as the state change, not a network call, so there is nothing to intercept.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Nothing here should reach Resend.
vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return {
    ...actual,
    sendItemShippedEmail: vi.fn(async () => undefined),
    sendDeliveryConfirmedEmail: vi.fn(async () => undefined),
    sendDisputeRaisedEmail: vi.fn(async () => undefined),
    sendDisputeResolvedEmail: vi.fn(async () => undefined),
  };
});

const {
  markShipped,
  confirmDelivery,
  raiseDispute,
  resolveDispute,
  findTimedOutShipments,
} = await import('../src/services/fulfillment.service.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');

type World = Awaited<ReturnType<typeof seedWorld>>;
let w: World;

const reload = (id: string) => prisma.auctionTransaction.findUniqueOrThrow({ where: { id } });
const ledgerBalance = async (sellerId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: sellerId }, select: { ledgerBalance: true } })).ledgerBalance;

/** Every precondition markShipped/confirmDelivery need, so each test states only what it varies. */
async function readyToShip(transactionId: string) {
  await prisma.auctionTransaction.update({
    where: { id: transactionId },
    data: { status: 'COMPLETED', deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567' },
  });
}

beforeEach(async () => {
  w = await seedWorld();
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

// ---- markShipped ---------------------------------------------------------------------------

describe('markShipped', () => {
  it('moves COMPLETED to SHIPPED and stamps shippedAt', async () => {
    await readyToShip(w.transactionId);
    const result = await markShipped(w.transactionId, w.seller.id);
    expect(result.kind).toBe('ok');

    const tx = await reload(w.transactionId);
    expect(tx.status).toBe('SHIPPED');
    expect(tx.shippedAt).not.toBeNull();
  });

  it('refuses a transaction that has not been paid yet', async () => {
    // seedWorld's transaction starts PENDING.
    const result = await markShipped(w.transactionId, w.seller.id);
    expect(result.kind).toBe('wrong-state');
    expect((await reload(w.transactionId)).status).toBe('PENDING');
  });

  it('refuses without a delivery address on file', async () => {
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'COMPLETED' } });
    const result = await markShipped(w.transactionId, w.seller.id);
    expect(result.kind).toBe('no-address');
  });

  it('refuses a seller who does not own the transaction', async () => {
    await readyToShip(w.transactionId);
    const result = await markShipped(w.transactionId, w.otherSeller.id);
    expect(result.kind).toBe('forbidden');
    expect((await reload(w.transactionId)).status).toBe('COMPLETED');
  });
});

// ---- confirmDelivery -> payout --------------------------------------------------------------

describe('confirmDelivery', () => {
  async function shipped() {
    await readyToShip(w.transactionId);
    await markShipped(w.transactionId, w.seller.id);
  }

  it('moves SHIPPED to DELIVERED and credits the seller\'s ledger for the full amount', async () => {
    await shipped();
    const before = await ledgerBalance(w.seller.id);

    const result = await confirmDelivery(w.transactionId, { requireWinnerId: w.buyer.id });
    expect(result.kind).toBe('ok');
    expect((await reload(w.transactionId)).status).toBe('DELIVERED');

    // seedWorld's transaction is PKR 8,000.
    expect(await ledgerBalance(w.seller.id)).toBe(before + 8_000);

    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { transactionId: w.transactionId } });
    expect(entry.sellerId).toBe(w.seller.id);
    expect(entry.amount).toBe(8_000);
  });

  it('refuses a buyer who did not win the transaction', async () => {
    await shipped();
    const before = await ledgerBalance(w.seller.id);
    const result = await confirmDelivery(w.transactionId, { requireWinnerId: w.otherBuyer.id });
    expect(result.kind).toBe('forbidden');
    expect(await ledgerBalance(w.seller.id)).toBe(before);
  });

  it('refuses a transaction that has not shipped', async () => {
    const result = await confirmDelivery(w.transactionId, { requireWinnerId: w.buyer.id });
    expect(result.kind).toBe('wrong-state');
  });

  it('releases a DISPUTED transaction only when fromDisputed is set', async () => {
    await shipped();
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'DISPUTED' } });

    const withoutFlag = await confirmDelivery(w.transactionId);
    expect(withoutFlag.kind).toBe('wrong-state');

    const withFlag = await confirmDelivery(w.transactionId, { fromDisputed: true });
    expect(withFlag.kind).toBe('ok');
    expect((await reload(w.transactionId)).status).toBe('DELIVERED');
  });
});

// ---- raiseDispute -----------------------------------------------------------------------

describe('raiseDispute', () => {
  async function shipped() {
    await readyToShip(w.transactionId);
    await markShipped(w.transactionId, w.seller.id);
  }

  it('moves SHIPPED to DISPUTED and records the reason', async () => {
    await shipped();
    const result = await raiseDispute(w.transactionId, w.buyer.id, 'The item never arrived.');
    expect(result.kind).toBe('ok');
    expect((await reload(w.transactionId)).status).toBe('DISPUTED');

    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { transactionId: w.transactionId } });
    expect(dispute.status).toBe('OPEN');
    expect(dispute.reason).toBe('The item never arrived.');
    expect(dispute.raisedByUserId).toBe(w.buyer.id);
  });

  it('refuses a buyer who did not win the transaction', async () => {
    await shipped();
    const result = await raiseDispute(w.transactionId, w.otherBuyer.id, 'Not my purchase.');
    expect(result.kind).toBe('forbidden');
    expect(await prisma.dispute.findUnique({ where: { transactionId: w.transactionId } })).toBeNull();
  });

  it('refuses a transaction that has not shipped', async () => {
    const result = await raiseDispute(w.transactionId, w.buyer.id, 'Too early to dispute.');
    expect(result.kind).toBe('wrong-state');
  });
});

// ---- resolveDispute (admin) --------------------------------------------------------------

describe('resolveDispute', () => {
  async function disputed() {
    await readyToShip(w.transactionId);
    await markShipped(w.transactionId, w.seller.id);
    await raiseDispute(w.transactionId, w.buyer.id, 'Arrived damaged.');
    return prisma.dispute.findUniqueOrThrow({ where: { transactionId: w.transactionId } });
  }

  it('REFUND: a pure status flip, no ledger entry ever created', async () => {
    const dispute = await disputed();
    const before = await ledgerBalance(w.seller.id);

    const result = await resolveDispute(dispute.id, w.admin.id, 'REFUND', 'Buyer provided photos of damage.');
    expect(result.kind).toBe('ok');

    expect((await reload(w.transactionId)).status).toBe('REFUNDED');
    expect(await ledgerBalance(w.seller.id)).toBe(before);
    expect(await prisma.ledgerEntry.findUnique({ where: { transactionId: w.transactionId } })).toBeNull();

    const resolved = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(resolved.status).toBe('RESOLVED_REFUNDED');
    expect(resolved.resolvedByUserId).toBe(w.admin.id);
  });

  it('RELEASE: delivers the transaction and credits the seller\'s ledger, no refund', async () => {
    const dispute = await disputed();
    const before = await ledgerBalance(w.seller.id);

    const result = await resolveDispute(dispute.id, w.admin.id, 'RELEASE', 'Seller showed proof of delivery.');
    expect(result.kind).toBe('ok');

    expect((await reload(w.transactionId)).status).toBe('DELIVERED');
    expect(await ledgerBalance(w.seller.id)).toBe(before + 8_000);

    const resolved = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(resolved.status).toBe('RESOLVED_RELEASED');
  });

  it('cannot be resolved twice', async () => {
    const dispute = await disputed();
    await resolveDispute(dispute.id, w.admin.id, 'REFUND', 'First resolution.');
    const before = await ledgerBalance(w.seller.id);

    const second = await resolveDispute(dispute.id, w.admin.id, 'RELEASE', 'Second attempt.');
    expect(second.kind).toBe('not-open');
    // Still refunded from the first call, not flipped to delivered by the second.
    expect((await reload(w.transactionId)).status).toBe('REFUNDED');
    expect(await ledgerBalance(w.seller.id)).toBe(before);
  });

  it('answers not-found for an unknown dispute id', async () => {
    const result = await resolveDispute('does-not-exist', w.admin.id, 'REFUND', 'n/a');
    expect(result.kind).toBe('not-found');
  });
});

// ---- Timeout sweep (BV-040) -----------------------------------------------------------------

describe('findTimedOutShipments', () => {
  it('finds a SHIPPED transaction whose window has elapsed', async () => {
    await readyToShip(w.transactionId);
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      // Default reviewTimeoutHours is 48 (no PlatformSetting row seeded); 49 hours ago is
      // safely past it.
      data: { status: 'SHIPPED', shippedAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });

    const overdue = await findTimedOutShipments();
    expect(overdue).toContain(w.transactionId);
  });

  it('does not find one still inside its window', async () => {
    await readyToShip(w.transactionId);
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'SHIPPED', shippedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const overdue = await findTimedOutShipments();
    expect(overdue).not.toContain(w.transactionId);
  });

  it('does not find a DISPUTED transaction even if its window has elapsed', async () => {
    await readyToShip(w.transactionId);
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'DISPUTED', shippedAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });

    const overdue = await findTimedOutShipments();
    expect(overdue).not.toContain(w.transactionId);
  });
});
