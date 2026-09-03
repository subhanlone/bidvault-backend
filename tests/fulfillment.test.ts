/**
 * BV-047 — the post-payment half of a sale, absent entirely before this
 * (LIFECYCLE-GAPS.md A4/C5/E6). Exercises fulfillment.service.ts directly rather than through
 * HTTP, the same way close-auction.test.ts tests closeAuction() directly: every state
 * transition and every Stripe call lives there, and routes.conformance.test.ts / authz.test.ts
 * already cover that the HTTP layer wires it up and gates it by role/ownership.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call { params: Record<string, unknown> }
const transferCalls: Call[] = [];
const refundCalls: Call[] = [];
const accountCreateCalls: Call[] = [];
let accountStatus = { charges_enabled: true, payouts_enabled: true };
let transferShouldThrow: Error | null = null;
let accountRetrieveShouldThrow: Error | null = null;

vi.mock('../src/services/stripe.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/stripe.service.js')>(
    '../src/services/stripe.service.js',
  );
  return {
    ...actual,
    stripe: {
      transfers: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          transferCalls.push({ params });
          if (transferShouldThrow) throw transferShouldThrow;
          return { id: `tr_test_${transferCalls.length}` };
        }),
      },
      refunds: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          refundCalls.push({ params });
          return { id: `re_test_${refundCalls.length}` };
        }),
      },
      accounts: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          accountCreateCalls.push({ params });
          return { id: `acct_test_${accountCreateCalls.length}` };
        }),
        retrieve: vi.fn(async (id: string) => {
          if (accountRetrieveShouldThrow) throw accountRetrieveShouldThrow;
          return { id, ...accountStatus };
        }),
      },
      accountLinks: {
        create: vi.fn(async () => ({ url: 'https://connect.stripe.com/setup/test' })),
      },
    },
  };
});

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
  createConnectOnboardingLink,
  getConnectAccountStatus,
  findTimedOutShipments,
} = await import('../src/services/fulfillment.service.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');

type World = Awaited<ReturnType<typeof seedWorld>>;
let w: World;

const reload = (id: string) => prisma.auctionTransaction.findUniqueOrThrow({ where: { id } });

/** Every precondition markShipped/confirmDelivery need, so each test states only what it varies. */
async function readyToShip(transactionId: string, sellerId: string) {
  await prisma.auctionTransaction.update({
    where: { id: transactionId },
    data: { status: 'COMPLETED', deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567' },
  });
  await prisma.user.update({
    where: { id: sellerId },
    data: { stripeAccountId: 'acct_test_seller', stripeOnboardingComplete: true },
  });
}

beforeEach(async () => {
  w = await seedWorld();
  transferCalls.length = 0;
  refundCalls.length = 0;
  accountCreateCalls.length = 0;
  accountStatus = { charges_enabled: true, payouts_enabled: true };
  transferShouldThrow = null;
  accountRetrieveShouldThrow = null;
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

// ---- markShipped ---------------------------------------------------------------------------

describe('markShipped', () => {
  it('moves COMPLETED to SHIPPED and stamps shippedAt', async () => {
    await readyToShip(w.transactionId, w.seller.id);
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
    await prisma.user.update({ where: { id: w.seller.id }, data: { stripeOnboardingComplete: true } });
    const result = await markShipped(w.transactionId, w.seller.id);
    expect(result.kind).toBe('no-address');
  });

  it('refuses until the seller has completed payout onboarding', async () => {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'COMPLETED', deliveryAddress: '123 Test Street', deliveryPhone: '03001234567' },
    });
    const result = await markShipped(w.transactionId, w.seller.id);
    expect(result.kind).toBe('payout-not-ready');
  });

  it('refuses a seller who does not own the transaction', async () => {
    await readyToShip(w.transactionId, w.seller.id);
    const result = await markShipped(w.transactionId, w.otherSeller.id);
    expect(result.kind).toBe('forbidden');
    expect((await reload(w.transactionId)).status).toBe('COMPLETED');
  });
});

