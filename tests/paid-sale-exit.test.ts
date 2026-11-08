/**
 * A paid sale the seller never ships (FR-02 in docs/FULL-REVIEW-2026-11-08.md; design in
 * docs/FR-02-PAID-SALE-EXIT-DESIGN.md). Before this a COMPLETED sale could only move on when the
 * seller marked it shipped: there was no ship-by deadline, a dispute needed SHIPPED, an admin could
 * void only an unpaid sale, and a takedown left a paid sale alone. A seller who vanished kept the
 * buyer's money waiting for ever.
 *
 * Modelled on eBay's handling time and its "item not received" request (docs/EBAY-HELP-RESEARCH.md
 * section 4): the sale gets a ship-by time at payment; once it passes the buyer can report it not
 * shipped; the seller then has 3 days to ship or refund, after which the buyer is refunded
 * automatically. The seller may refund at any time before shipping, an admin may refund any paid,
 * unshipped sale, and a takedown refunds one.
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
const { APPROVED_TEST_CARD } = await import('../src/services/payment-gateway.service.js');
const { updatePlatformSettings, invalidateSettingsCache } = await import('../src/services/settings.service.js');
const { markShipped, findUnansweredNotShippedReports, refundUnansweredReport, NOT_SHIPPED_RESPONSE_DAYS } =
  await import('../src/services/fulfillment.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

let w: World;

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
});

afterEach(() => {
  // Every response these tests receive must match the published contract.
  expect(takeViolations()).toEqual([]);
  vi.restoreAllMocks();
});

afterAll(async () => {
  invalidateSettingsCache();
  await prisma.$disconnect();
  redisConnection.disconnect();
});

const sale = () => prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
const audits = (action: string) =>
  prisma.auditLog.findMany({ where: { action, entityType: 'AuctionTransaction', entityId: w.transactionId } });

/** The seeded sale, paid `paidAgo` ago with the default 72-hour deadline measured from then. */
async function paid(paidAgo = HOUR, extra: Prisma.AuctionTransactionUpdateInput = {}) {
  const paidAt = ago(paidAgo);
  await prisma.auctionTransaction.update({
    where: { id: w.transactionId },
    data: {
      status: 'COMPLETED',
      deliveryAddress: '123 Test Street, Karachi',
      deliveryPhone: '03001234567',
      paymentReference: `PAY-${w.transactionId}`,
      paidAt,
      shipByAt: new Date(paidAt.getTime() + 72 * HOUR),
      ...extra,
    },
  });
}

/** Paid long enough ago that the ship-by time has passed. */
const overdue = (extra: Prisma.AuctionTransactionUpdateInput = {}) => paid(80 * HOUR, extra);

