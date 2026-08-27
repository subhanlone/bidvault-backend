/**
 * The payment path — the one place in this product where a bug costs somebody money.
 *
 * The conformance suite calls each payment route once and checks the response shape. It
 * mocks `paymentIntents.create` and never looks at what was passed to it, which is exactly
 * why BV-001 survived: the integer handed to Stripe was wrong by a factor of 100 and every
 * test still passed.
 *
 * These are the assertions that would have caught it, plus the three failure modes the audit
 * found around it:
 *
 *   BV-001  the amount sent to Stripe is in minor units
 *   BV-011  what actually arrived is checked against what is owed
 *   BV-005  two concurrent create-intent calls cannot produce two intents
 *   BV-006  a declined card is retryable rather than terminal
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * A Stripe double that records what it was asked to do.
 *
 * `webhooks` keeps the real implementation, so signature verification is genuinely
 * exercised rather than waved through — a webhook test that skipped it would prove nothing.
 */
const created: Array<{ params: Record<string, unknown>; options?: Record<string, unknown> }> = [];
let retrieveStatus = 'requires_payment_method';
let createBarrier: Promise<void> | null = null;
let createShouldThrow: Error | null = null;

// Nothing here should reach Resend. Mocked rather than relying on the service's own no-op
// without an API key, so the assertions about *who gets told what* are real assertions.
vi.mock('../src/services/email.service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/email.service.js')>(
    '../src/services/email.service.js',
  );
  return { ...actual, sendPaymentCompletedEmail: vi.fn(async () => undefined) };
});

vi.mock('stripe', async () => {
  const actual = await vi.importActual<typeof import('stripe')>('stripe');
  const real = new actual.default('sk_test_placeholder_for_signature_verification_only');
  let seq = 0;

  class MockStripe {
    webhooks = real.webhooks;
    paymentIntents = {
      create: vi.fn(async (params: Record<string, unknown>, options?: Record<string, unknown>) => {
        created.push({ params, options });
        if (createBarrier) await createBarrier;
        if (createShouldThrow) throw createShouldThrow;
        const id = `pi_test_${++seq}`;
        return { id, client_secret: `${id}_secret`, status: 'requires_payment_method' };
      }),
      retrieve: vi.fn(async (id: string) => ({
        id,
        client_secret: `${id}_secret`,
        status: retrieveStatus,
      })),
    };
  }
  return { ...actual, default: MockStripe };
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

/** A validly-signed Stripe event, so the handler's own verification does the accepting. */
async function signedEvent(type: string, object: Record<string, unknown>) {
  const { default: Stripe } = await vi.importActual<typeof import('stripe')>('stripe');
  const payload = JSON.stringify({
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    type,
    data: { object: { object: 'payment_intent', ...object } },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  });
  return { payload, signature };
}

const postWebhook = async (type: string, object: Record<string, unknown>) => {
  const { payload, signature } = await signedEvent(type, object);
  return request(app)
    .post(api('/payments/webhook'))
    .set('stripe-signature', signature)
    .set('Content-Type', 'application/json')
    .send(payload);
};

const reload = (id: string) => prisma.auctionTransaction.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  await prisma.$connect();
});
beforeEach(async () => {
  w = await seedWorld();
  created.length = 0;
  retrieveStatus = 'requires_payment_method';
  createBarrier = null;
  createShouldThrow = null;
  vi.clearAllMocks();
});
afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

// ---- BV-001 ---------------------------------------------------------------------------

describe('the amount sent to Stripe', () => {
  it('is the winning bid converted to minor units, not the rupee figure', async () => {
    // seedWorld's transaction is PKR 8,000. PKR is two-decimal, so Stripe must be asked for
    // 800000 paisa. Passing 8000 charges PKR 80 — which is what shipped, silently, while the
    // buyer was shown "Pay PKR 8,000" and the books recorded 8,000 as collected.
    const tx = await reload(w.transactionId);
    expect(tx.finalAmount).toBe(8_000);

    await request(app)
      .post(api('/payments/create-intent'))
      .set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId })
      .expect(200);

    expect(created).toHaveLength(1);
    expect(created[0].params.amount).toBe(800_000);
    expect(created[0].params.currency).toBe('pkr');
  });

  it('passes an idempotency key derived from the transaction', async () => {
    await request(app)
      .post(api('/payments/create-intent'))
      .set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId })
      .expect(200);

    expect(created[0].options?.idempotencyKey).toBe(`bidvault-intent-${w.transactionId}`);
  });
});

