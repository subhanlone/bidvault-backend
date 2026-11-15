/**
 * Paying by card, JazzCash, Easypaisa or bank transfer (all simulated). The pay body is
 * discriminated on `method`, each branch strict, so only the chosen method's field is accepted;
 * the row keeps the method, a masked hint and the bank reference, never a full card or mobile
 * number.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { APPROVED_TEST_CARD, DECLINED_TEST_CARD } from '../src/services/payment-gateway.service.js';
import { resData, resError } from './helpers/api.js';

type Invoice = { amount: number; payment?: Record<string, unknown>; refund?: Record<string, unknown> };
type WonRow = { transactionId: string; payment?: unknown; refund?: { paidTo?: string } };
type SellerItemRow = { sale?: { transactionId: string; refund?: Record<string, unknown> } };
type AdminRow = { transactionId: string; payment?: unknown };

vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return {
    ...actual,
    sendPaymentCompletedEmail: vi.fn(() => Promise.resolve()),
    sendSaleRefundedEmail: vi.fn(() => Promise.resolve()),
  };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');
const { refundUnshippedSale } = await import('../src/services/fulfillment.service.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// A delivery phone that differs from every wallet number below, so "the full mobile number is
// not stored" is a real check and not satisfied or broken by the delivery phone.
const delivery = { deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '0321 7654321' };

let w: World;

const reload = (id: string) => prisma.auctionTransaction.findUniqueOrThrow({ where: { id } });
const pay = (body: Record<string, unknown>) =>
  request(app).post(api(`/payments/${w.transactionId}/pay`)).set(bearer(w.buyer.token)).send({ ...delivery, ...body });

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  w = await seedWorld();
  vi.clearAllMocks();
  takeViolations();
});
afterEach(() => {
  // Every response here must match the published contract.
  expect(takeViolations()).toEqual([]);
});
afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('POST /payments/:id/pay with a method', () => {
  it.each([
    ['CARD', { method: 'CARD', cardNumber: '4242 4242 4242 4242' }, 'Visa •••4242', null],
    ['JAZZCASH', { method: 'JAZZCASH', walletNumber: '+92 300-1234567' }, '0300•••567', null],
    ['EASYPAISA', { method: 'EASYPAISA', walletNumber: '03451234567' }, '0345•••567', null],
    ['BANK_TRANSFER', { method: 'BANK_TRANSFER', bankReference: 'FT2611110001' }, null, 'FT2611110001'],
  ] as const)('pays with %s and stores method, hint, reference; never a full number', async (method, body, hint, bankRef) => {
    const res = await pay(body);
    expect(res.status).toBe(200);
    expect(resData<{ status: string }>(res)).toMatchObject({ status: 'COMPLETED' });

    const row = await reload(w.transactionId);
    expect(row).toMatchObject({ status: 'COMPLETED', paymentMethod: method, paymentAccountHint: hint, bankTransferReference: bankRef });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(APPROVED_TEST_CARD);
    expect(stored).not.toContain('03001234567');
    expect(stored).not.toContain('03451234567');
  });

  it('refuses a body without a method', async () => {
    const res = await pay({ cardNumber: APPROVED_TEST_CARD });
    expect(res.status).toBe(400);
    expect(resError(res).details).toHaveProperty('method');
  });

  it('refuses a wallet payment carrying cardNumber', async () => {
    const res = await pay({ method: 'JAZZCASH', walletNumber: '03001234567', cardNumber: APPROVED_TEST_CARD });
    expect(res.status).toBe(400);
    // The 400 names the field that does not belong, so a client can say which one it is.
    expect(resError(res).details).toHaveProperty('cardNumber');
    expect((await reload(w.transactionId)).status).toBe('PENDING');
  });

  it('refuses a bad wallet number and a bad bank reference', async () => {
    const wallet = await pay({ method: 'EASYPAISA', walletNumber: '1234' });
    expect(wallet.status).toBe(400);
    expect(resError(wallet).details).toHaveProperty('walletNumber');

    const bank = await pay({ method: 'BANK_TRANSFER', bankReference: 'ab' });
    expect(bank.status).toBe(400);
    expect(resError(bank).details).toHaveProperty('bankReference');
  });

  it('a declined card, then JazzCash', async () => {
    const declined = await pay({ method: 'CARD', cardNumber: DECLINED_TEST_CARD });
    // A decline is an ordinary outcome, answered 200 with the sale still PENDING (BV-006).
    expect(declined.status).toBe(200);
    expect(resData<{ status: string; lastPaymentError?: string }>(declined)).toMatchObject({ status: 'PENDING', lastPaymentError: 'Your card was declined.' });
    const afterDecline = await reload(w.transactionId);
    expect(afterDecline.status).toBe('PENDING');
    expect(afterDecline.lastPaymentError).toBe('Your card was declined.');

    const paid = await pay({ method: 'JAZZCASH', walletNumber: '03001234567' });
    expect(paid.status).toBe(200);
    const row = await reload(w.transactionId);
    expect(row).toMatchObject({ status: 'COMPLETED', lastPaymentError: null, paymentMethod: 'JAZZCASH', paymentAccountHint: '0300•••567' });
  });
});

describe('payment and refund details in the read models', () => {
  const get = (path: string, token: string) => request(app).get(api(path)).set(bearer(token));

  async function payThenSellerRefund(body: Record<string, unknown>) {
    expect((await pay(body)).status).toBe(200);
    const r = await refundUnshippedSale(w.transactionId, { by: 'seller', userId: w.seller.id, reason: 'Item broke in storage' });
    expect(r.kind).toBe('ok');
  }

  it('the buyer\'s invoice says where the refund went and when it should arrive', async () => {
    await payThenSellerRefund({ method: 'JAZZCASH', walletNumber: '03001234567' });
    const res = await get(`/payments/${w.transactionId}/invoice`, w.buyer.token);
    expect(res.status).toBe(200);
    const invoice = resData<Invoice>(res);
    expect(invoice.payment).toEqual({ method: 'JAZZCASH', methodLabel: 'JazzCash', accountHint: '0300•••567' });
    expect(invoice.refund).toMatchObject({
      amount: invoice.amount,
      paidTo: 'JazzCash 0300•••567',
      reasonText: 'The seller could not send the item',
      expectedArrival: 'Immediately (simulated: no real money moves)',
    });
    expect(invoice.refund?.refundReference).toMatch(/^RFD-/);
  });

  it('the seller\'s invoice names the method but never the hint or the bank reference', async () => {
    await payThenSellerRefund({ method: 'BANK_TRANSFER', bankReference: 'FT2611110001' });
    const res = await get(`/payments/${w.transactionId}/invoice`, w.seller.token);
    expect(res.status).toBe(200);
    const invoice = resData<Invoice>(res);
    expect(invoice.payment).toEqual({ method: 'BANK_TRANSFER', methodLabel: 'Bank transfer' });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('•••');
    expect(text).not.toContain('FT2611110001');
    expect(invoice.refund).not.toHaveProperty('paidTo');
  });

  it('my-wins carries the payment and the refund', async () => {
    await payThenSellerRefund({ method: 'EASYPAISA', walletNumber: '03451234567' });
    const res = await get('/payments/my-wins', w.buyer.token);
    const mine = resData<WonRow[]>(res).find((t) => t.transactionId === w.transactionId);
    expect(mine?.payment).toMatchObject({ method: 'EASYPAISA', accountHint: '0345•••567' });
    expect(mine?.refund?.paidTo).toBe('Easypaisa 0345•••567');
  });

  it('the seller\'s item row explains the refund without the buyer\'s account', async () => {
    await payThenSellerRefund({ method: 'JAZZCASH', walletNumber: '03001234567' });
    const res = await get('/seller/items?tab=sold', w.seller.token);
    expect(res.status).toBe(200);
    const item = resData<{ items: SellerItemRow[] }>(res).items.find((i) => i.sale?.transactionId === w.transactionId);
    expect(item?.sale?.refund).toMatchObject({ reasonText: 'The seller could not send the item', note: 'Item broke in storage', refundedBy: 'SELLER' });
    expect(JSON.stringify(item)).not.toContain('•••');
  });

  it('admin transactions carry the payment hint', async () => {
    expect((await pay({ method: 'CARD', cardNumber: APPROVED_TEST_CARD })).status).toBe(200);
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { shipByAt: new Date(Date.now() - 60_000) } });
    const res = await get('/admin/transactions/unshipped', w.admin.token);
    const row = resData<AdminRow[]>(res).find((t) => t.transactionId === w.transactionId);
    expect(row?.payment).toEqual({ method: 'CARD', methodLabel: 'Card', accountHint: 'Visa •••4242' });
  });

  it('a legacy paid and refunded sale still renders without invented data', async () => {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'REFUNDED', paidAt: new Date(), paymentReference: 'PAY-legacy0001', deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567' },
    });
    const res = await get(`/payments/${w.transactionId}/invoice`, w.buyer.token);
    expect(res.status).toBe(200);
    const invoice = resData<Invoice>(res);
    expect(invoice.payment).toEqual({ method: 'CARD', methodLabel: 'Card' });
    expect(invoice.refund).toEqual({ amount: invoice.amount, paymentReference: 'PAY-legacy0001' });
  });
});

describe('review follow-ups', () => {
  const get = (path: string, token: string) => request(app).get(api(path)).set(bearer(token));

  /** A sale paid before payment methods existed: a reference, no method, no hint. */
  async function legacy(data: Record<string, unknown>) {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { paidAt: new Date(), paymentReference: 'PAY-legacy0002', deliveryAddress: '123 Test Street, Karachi', deliveryPhone: '03001234567', ...data },
    });
  }

  it('refuses a card number that is not 12 to 19 digits, so no letters reach the stored hint', async () => {
    const res = await pay({ method: 'CARD', cardNumber: 'abcd efgh ijkl' });
    expect(res.status).toBe(400);
    expect(resError(res).details).toHaveProperty('cardNumber');
    expect((await reload(w.transactionId)).status).toBe('PENDING');
  });

  it('a legacy paid sale shows as Card in my-wins, with no refund', async () => {
    await legacy({ status: 'COMPLETED' });
    const mine = resData<WonRow[]>(await get('/payments/my-wins', w.buyer.token)).find((t) => t.transactionId === w.transactionId);
    expect(mine?.payment).toEqual({ method: 'CARD', methodLabel: 'Card' });
    expect(mine?.refund).toBeUndefined();
  });

  it('a legacy paid sale shows as Card on the admin unshipped list', async () => {
    await legacy({ status: 'COMPLETED', shipByAt: new Date(Date.now() - 60_000) });
    const row = resData<AdminRow[]>(await get('/admin/transactions/unshipped', w.admin.token)).find((t) => t.transactionId === w.transactionId);
    expect(row?.payment).toEqual({ method: 'CARD', methodLabel: 'Card' });
  });

  it('a legacy refunded sale gives the seller the amount and payment reference only', async () => {
    await legacy({ status: 'REFUNDED' });
    const item = resData<{ items: SellerItemRow[] }>(await get('/seller/items?tab=sold', w.seller.token)).items
      .find((i) => i.sale?.transactionId === w.transactionId);
    expect(item?.sale?.refund).toEqual({ amount: expect.any(Number) as number, paymentReference: 'PAY-legacy0002' });
  });

  it('the contract shows what a wallet number looks like', async () => {
    const { document } = await import('../src/openapi/document.js');
    expect(JSON.stringify(document.components?.schemas?.PayTransactionRequest)).toContain('0300 1234567');
  });
});