const pay = () =>
  request(app)
    .post(api(`/payments/${w.transactionId}/pay`))
    .set(bearer(w.buyer.token))
    .send({ cardNumber: APPROVED_TEST_CARD, deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567' });
const report = (token = w.buyer.token) =>
  request(app).post(api(`/payments/${w.transactionId}/report-not-shipped`)).set(bearer(token)).send({ note: 'Nothing yet.' });
const sellerRefund = (token = w.seller.token) =>
  request(app).post(api(`/payments/${w.transactionId}/refund`)).set(bearer(token)).send({ reason: 'Broken before posting.' });
const adminRefund = (id = w.transactionId, token = w.admin.token) =>
  request(app).post(api(`/admin/transactions/${id}/refund`)).set(bearer(token)).send({ reason: 'Seller unreachable.' });

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

// ---- the ship-by deadline -------------------------------------------------------------------

describe('the ship-by deadline', () => {
  it('is set when the buyer pays: the payment time plus shipByHours (72 by default)', async () => {
    const res = await pay();
    expect(res.status).toBe(200);

    const row = await sale();
    expect(row.paidAt).not.toBeNull();
    expect(row.shipByAt!.getTime() - row.paidAt!.getTime()).toBe(72 * HOUR);
  });

  it('follows the admin setting, which the public settings quote to buyers', async () => {
    await updatePlatformSettings({ shipByHours: 24 });

    await pay();
    const row = await sale();
    expect(row.shipByAt!.getTime() - row.paidAt!.getTime()).toBe(24 * HOUR);

    const pub = await request(app).get(api('/settings/public'));
    expect(resData<{ shipByHours: number }>(pub).shipByHours).toBe(24);
  });

  it('is shown to the buyer, on the invoice, and to the seller with a refund action', async () => {
    await paid();
    const { shipByAt } = await sale();

    const wins = await request(app).get(api('/payments/my-wins')).set(bearer(w.buyer.token));
    const won = resData<Array<{ transactionId: string; shipByAt?: string }>>(wins)
      .find((t) => t.transactionId === w.transactionId)!;
    expect(won.shipByAt).toBe(shipByAt!.toISOString());

    const invoice = await request(app).get(api(`/payments/${w.transactionId}/invoice`)).set(bearer(w.buyer.token));
    expect(resData<{ shipByAt?: string }>(invoice).shipByAt).toBe(shipByAt!.toISOString());

    const items = await request(app).get(api('/seller/items?tab=action')).set(bearer(w.seller.token));
    const item = resData<{ items: Array<{ actions: string[]; sale?: { transactionId: string; shipByAt?: string } }> }>(items)
      .items.find((i) => i.sale?.transactionId === w.transactionId)!;
    expect(item.sale!.shipByAt).toBe(shipByAt!.toISOString());
    expect(item.actions).toEqual(['MARK_SHIPPED', 'REFUND_BUYER', 'VIEW_INVOICE']);
  });

  it('is worked out from the payment time for a sale paid before the column existed', async () => {
    await paid(HOUR, { shipByAt: null });
    const { paidAt } = await sale();

    const wins = await request(app).get(api('/payments/my-wins')).set(bearer(w.buyer.token));
    const won = resData<Array<{ transactionId: string; shipByAt?: string }>>(wins)
      .find((t) => t.transactionId === w.transactionId)!;
    expect(won.shipByAt).toBe(new Date(paidAt!.getTime() + 72 * HOUR).toISOString());
  });
});

// ---- the buyer reports it not shipped --------------------------------------------------------

describe('reporting a paid sale not shipped', () => {
  it('is refused while the ship-by time has not passed', async () => {
    await paid();
    const res = await report();
    expect(res.status).toBe(409);
    expect((await sale()).notShippedReportedAt).toBeNull();
  });

  it('after the ship-by time records the report, keeps the sale paid, and tells the seller', async () => {
    await overdue();
    const res = await report();
    expect(res.status).toBe(200);

    const row = await sale();
    expect(row.status).toBe('COMPLETED');
    expect(row.notShippedReportedAt).not.toBeNull();
    const data = resData<{ notShippedReportedAt: string; autoRefundAt: string }>(res);
    expect(new Date(data.autoRefundAt).getTime() - new Date(data.notShippedReportedAt).getTime())
      .toBe(NOT_SHIPPED_RESPONSE_DAYS * DAY);

    const notice = await prisma.notification.findFirst({ where: { userId: w.seller.id, type: 'NOT_SHIPPED_REPORTED' } });
    expect(notice).not.toBeNull();
  });

  it('is refused for someone else\'s purchase, a second time, and once the item has shipped', async () => {
    await overdue();
    expect((await report(w.otherBuyer.token)).status).toBe(403);

    expect((await report()).status).toBe(200);
    expect((await report()).status).toBe(409);

    await markShipped(w.transactionId, w.seller.id);
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { notShippedReportedAt: null } });
    expect((await report()).status).toBe(409);
  });

  it('can still be answered by shipping, which leaves the normal confirm-or-dispute window', async () => {
    await overdue();
    await report();

    expect((await markShipped(w.transactionId, w.seller.id)).kind).toBe('ok');
    expect((await sale()).status).toBe('SHIPPED');
    expect(await findUnansweredNotShippedReports()).not.toContain(w.transactionId);
  });
});

// ---- the seller refunds ----------------------------------------------------------------------

describe('the seller refunding a paid, unshipped sale', () => {
  it('refunds it without paying anyone, records who did it, and tells the buyer', async () => {
    await paid();
    const res = await sellerRefund();
    expect(res.status).toBe(200);
    expect(resData<{ status: string }>(res).status).toBe('REFUNDED');

    expect((await sale()).status).toBe('REFUNDED');
    expect(await prisma.ledgerEntry.count({ where: { transactionId: w.transactionId } })).toBe(0);
    const [audit] = await audits('TRANSACTION_REFUNDED');
    expect(audit.actorUserId).toBe(w.seller.id);
    expect(audit.metadata).toMatchObject({ by: 'seller', reason: 'Broken before posting.' });
    expect(await prisma.notification.count({ where: { userId: w.buyer.id, type: 'SALE_REFUNDED' } })).toBe(1);
  });

  it('is refused to another seller, before payment, and after shipping', async () => {
    expect((await sellerRefund()).status).toBe(409); // seeded sale is PENDING

    await paid();
    expect((await sellerRefund(w.otherSeller.token)).status).toBe(403);

    await markShipped(w.transactionId, w.seller.id);
    expect((await sellerRefund()).status).toBe(409);
    expect((await sale()).status).toBe('SHIPPED');
  });

  it('that waits for a shipment in progress is refused once the item has shipped', async () => {
    await paid();
    const { waited, result } = await whileHeld(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AuctionTransaction" WHERE id = ${w.transactionId} FOR UPDATE`;
        await tx.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'SHIPPED', shippedAt: new Date() } });
      },
      () => sellerRefund(),
    );
    expect(waited).toBe(true);
    expect(result.status).toBe(409);
    expect((await sale()).status).toBe('SHIPPED');
  });

  it('makes a shipment that waited for it fail, so a refunded item is never sent', async () => {
    await paid();
    const { waited, result } = await whileHeld(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AuctionTransaction" WHERE id = ${w.transactionId} FOR UPDATE`;
        await tx.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'REFUNDED' } });
      },
      () => markShipped(w.transactionId, w.seller.id),
    );
    expect(waited).toBe(true);
    expect(result.kind).toBe('wrong-state');
    expect((await sale()).status).toBe('REFUNDED');
  });
});

