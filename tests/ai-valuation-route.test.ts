/**
 * Agentic AI PR 2: GET /api/v1/ai/valuations/{auctionId}, public (the panel is for everyone, guests
 * included; decided 2026-11-09). It never runs the AI itself: it answers from the stored estimate and,
 * for a live auction, asks the background job for one when there is none or it is stale (6 hours for a
 * price, so eBay's 6-hour freshness rule is met; 24 hours for "not enough data"; 1 hour to retry a
 * failure or a paused first run). The estimate is per auction, so many viewers start one run. With the
 * keys missing the feature says it is off. The internal error message never reaches the page.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resData } from './helpers/api.js';

vi.mock('../src/queues/ai-valuation.queue.js', () => ({ enqueueAiValuation: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../src/config/ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/ai.js')>();
  return { ...actual, aiKeys: vi.fn() };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { takeViolations } = await import('../src/middleware/response-contract.js');
const { seedWorld } = await import('./helpers/world.js');
const { enqueueAiValuation } = await import('../src/queues/ai-valuation.queue.js');
const { aiKeys } = await import('../src/config/ai.js');

type World = Awaited<ReturnType<typeof seedWorld>>;

interface View {
  configured: boolean;
  status: string | null;
  averagePricePkr: number | null;
  listingsUsed: number | null;
  listingsConsidered: number | null;
  source: string | null;
  computedAt: string | null;
  refreshing: boolean;
}

const app = createApp();
const api = (path: string) => `/api/v1${path}`;
const HOUR = 3_600_000;
let w: World;

const get = (auctionId: string) => request(app).get(api(`/ai/valuations/${auctionId}`));
const ago = (ms: number) => new Date(Date.now() - ms);

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  w = await seedWorld();
  vi.mocked(enqueueAiValuation).mockClear();
  vi.mocked(aiKeys).mockReturnValue({ groqApiKey: 'g', ebayAppId: 'a', ebayCertId: 'c' });
});

afterEach(() => {
  expect(takeViolations()).toEqual([]);
});

afterAll(async () => {
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('GET /ai/valuations/{auctionId}', () => {
  it('the first view of a live auction asks for an estimate and says it is queued; a guest may ask', async () => {
    const res = await get(w.liveAuctionId);
    expect(res.status).toBe(200);
    expect(resData<View>(res)).toMatchObject({ configured: true, status: 'QUEUED', averagePricePkr: null, refreshing: false });
    expect(enqueueAiValuation).toHaveBeenCalledWith(w.liveAuctionId);
    expect(await prisma.aiValuation.count({ where: { auctionId: w.liveAuctionId } })).toBe(1);
  });

  it('many views while it is queued start one run', async () => {
    await get(w.liveAuctionId);
    await get(w.liveAuctionId);
    await get(w.liveAuctionId);
    expect(enqueueAiValuation).toHaveBeenCalledTimes(1);
  });

  it('two first views at the same moment make one row', async () => {
    const results = await Promise.all([get(w.liveAuctionId), get(w.liveAuctionId)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.aiValuation.count({ where: { auctionId: w.liveAuctionId } })).toBe(1);
  });

  it('a fresh estimate is answered as it is, without a new run', async () => {
    const computedAt = ago(2 * HOUR);
    await prisma.aiValuation.create({
      data: { auctionId: w.liveAuctionId, status: 'READY', averagePricePkr: 20_457, listingsUsed: 4, listingsConsidered: 6, source: 'EBAY', computedAt, requestedAt: computedAt },
    });
    const res = await get(w.liveAuctionId);
    expect(resData<View>(res)).toEqual({
      configured: true, status: 'READY', averagePricePkr: 20_457, listingsUsed: 4, listingsConsidered: 6,
      source: 'EBAY', computedAt: computedAt.toISOString(), refreshing: false,
    });
    expect(enqueueAiValuation).not.toHaveBeenCalled();
  });

  it('an estimate older than 6 hours stays on show while a refresh is asked for', async () => {
    const computedAt = ago(7 * HOUR);
    await prisma.aiValuation.create({ data: { auctionId: w.liveAuctionId, status: 'READY', averagePricePkr: 20_457, listingsUsed: 4, computedAt, requestedAt: computedAt } });

    const res = await get(w.liveAuctionId);
    expect(resData<View>(res)).toMatchObject({ status: 'READY', averagePricePkr: 20_457, refreshing: true });
    expect(enqueueAiValuation).toHaveBeenCalledTimes(1);

    await get(w.liveAuctionId); // the refresh is already asked for
    expect(enqueueAiValuation).toHaveBeenCalledTimes(1);
  });

  it('"not enough data" is retried after a day, not every 6 hours', async () => {
    await prisma.aiValuation.create({ data: { auctionId: w.liveAuctionId, status: 'INSUFFICIENT_DATA', listingsUsed: 0, computedAt: ago(7 * HOUR), requestedAt: ago(7 * HOUR) } });
    await get(w.liveAuctionId);
    expect(enqueueAiValuation).not.toHaveBeenCalled();

    await prisma.aiValuation.update({ where: { auctionId: w.liveAuctionId }, data: { computedAt: ago(25 * HOUR), requestedAt: ago(25 * HOUR) } });
    await get(w.liveAuctionId);
    expect(enqueueAiValuation).toHaveBeenCalledTimes(1);
  });

  it('a failure or a paused first run is retried after an hour', async () => {
    await prisma.aiValuation.create({ data: { auctionId: w.liveAuctionId, status: 'PAUSED', requestedAt: ago(30 * 60_000) } });
    await get(w.liveAuctionId);
    expect(enqueueAiValuation).not.toHaveBeenCalled();

    await prisma.aiValuation.update({ where: { auctionId: w.liveAuctionId }, data: { requestedAt: ago(2 * HOUR) } });
    await get(w.liveAuctionId);
    expect(enqueueAiValuation).toHaveBeenCalledTimes(1);
  });

  it('a run stuck in QUEUED or RUNNING for over 15 minutes is asked for again', async () => {
    await prisma.aiValuation.create({ data: { auctionId: w.liveAuctionId, status: 'RUNNING', requestedAt: ago(20 * 60_000) } });
    await get(w.liveAuctionId);
    expect(enqueueAiValuation).toHaveBeenCalledTimes(1);
  });

  it('never sends the internal error message to the page', async () => {
    await prisma.aiValuation.create({
      data: { auctionId: w.liveAuctionId, status: 'FAILED', errorMessage: 'eBay OAuth failed: 401 (secret detail)', computedAt: ago(10 * 60_000), requestedAt: ago(10 * 60_000) },
    });
    const res = await get(w.liveAuctionId);
    expect(resData<View>(res).status).toBe('FAILED');
    expect(JSON.stringify(res.body)).not.toMatch(/OAuth|secret detail/);
  });

  it('an ended auction shows what it has, but starts no run', async () => {
    const none = await get(w.closedAuctionId);
    expect(resData<View>(none)).toMatchObject({ configured: true, status: null });

    await prisma.aiValuation.create({ data: { auctionId: w.closedAuctionId, status: 'READY', averagePricePkr: 9_000, listingsUsed: 3, computedAt: ago(30 * HOUR), requestedAt: ago(30 * HOUR) } });
    const old = await get(w.closedAuctionId);
    expect(resData<View>(old)).toMatchObject({ status: 'READY', averagePricePkr: 9_000, refreshing: false });
    expect(enqueueAiValuation).not.toHaveBeenCalled();
  });

  it('a removed (cancelled) auction starts no run', async () => {
    await prisma.auction.update({ where: { id: w.liveAuctionId }, data: { status: 'CANCELLED' } });
    const res = await get(w.liveAuctionId);
    expect(resData<View>(res).status).toBeNull();
    expect(enqueueAiValuation).not.toHaveBeenCalled();
  });

  it('says the feature is off when the AI keys are missing, and starts nothing', async () => {
    vi.mocked(aiKeys).mockReturnValue(null);
    const res = await get(w.liveAuctionId);
    expect(res.status).toBe(200);
    expect(resData<View>(res)).toEqual({
      configured: false, status: null, averagePricePkr: null, listingsUsed: null, listingsConsidered: null,
      source: null, computedAt: null, refreshing: false,
    });
    expect(enqueueAiValuation).not.toHaveBeenCalled();
    expect(await prisma.aiValuation.count()).toBe(0);
  });

  it('an unknown auction is a 404', async () => {
    const res = await get('no-such-auction');
    expect(res.status).toBe(404);
  });
});

describe('the USD to PKR rate (admin setting)', () => {
  const admin = () => ({ Authorization: `Bearer ${w.admin.token}` });

  it('is saved and read back', async () => {
    const res = await request(app).put(api('/settings')).set(admin()).send({ usdToPkrRate: 285.5 });
    expect(res.status).toBe(200);
    const read = await request(app).get(api('/settings')).set(admin());
    expect(resData<{ usdToPkrRate: number }>(read).usdToPkrRate).toBe(285.5);
  });

  it('refuses zero or a negative rate, which would turn every estimate into nonsense', async () => {
    for (const usdToPkrRate of [0, -1]) {
      const res = await request(app).put(api('/settings')).set(admin()).send({ usdToPkrRate });
      expect(res.status).toBe(400);
    }
  });
});
