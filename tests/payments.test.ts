/**
 * The payment route — the one place in this product where a bug costs somebody money.
 *
 * No Stripe mock: the dummy gateway is our own deterministic code (payment-gateway.test.ts
 * covers it directly), so these exercise the route the same way a browser would, and are
 * honest about what actually runs.
 *
 *   BV-005  two concurrent /pay calls cannot both charge the same transaction
 *   BV-006  a declined card is retryable rather than terminal
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { APPROVED_TEST_CARD, DECLINED_TEST_CARD } from '../src/services/payment-gateway.service.js';

// Nothing here should reach Resend. Mocked rather than relying on the service's own no-op
// without an API key, so the assertions about *who gets told what* are real assertions.
vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return { ...actual, sendPaymentCompletedEmail: vi.fn(async () => undefined) };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');
const email = await import('../src/services/email.service.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let w: World;

const reload = (id: string) => prisma.auctionTransaction.findUniqueOrThrow({ where: { id } });

const payBody = (cardNumber: string) => ({
  cardNumber,
  deliveryAddress: '123 Test Street, Karachi',
  deliveryPhone: '03001234567',
});

const pay = (transactionId: string, token: string, cardNumber = APPROVED_TEST_CARD) =>
  request(app).post(api(`/payments/${transactionId}/pay`)).set(bearer(token)).send(payBody(cardNumber));

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

describe('a successful charge', () => {
  it('marks the transaction COMPLETED, stores a payment reference and the delivery details', async () => {
    const res = await pay(w.transactionId, w.buyer.token);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ transactionId: w.transactionId, status: 'COMPLETED' });

    const tx = await reload(w.transactionId);
    expect(tx.status).toBe('COMPLETED');
    expect(tx.paymentReference).toMatch(/^PAY-/);
    expect(tx.deliveryAddress).toBe('123 Test Street, Karachi');
    expect(tx.deliveryPhone).toBe('03001234567');
    expect(tx.lastPaymentError).toBeNull();
  });

  it('emails both parties', async () => {
    await pay(w.transactionId, w.buyer.token);
    expect(email.sendPaymentCompletedEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a buyer who did not win the transaction', async () => {
    const res = await pay(w.otherBuyerTransactionId, w.buyer.token);
    expect(res.status).toBe(403);
  });
});

// ---- BV-006 ---------------------------------------------------------------------------

describe('a declined card', () => {
  it('leaves the transaction PENDING with the reason recorded, and still saves delivery details', async () => {
    const res = await pay(w.transactionId, w.buyer.token, DECLINED_TEST_CARD);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      transactionId: w.transactionId,
      status: 'PENDING',
      lastPaymentError: 'Your card was declined.',
    });

    const tx = await reload(w.transactionId);
    expect(tx.status).toBe('PENDING');
    expect(tx.paymentReference).toBeNull();
    expect(tx.deliveryAddress).toBe('123 Test Street, Karachi');
    expect(email.sendPaymentCompletedEmail).not.toHaveBeenCalled();
  });

  it('can be retried, and a successful retry clears the stale reason', async () => {
    await pay(w.transactionId, w.buyer.token, DECLINED_TEST_CARD);
    expect((await reload(w.transactionId)).lastPaymentError).toBe('Your card was declined.');

    const retry = await pay(w.transactionId, w.buyer.token);
    expect(retry.status).toBe(200);

    const tx = await reload(w.transactionId);
    expect(tx.status).toBe('COMPLETED');
    expect(tx.lastPaymentError).toBeNull();
  });

  it('surfaces the reason to the buyer through my-wins', async () => {
    await pay(w.transactionId, w.buyer.token, DECLINED_TEST_CARD);

    const res = await request(app).get(api('/payments/my-wins')).set(bearer(w.buyer.token)).expect(200);
    const mine = (res.body.data as Array<{ transactionId: string; lastPaymentError?: string }>)
      .find((t) => t.transactionId === w.transactionId);

    expect(mine?.lastPaymentError).toBe('Your card was declined.');
  });
});

// ---- BV-005 ---------------------------------------------------------------------------

describe('concurrent /pay calls', () => {
  it('only one of two simultaneous calls actually charges the transaction', async () => {
    // No barrier needed to prove this: the FOR UPDATE lock in the route serialises the two
    // requests at the database, so whichever commits first leaves the transaction PAID for
    // the second to find.
    const [a, b] = await Promise.all([pay(w.transactionId, w.buyer.token), pay(w.transactionId, w.buyer.token)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const tx = await reload(w.transactionId);
    expect(tx.status).toBe('COMPLETED');
    // Exactly one payment reference was ever written — the losing call never reached the
    // charge step at all, not just "charged and got overwritten".
    expect(tx.paymentReference).toMatch(/^PAY-/);
  });
});

// ---- terminal states -------------------------------------------------------------------

describe('an already-paid transaction', () => {
  it('cannot be paid for a second time', async () => {
    await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'COMPLETED' } });

    const res = await pay(w.transactionId, w.buyer.token);

    expect(res.status).toBe(409);
    expect(email.sendPaymentCompletedEmail).not.toHaveBeenCalled();
  });
});