// ---- BV-005 ---------------------------------------------------------------------------

describe('concurrent create-intent calls', () => {
  it('produce one PaymentIntent, not two', async () => {
    // Hold both calls inside Stripe until each has had the chance to read the row. Without
    // the FOR UPDATE lock both see stripePaymentIntentId as null, both create an intent, and
    // the second overwrites the first — so a buyer paying the first one is never recorded.
    let release!: () => void;
    createBarrier = new Promise<void>((r) => { release = r; });

    const call = () =>
      request(app)
        .post(api('/payments/create-intent'))
        .set(bearer(w.buyer.token))
        .send({ transactionId: w.transactionId });

    const both = Promise.all([call(), call()]);
    // Give both requests time to reach the lock before letting Stripe answer.
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [a, b] = await both;

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // The assertion that matters: Stripe was asked to create exactly one intent, so there is
    // no second one for the buyer to pay against a row that no longer points at it.
    expect(created).toHaveLength(1);

    // And both callers received the same client secret, so whichever one the browser confirms
    // is the intent the transaction actually records.
    const tx = await reload(w.transactionId);
    expect(tx.stripePaymentIntentId).not.toBeNull();
    expect(a.body.data.clientSecret).toBe(b.body.data.clientSecret);
    expect(a.body.data.clientSecret).toBe(`${tx.stripePaymentIntentId}_secret`);
  });

  it('reuses an intent that is still awaiting payment', async () => {
    await request(app).post(api('/payments/create-intent')).set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId }).expect(200);
    expect(created).toHaveLength(1);

    await request(app).post(api('/payments/create-intent')).set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId }).expect(200);
    expect(created).toHaveLength(1);
  });

  it('mints a fresh intent when the stored one was canceled', async () => {
    await request(app).post(api('/payments/create-intent')).set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId }).expect(200);

    // A canceled intent cannot be confirmed again; returning its client_secret would fail
    // inside Stripe.js with a message meaning nothing to the buyer.
    retrieveStatus = 'canceled';

    await request(app).post(api('/payments/create-intent')).set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId }).expect(200);
    expect(created).toHaveLength(2);
  });
});

// ---- BV-011 ---------------------------------------------------------------------------

describe('the webhook checks what actually arrived', () => {
  beforeEach(async () => {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { stripePaymentIntentId: 'pi_under_test' },
    });
  });

  it('marks the transaction paid when the full amount arrived', async () => {
    const res = await postWebhook('payment_intent.succeeded', {
      id: 'pi_under_test',
      amount_received: 800_000,
      currency: 'pkr',
    });
    expect(res.status).toBe(200);
    expect((await reload(w.transactionId)).status).toBe('COMPLETED');
  });

  it('refuses to mark it paid when the amount is short', async () => {
    // Exactly the shape BV-001 produced: Stripe reports success for the 1/100th it was asked
    // to collect, and the handler used to accept that as settlement of the full debt. That is
    // why the bug produced no error anywhere and had to be found by reading.
    const res = await postWebhook('payment_intent.succeeded', {
      id: 'pi_under_test',
      amount_received: 8_000,
      currency: 'pkr',
    });

    expect(res.status).toBe(200); // acknowledged, so Stripe stops retrying
    expect((await reload(w.transactionId)).status).toBe('PENDING');
    expect(email.sendPaymentCompletedEmail).not.toHaveBeenCalled();
  });

  it('refuses on a currency mismatch', async () => {
    await postWebhook('payment_intent.succeeded', {
      id: 'pi_under_test',
      amount_received: 800_000,
      currency: 'usd',
    });
    expect((await reload(w.transactionId)).status).toBe('PENDING');
  });

  it('is idempotent: a redelivered event does not complete twice', async () => {
    const send = () =>
      postWebhook('payment_intent.succeeded', {
        id: 'pi_under_test',
        amount_received: 800_000,
        currency: 'pkr',
      });

    await send();
    await send();

    expect((await reload(w.transactionId)).status).toBe('COMPLETED');
    // The conditional update is what makes this true: only the call that actually moved the
    // row sends the mail, so a redelivery cannot congratulate the buyer twice.
    expect(email.sendPaymentCompletedEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsigned or wrongly-signed payload', async () => {
    const res = await request(app)
      .post(api('/payments/webhook'))
      .set('stripe-signature', 't=1,v1=deadbeef')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_under_test' } } }));

    expect(res.status).toBe(400);
    expect((await reload(w.transactionId)).status).toBe('PENDING');
  });
});