// ---- confirmDelivery -> payout --------------------------------------------------------------

describe('confirmDelivery', () => {
  async function shipped() {
    await readyToShip(w.transactionId, w.seller.id);
    await markShipped(w.transactionId, w.seller.id);
  }

  it('moves SHIPPED to DELIVERED and transfers the full amount to the seller', async () => {
    await shipped();
    const result = await confirmDelivery(w.transactionId, { requireWinnerId: w.buyer.id });
    expect(result.kind).toBe('ok');
    expect((await reload(w.transactionId)).status).toBe('DELIVERED');

    // seedWorld's transaction is PKR 8,000 -- 800,000 minor units, same conversion BV-001 fixed
    // on the charge side.
    expect(transferCalls).toHaveLength(1);
    expect(transferCalls[0].params).toMatchObject({
      amount: 800_000,
      currency: 'pkr',
      destination: 'acct_test_seller',
    });
  });

  it('refuses a buyer who did not win the transaction', async () => {
    await shipped();
    const result = await confirmDelivery(w.transactionId, { requireWinnerId: w.otherBuyer.id });
    expect(result.kind).toBe('forbidden');
    expect(transferCalls).toHaveLength(0);
  });

  it('refuses a transaction that has not shipped', async () => {
    const result = await confirmDelivery(w.transactionId, { requireWinnerId: w.buyer.id });
    expect(result.kind).toBe('wrong-state');
    expect(transferCalls).toHaveLength(0);
  });

  it('still marks DELIVERED even when the transfer itself fails', async () => {
    await shipped();
    transferShouldThrow = new Error('stripe is down');
    const result = await confirmDelivery(w.transactionId, { requireWinnerId: w.buyer.id });
    // The buyer-facing fact (item received) does not depend on Stripe's side succeeding --
    // documented in fulfillment.service.ts as a known gap needing a human, not a silent retry.
    expect(result.kind).toBe('ok');
    expect((await reload(w.transactionId)).status).toBe('DELIVERED');
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
    await readyToShip(w.transactionId, w.seller.id);
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
    await readyToShip(w.transactionId, w.seller.id);
    await markShipped(w.transactionId, w.seller.id);
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { stripePaymentIntentId: 'pi_test_disputed' },
    });
    await raiseDispute(w.transactionId, w.buyer.id, 'Arrived damaged.');
    return prisma.dispute.findUniqueOrThrow({ where: { transactionId: w.transactionId } });
  }

  it('REFUND: refunds the charge and never transfers to the seller', async () => {
    const dispute = await disputed();
    const result = await resolveDispute(dispute.id, w.admin.id, 'REFUND', 'Buyer provided photos of damage.');
    expect(result.kind).toBe('ok');

    expect((await reload(w.transactionId)).status).toBe('REFUNDED');
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].params).toMatchObject({ payment_intent: 'pi_test_disputed' });
    expect(transferCalls).toHaveLength(0);

    const resolved = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(resolved.status).toBe('RESOLVED_REFUNDED');
    expect(resolved.resolvedByUserId).toBe(w.admin.id);
  });

  it('RELEASE: delivers the transaction and transfers to the seller, no refund', async () => {
    const dispute = await disputed();
    const result = await resolveDispute(dispute.id, w.admin.id, 'RELEASE', 'Seller showed proof of delivery.');
    expect(result.kind).toBe('ok');

    expect((await reload(w.transactionId)).status).toBe('DELIVERED');
    expect(transferCalls).toHaveLength(1);
    expect(refundCalls).toHaveLength(0);

    const resolved = await prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    expect(resolved.status).toBe('RESOLVED_RELEASED');
  });

  it('cannot be resolved twice', async () => {
    const dispute = await disputed();
    await resolveDispute(dispute.id, w.admin.id, 'REFUND', 'First resolution.');

    const second = await resolveDispute(dispute.id, w.admin.id, 'RELEASE', 'Second attempt.');
    expect(second.kind).toBe('not-open');
    // Still refunded from the first call, not flipped to delivered by the second.
    expect((await reload(w.transactionId)).status).toBe('REFUNDED');
    expect(transferCalls).toHaveLength(0);
  });

  it('answers not-found for an unknown dispute id', async () => {
    const result = await resolveDispute('does-not-exist', w.admin.id, 'REFUND', 'n/a');
    expect(result.kind).toBe('not-found');
  });
});

