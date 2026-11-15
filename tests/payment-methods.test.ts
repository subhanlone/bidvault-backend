/**
 * Paying by card, JazzCash, Easypaisa or bank transfer (all simulated). The pay body is
 * discriminated on `method`, each branch strict, so only the chosen method's field is accepted;
 * the row keeps the method, a masked hint and the bank reference, never a full card or mobile
 * number.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { APPROVED_TEST_CARD, DECLINED_TEST_CARD } from '../src/services/payment-gateway.service.js';
import { resError } from './helpers/api.js';

vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return { ...actual, sendPaymentCompletedEmail: vi.fn(() => Promise.resolve()) };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');

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
    expect(res.body.data).toMatchObject({ status: 'COMPLETED' });

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
    expect(declined.body.data).toMatchObject({ status: 'PENDING', lastPaymentError: 'Your card was declined.' });
    const afterDecline = await reload(w.transactionId);
    expect(afterDecline.status).toBe('PENDING');
    expect(afterDecline.lastPaymentError).toBe('Your card was declined.');

    const paid = await pay({ method: 'JAZZCASH', walletNumber: '03001234567' });
    expect(paid.status).toBe(200);
    const row = await reload(w.transactionId);
    expect(row).toMatchObject({ status: 'COMPLETED', lastPaymentError: null, paymentMethod: 'JAZZCASH', paymentAccountHint: '0300•••567' });
  });
});