// ---- BV-006 ---------------------------------------------------------------------------

describe('a declined card', () => {
  beforeEach(async () => {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { stripePaymentIntentId: 'pi_declined' },
    });
  });

  it('records the reason and leaves the transaction payable', async () => {
    await postWebhook('payment_intent.payment_failed', {
      id: 'pi_declined',
      last_payment_error: { message: 'Your card has insufficient funds.' },
    });

    const tx = await reload(w.transactionId);
    // The status stays PENDING. Writing FAILED here is what made one decline permanent.
    expect(tx.status).toBe('PENDING');
    expect(tx.lastPaymentError).toBe('Your card has insufficient funds.');
  });

  it('can be retried, and the retry clears the stale reason', async () => {
    await postWebhook('payment_intent.payment_failed', {
      id: 'pi_declined',
      last_payment_error: { message: 'Your card was declined.' },
    });
    expect((await reload(w.transactionId)).lastPaymentError).toBe('Your card was declined.');

    retrieveStatus = 'canceled'; // the declined intent is not reusable
    const retry = await request(app)
      .post(api('/payments/create-intent'))
      .set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId });

    expect(retry.status).toBe(200);
    const tx = await reload(w.transactionId);
    expect(tx.status).toBe('PENDING');
    expect(tx.lastPaymentError).toBeNull();
  });

  it('surfaces the reason to the buyer through my-wins', async () => {
    await postWebhook('payment_intent.payment_failed', {
      id: 'pi_declined',
      last_payment_error: { message: 'Your card has expired.' },
    });

    const res = await request(app).get(api('/payments/my-wins')).set(bearer(w.buyer.token)).expect(200);
    const mine = (res.body.data as Array<{ transactionId: string; lastPaymentError?: string }>)
      .find((t) => t.transactionId === w.transactionId);

    // Left in the database only, the reason would never reach the person who has to act on it.
    expect(mine?.lastPaymentError).toBe('Your card has expired.');
  });

  it('a late failure for a superseded intent cannot disturb a paid transaction', async () => {
    await postWebhook('payment_intent.succeeded', {
      id: 'pi_declined',
      amount_received: 800_000,
      currency: 'pkr',
    });
    expect((await reload(w.transactionId)).status).toBe('COMPLETED');

    await postWebhook('payment_intent.payment_failed', {
      id: 'pi_declined',
      last_payment_error: { message: 'too late' },
    });

    const tx = await reload(w.transactionId);
    expect(tx.status).toBe('COMPLETED');
    expect(tx.lastPaymentError).toBeNull();
  });
});

// ---- terminal states -------------------------------------------------------------------

describe('a completed purchase', () => {
  it('cannot be paid for a second time', async () => {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'COMPLETED' },
    });

    const res = await request(app)
      .post(api('/payments/create-intent'))
      .set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId });

    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });
});

describe('when Stripe itself rejects the request', () => {
  it('answers 502 without leaking the SDK message, and leaves the row retryable', async () => {
    createShouldThrow = new Error('Amount must convert to at least 200 fils. ₨50.00 converts to د.إ0.66.');

    const res = await request(app)
      .post(api('/payments/create-intent'))
      .set(bearer(w.buyer.token))
      .send({ transactionId: w.transactionId });

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('fils');

    const tx = await reload(w.transactionId);
    expect(tx.status).toBe('PENDING');
    expect(tx.stripePaymentIntentId).toBeNull();
  });
});