// ---- Connect onboarding (C5) --------------------------------------------------------------

describe('createConnectOnboardingLink', () => {
  it('creates a Stripe Express account on first use and stores it', async () => {
    const { url } = await createConnectOnboardingLink(w.seller.id);
    expect(url).toContain('https://connect.stripe.com');
    expect(accountCreateCalls).toHaveLength(1);

    const seller = await prisma.user.findUniqueOrThrow({ where: { id: w.seller.id } });
    expect(seller.stripeAccountId).toBe('acct_test_1');
  });

  it('reuses the existing account rather than creating a second one', async () => {
    await prisma.user.update({ where: { id: w.seller.id }, data: { stripeAccountId: 'acct_existing' } });
    await createConnectOnboardingLink(w.seller.id);
    expect(accountCreateCalls).toHaveLength(0);
  });
});

describe('getConnectAccountStatus', () => {
  it('reports not connected when the seller has no Stripe account yet', async () => {
    const status = await getConnectAccountStatus(w.seller.id);
    expect(status).toEqual({ connected: false, onboardingComplete: false });
  });

  it('does not throw when Stripe cannot resolve a stored account id', async () => {
    // A real gap found via manual browser testing: a stored id Stripe can no longer resolve
    // (revoked access, deleted on Stripe's side) must not 500 a route read on every visit to
    // Seller Profile / My Sales.
    await prisma.user.update({ where: { id: w.seller.id }, data: { stripeAccountId: 'acct_gone' } });
    accountRetrieveShouldThrow = new Error("does not have access to account 'acct_gone'");

    const status = await getConnectAccountStatus(w.seller.id);
    expect(status).toEqual({ connected: true, onboardingComplete: false });
  });

  it('reflects Stripe\'s charges_enabled/payouts_enabled and caches it on the row', async () => {
    await prisma.user.update({ where: { id: w.seller.id }, data: { stripeAccountId: 'acct_existing' } });
    accountStatus = { charges_enabled: true, payouts_enabled: true };

    const status = await getConnectAccountStatus(w.seller.id);
    expect(status).toEqual({ connected: true, onboardingComplete: true });

    const seller = await prisma.user.findUniqueOrThrow({ where: { id: w.seller.id } });
    expect(seller.stripeOnboardingComplete).toBe(true);
  });

  it('is not complete while either capability is still pending', async () => {
    await prisma.user.update({ where: { id: w.seller.id }, data: { stripeAccountId: 'acct_existing' } });
    accountStatus = { charges_enabled: true, payouts_enabled: false };

    const status = await getConnectAccountStatus(w.seller.id);
    expect(status.onboardingComplete).toBe(false);
  });
});

// ---- Timeout sweep (BV-040) -----------------------------------------------------------------

describe('findTimedOutShipments', () => {
  it('finds a SHIPPED transaction whose window has elapsed', async () => {
    await readyToShip(w.transactionId, w.seller.id);
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
    await readyToShip(w.transactionId, w.seller.id);
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'SHIPPED', shippedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const overdue = await findTimedOutShipments();
    expect(overdue).not.toContain(w.transactionId);
  });

  it('does not find a DISPUTED transaction even if its window has elapsed', async () => {
    await readyToShip(w.transactionId, w.seller.id);
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'DISPUTED', shippedAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });

    const overdue = await findTimedOutShipments();
    expect(overdue).not.toContain(w.transactionId);
  });
});
