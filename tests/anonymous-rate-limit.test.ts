/**
 * G6 (docs/superpowers/plans/2026-11-06-guest-browsing.md, decision I): since guest browsing, anyone
 * can run the expensive reads, a word search over every auction and the facet counts, without an
 * account. They get their own budget, 60 a minute per IP, shared between the two. Everything else a
 * guest does (opening an auction, the plain browse list) is only under the global limit, because a
 * mobile carrier puts many real people behind one IP.
 *
 * A signed-in person is not counted here, but only with a token that verifies: these routes are
 * public and never check a token themselves, so "has an Authorization header" alone would let anyone
 * skip the limit by sending one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

const app = createApp();
const api = (path: string) => `/api/v1${path}`;

let w: World;

/** Sends `n` requests one after another and returns their status codes. */
async function statuses(n: number, send: (i: number) => request.Test): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send(i)).status);
  return out;
}

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  w = await seedWorld();
});

afterEach(() => {
  expect(takeViolations()).toEqual([]);
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('anonymous search and facets', () => {
  it('the 61st anonymous search in a minute is a 429 with the standard body', async () => {
    const first = await statuses(60, (i) => request(app).get(api(`/auctions?search=camera${i}`)));
    expect(first.every((s) => s === 200)).toBe(true);

    const res = await request(app).get(api('/auctions?search=camera'));
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, error: 'Too many searches. Please try again shortly.' });
    expect(res.headers['ratelimit-policy']).toBeDefined();
  });

  it('facets share the same budget as the search', async () => {
    await statuses(30, (i) => request(app).get(api(`/auctions?search=lamp${i}`)));
    const facets = await statuses(31, () => request(app).get(api('/auctions/facets')));
    expect(facets.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(facets[30]).toBe(429);
  });

  it('does not limit opening auctions or the plain browse list', async () => {
    const opened = await statuses(100, () => request(app).get(api(`/auctions/${w.liveAuctionId}`)));
    const listed = await statuses(100, () => request(app).get(api('/auctions')));
    expect(opened.every((s) => s === 200)).toBe(true);
    expect(listed.every((s) => s === 200)).toBe(true);
  });

  it('an empty search is the plain list, not a search', async () => {
    const res = await statuses(70, () => request(app).get(api('/auctions?search=')));
    expect(res.every((s) => s === 200)).toBe(true);
  });

  it('a signed-in person is not counted by it', async () => {
    const res = await statuses(70, (i) =>
      request(app).get(api(`/auctions?search=desk${i}`)).set('Authorization', `Bearer ${w.buyer.token}`),
    );
    expect(res.every((s) => s === 200)).toBe(true);
  });

  it('a token that does not verify does not get around it', async () => {
    const res = await statuses(61, (i) =>
      request(app).get(api(`/auctions?search=bike${i}`)).set('Authorization', 'Bearer not.a.real.token'),
    );
    expect(res.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(res[60]).toBe(429);
  });
});
