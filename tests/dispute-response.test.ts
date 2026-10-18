/**
 * The seller's one response to a buyer's dispute. Modelled on how eBay and Stripe treat a seller
 * response: one submission, final, with a window to make it in. Here the window is soft: the
 * seller is told "respond within 3 days" and the admin sees whether the seller answered and
 * whether the window has passed, but resolveDispute never waits for either.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData, resError } from './helpers/api.js';

const mail = vi.hoisted(() => ({ send: vi.fn(() => Promise.resolve({ data: { id: 'email_test' }, error: null })) }));

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
const { respondToDispute, resolveDispute, disputeResponseDueAt, DISPUTE_RESPONSE_WINDOW_DAYS } = await import(
  '../src/services/fulfillment.service.js'
);

type World = Awaited<ReturnType<typeof seedWorld>>;

interface AdminDisputeRow {
  disputeId: string;
  transactionId: string;
  createdAt: string;
  sellerResponse?: string;
  sellerRespondedAt?: string;
  responseDueAt: string;
}

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const DAY_MS = 24 * 60 * 60 * 1000;
const RESPONSE = 'The item was packed and sent as described; here is the courier receipt.';

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

/** w.transactionId (the seller's sale to `buyer`) with an OPEN dispute raised on it. */
async function openDispute(createdAt?: Date) {
  await prisma.auctionTransaction.update({
    where: { id: w.transactionId },
    data: { status: 'DISPUTED', shippedAt: new Date() },
  });
  return prisma.dispute.create({
    data: {
      transactionId: w.transactionId,
      raisedByUserId: w.buyer.id,
      reason: 'The item never arrived at my address.',
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

const respond = (token: string | undefined, body: object = { response: RESPONSE }) => {
  const req = request(app).post(api(`/payments/${w.transactionId}/dispute/response`));
  return (token ? req.set(auth(token)) : req).send(body);
};

const storedDispute = () => prisma.dispute.findUniqueOrThrow({ where: { transactionId: w.transactionId } });

describe('POST /payments/{transactionId}/dispute/response', () => {
  it('the seller can respond once to an open dispute', async () => {
    await openDispute();

    const res = await respond(w.seller.token);

    expect(res.status).toBe(200);
    const row = await storedDispute();
    expect(row.sellerResponse).toBe(RESPONSE);
    expect(row.sellerRespondedAt).not.toBeNull();
    expect(row.status).toBe('OPEN');
    const tx = await prisma.auctionTransaction.findUniqueOrThrow({ where: { id: w.transactionId } });
    expect(tx.status).toBe('DISPUTED');
  });

  it('a second response is refused with 409 and the first stands', async () => {
    await openDispute();
    expect((await respond(w.seller.token)).status).toBe(200);

    const res = await respond(w.seller.token, { response: 'I would like to change my answer entirely.' });

    expect(res.status).toBe(409);
    expect(resError(res).error).toMatch(/already responded/i);
    expect((await storedDispute()).sellerResponse).toBe(RESPONSE);
  });

  it("another seller cannot respond to someone else's dispute", async () => {
    await openDispute();

    const res = await respond(w.otherSeller.token);

    expect(res.status).toBe(403);
    expect((await storedDispute()).sellerResponse).toBeNull();
  });

  it('a buyer gets 403 and an anonymous caller 401', async () => {
    await openDispute();

    expect((await respond(w.buyer.token)).status).toBe(403);
    expect((await respond(undefined)).status).toBe(401);
    expect((await storedDispute()).sellerResponse).toBeNull();
  });

  it('a sale with no dispute is refused with 409', async () => {
    const res = await respond(w.seller.token);
    expect(res.status).toBe(409);
  });

  it('an unknown transaction is a 404', async () => {
    const res = await request(app)
      .post(api('/payments/does-not-exist/dispute/response'))
      .set(auth(w.seller.token))
      .send({ response: RESPONSE });
    expect(res.status).toBe(404);
    expect(resError(res).error).toMatch(/transaction not found/i);
  });

  it('responding after the admin resolved is refused with 409', async () => {
    const dispute = await openDispute();
    await prisma.dispute.update({
      where: { id: dispute.id },
      data: { status: 'RESOLVED_RELEASED', resolvedAt: new Date(), resolvedByUserId: w.admin.id, resolutionNote: 'Delivered.' },
    });

    const res = await respond(w.seller.token);

    expect(res.status).toBe(409);
    expect((await storedDispute()).sellerResponse).toBeNull();
  });

  it('a response shorter than 10 or longer than 1000 characters is a 400', async () => {
    await openDispute();

    expect((await respond(w.seller.token, { response: 'too short' })).status).toBe(400);
    expect((await respond(w.seller.token, { response: 'x'.repeat(1001) })).status).toBe(400);
    expect((await respond(w.seller.token, { response: 'x'.repeat(1000) })).status).toBe(200);
  });
});

describe('the response window', () => {
  it('is 3 days from the dispute being raised', () => {
    const raised = new Date('2026-10-18T10:00:00.000Z');
    expect(DISPUTE_RESPONSE_WINDOW_DAYS).toBe(3);
    expect(disputeResponseDueAt(raised).toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });

  it('the dispute-raised email tells the seller about it', async () => {
    await prisma.auctionTransaction.update({
      where: { id: w.transactionId },
      data: { status: 'SHIPPED', shippedAt: new Date() },
    });

    const res = await request(app)
      .post(api(`/payments/${w.transactionId}/dispute`))
      .set(auth(w.buyer.token))
      .send({ reason: 'Item arrived damaged and unusable.' });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    const html = mail.send.mock.calls.map((c) => (c as unknown as [{ html: string }])[0].html).join('\n');
    expect(html).toMatch(/within 3 days/);
    expect(html).toMatch(/admin may decide after that/i);
    expect(html).not.toMatch(/No action is needed/);
  });
});

describe('GET /admin/disputes', () => {
  it('shows the seller response and responseDueAt = createdAt + 3 days', async () => {
    const dispute = await openDispute();
    await respond(w.seller.token);

    const res = await request(app).get(api('/admin/disputes')).set(auth(w.admin.token));

    expect(res.status).toBe(200);
    const row = resData<AdminDisputeRow[]>(res).find((d) => d.disputeId === dispute.id);
    expect(row?.sellerResponse).toBe(RESPONSE);
    expect(row?.sellerRespondedAt).toBeDefined();
    expect(new Date(row!.responseDueAt).getTime()).toBe(new Date(row!.createdAt).getTime() + 3 * DAY_MS);
  });

  it('omits sellerResponse while the seller has not answered', async () => {
    const dispute = await openDispute();

    const res = await request(app).get(api('/admin/disputes')).set(auth(w.admin.token));

    const row = resData<AdminDisputeRow[]>(res).find((d) => d.disputeId === dispute.id);
    expect(row?.sellerResponse).toBeUndefined();
    expect(row?.sellerRespondedAt).toBeUndefined();
    expect(row?.responseDueAt).toBeDefined();
  });
});

describe('the admin is never held up by the response', () => {
  it('can resolve a dispute that has no response, after the window has passed', async () => {
    const dispute = await openDispute(new Date(Date.now() - 10 * DAY_MS));

    const res = await request(app)
      .post(api(`/admin/disputes/${dispute.id}/resolve`))
      .set(auth(w.admin.token))
      .send({ resolution: 'RELEASE', note: 'No response from the seller in time; buyer evidence stands.' });

    expect(res.status).toBe(200);
    expect((await storedDispute()).status).toBe('RESOLVED_RELEASED');
  });
});

describe('concurrency', () => {
  it('two simultaneous responses: exactly one is stored', async () => {
    await openDispute();

    const results = await Promise.all([
      respondToDispute(w.transactionId, w.seller.id, 'First answer, long enough to be valid.'),
      respondToDispute(w.transactionId, w.seller.id, 'Second answer, long enough to be valid.'),
    ]);

    expect(results.map((r) => r.kind).sort()).toEqual(['already-responded', 'ok']);
  });

  it('a response racing the admin resolving is either stored before it or refused, never after', async () => {
    const dispute = await openDispute();

    const [responded] = await Promise.all([
      respondToDispute(w.transactionId, w.seller.id, RESPONSE),
      resolveDispute(dispute.id, w.admin.id, 'RELEASE', 'Resolved while the seller was typing.'),
    ]);

    const row = await storedDispute();
    expect(row.status).toBe('RESOLVED_RELEASED');
    if (responded.kind === 'ok') {
      expect(row.sellerResponse).toBe(RESPONSE);
      expect(row.sellerRespondedAt!.getTime()).toBeLessThanOrEqual(row.resolvedAt!.getTime());
    } else {
      expect(responded.kind).toBe('no-open-dispute');
      expect(row.sellerResponse).toBeNull();
    }
  });
});