// ---- the automatic refund --------------------------------------------------------------------

describe('a report the seller does not answer', () => {
  it('is found once the response window has passed, and not before', async () => {
    await overdue({ notShippedReportedAt: ago(NOT_SHIPPED_RESPONSE_DAYS * DAY - HOUR) });
    expect(await findUnansweredNotShippedReports()).not.toContain(w.transactionId);

    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { notShippedReportedAt: ago(NOT_SHIPPED_RESPONSE_DAYS * DAY + HOUR) },
    });
    expect(await findUnansweredNotShippedReports()).toContain(w.transactionId);
  });

  it('is refunded by the sweep, recorded as the system\'s decision', async () => {
    await overdue({ notShippedReportedAt: ago(NOT_SHIPPED_RESPONSE_DAYS * DAY + HOUR) });

    expect((await refundUnansweredReport(w.transactionId)).kind).toBe('ok');
    expect((await sale()).status).toBe('REFUNDED');
    const [audit] = await audits('TRANSACTION_REFUNDED');
    expect(audit.actorUserId).toBeNull();
    expect(audit.metadata).toMatchObject({ by: 'system' });
    expect(await prisma.notification.count({ where: { userId: w.seller.id, type: 'SALE_REFUNDED' } })).toBe(1);
  });

  it('is left alone by a sweep that arrives after the seller shipped, or inside the window', async () => {
    await overdue({ notShippedReportedAt: ago(NOT_SHIPPED_RESPONSE_DAYS * DAY + HOUR) });
    await markShipped(w.transactionId, w.seller.id);
    expect((await refundUnansweredReport(w.transactionId)).kind).toBe('wrong-state');
    expect((await sale()).status).toBe('SHIPPED');

    w = await seedWorld();
    await overdue({ notShippedReportedAt: ago(HOUR) });
    expect((await refundUnansweredReport(w.transactionId)).kind).toBe('wrong-state');
    expect((await sale()).status).toBe('COMPLETED');
  });
});

// ---- the admin refunds -----------------------------------------------------------------------

describe('an admin refunding a paid sale', () => {
  it('refunds a paid, unshipped sale with a reason on record', async () => {
    await paid();
    const res = await adminRefund();
    expect(res.status).toBe(200);

    expect((await sale()).status).toBe('REFUNDED');
    const [audit] = await audits('TRANSACTION_REFUNDED');
    expect(audit.actorUserId).toBe(w.admin.id);
    expect(audit.metadata).toMatchObject({ by: 'admin', reason: 'Seller unreachable.' });
  });

  it('is refused for a shipped sale (that is a dispute), an unknown id, and a non-admin', async () => {
    await paid();
    expect((await adminRefund(w.transactionId, w.buyer.token)).status).toBe(403);
    expect((await adminRefund('does-not-exist')).status).toBe(404);

    await markShipped(w.transactionId, w.seller.id);
    expect((await adminRefund()).status).toBe(409);
  });

  it('lists paid sales past their ship-by time, and not those still inside it', async () => {
    const list = async () =>
      resData<Array<{ transactionId: string; shipByAt?: string }>>(
        await request(app).get(api('/admin/transactions/unshipped')).set(bearer(w.admin.token)),
      ).map((t) => t.transactionId);

    await paid();
    expect(await list()).not.toContain(w.transactionId);

    await overdue();
    expect(await list()).toContain(w.transactionId);
  });
});

// ---- a takedown ------------------------------------------------------------------------------

describe('taking down an item that was paid for but not sent', () => {
  it('refunds the buyer in the same step', async () => {
    await paid();
    const { listingId } = await prisma.auction.findUniqueOrThrow({ where: { id: w.closedAuctionId } });

    const res = await request(app)
      .post(api(`/admin/listings/${listingId}/takedown`))
      .set(bearer(w.admin.token))
      .send({ reason: 'Counterfeit item.' });
    expect(res.status).toBe(200);

    expect((await sale()).status).toBe('REFUNDED');
    const [audit] = await audits('TRANSACTION_REFUNDED');
    expect(audit.metadata).toMatchObject({ by: 'admin', reason: 'Listing removed: Counterfeit item.' });
    expect(await prisma.notification.count({ where: { userId: w.buyer.id, type: 'SALE_REFUNDED' } })).toBe(1);
  });
});
