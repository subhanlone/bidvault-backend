/**
 * Phase 7 (LIFECYCLE-IMPLEMENTATION-PLAN.md): C6 — a review was previously permanent and
 * one-directional. A buyer can now edit or delete their own review within
 * reviewEditWindowHours, and the reviewed seller gets a one-shot right of reply.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: vi.fn(async () => ({ data: { id: 'email_test' }, error: null })) };
  },
}));

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');
const { updatePlatformSettings } = await import('../src/services/settings.service.js');

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

async function seedReview() {
  await prisma.auctionTransaction.update({ where: { id: w.transactionId }, data: { status: 'DELIVERED' } });
  const res = await request(app)
    .post(api('/reviews'))
    .set(auth(w.buyer.token))
    .send({ transactionId: w.transactionId, stars: 3, comment: 'It was fine.' });
  return res.body.data.reviewId as string;
}

describe('edit a review (C6)', () => {
  it('updates stars and comment within the edit window', async () => {
    const reviewId = await seedReview();
    const res = await request(app)
      .patch(api(`/reviews/${reviewId}`))
      .set(auth(w.buyer.token))
      .send({ stars: 5, comment: 'Actually it was great, updating my review.' });
    expect(res.status).toBe(200);
    expect(res.body.data.stars).toBe(5);

    const row = await prisma.sellerReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(row.stars).toBe(5);
    expect(row.updatedAt).not.toBeNull();
  });

  it('refuses to edit once the window has passed', async () => {
    const reviewId = await seedReview();
    await updatePlatformSettings({ reviewEditWindowHours: 1 });
    await prisma.sellerReview.update({
      where: { id: reviewId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const res = await request(app)
      .patch(api(`/reviews/${reviewId}`))
      .set(auth(w.buyer.token))
      .send({ stars: 1 });
    expect(res.status).toBe(409);
  });

  it("refuses to edit another buyer's review", async () => {
    const reviewId = await seedReview();
    const res = await request(app)
      .patch(api(`/reviews/${reviewId}`))
      .set(auth(w.otherBuyer.token))
      .send({ stars: 1 });
    expect(res.status).toBe(403);
  });
});

describe('delete a review (C6)', () => {
  it('deletes within the edit window', async () => {
    const reviewId = await seedReview();
    const res = await request(app).delete(api(`/reviews/${reviewId}`)).set(auth(w.buyer.token));
    expect(res.status).toBe(200);

    const row = await prisma.sellerReview.findUnique({ where: { id: reviewId } });
    expect(row).toBeNull();
  });

  it('refuses to delete once the window has passed', async () => {
    const reviewId = await seedReview();
    await updatePlatformSettings({ reviewEditWindowHours: 1 });
    await prisma.sellerReview.update({
      where: { id: reviewId },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    const res = await request(app).delete(api(`/reviews/${reviewId}`)).set(auth(w.buyer.token));
    expect(res.status).toBe(409);
  });
});

describe("seller's right of reply (C6)", () => {
  it('the reviewed seller can reply once', async () => {
    const reviewId = await seedReview();
    const res = await request(app)
      .post(api(`/reviews/${reviewId}/reply`))
      .set(auth(w.seller.token))
      .send({ reply: 'Thanks for your business!' });
    expect(res.status).toBe(200);
    expect(res.body.data.sellerReply).toBe('Thanks for your business!');

    const notification = await prisma.notification.findFirst({ where: { userId: w.buyer.id, type: 'REVIEW_REPLY' } });
    expect(notification).not.toBeNull();
  });

  it('refuses a second reply', async () => {
    const reviewId = await seedReview();
    await request(app).post(api(`/reviews/${reviewId}/reply`)).set(auth(w.seller.token)).send({ reply: 'First reply.' });
    const res = await request(app)
      .post(api(`/reviews/${reviewId}/reply`))
      .set(auth(w.seller.token))
      .send({ reply: 'Second reply.' });
    expect(res.status).toBe(409);
  });

  it('refuses a reply from a seller who was not reviewed', async () => {
    const reviewId = await seedReview();
    const res = await request(app)
      .post(api(`/reviews/${reviewId}/reply`))
      .set(auth(w.otherSeller.token))
      .send({ reply: 'Not my review.' });
    expect(res.status).toBe(403);
  });

  it('GET /reviews/seller/{id} surfaces the reply', async () => {
    const reviewId = await seedReview();
    await request(app).post(api(`/reviews/${reviewId}/reply`)).set(auth(w.seller.token)).send({ reply: 'Thank you!' });

    const res = await request(app).get(api(`/reviews/seller/${w.seller.id}`));
    expect(res.status).toBe(200);
    const review = res.body.data.reviews.find((r: { reviewId: string }) => r.reviewId === reviewId);
    expect(review.sellerReply).toBe('Thank you!');
  });
});
