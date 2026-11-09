/**
 * Agentic AI PR 2: the background run for one auction (services/ai/run-ai-valuation.ts) and the daily
 * budget it spends from (services/ai/ai-budget.ts).
 *
 * Decided 2026-11-09: only eBay auctions with at least one bid count (with none, the price is just a
 * seller's ask), and at least three comparable ones are needed for an estimate. Fewer is
 * INSUFFICIENT_DATA, an honest answer; FAILED is kept for a source or the model breaking. When the
 * day's budget is spent, a first estimate waits (PAUSED) and an existing one is left as it is.
 *
 * The data sources and the agent are mocked (their own tests cover them); the database and Redis are
 * real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketListing } from '../src/services/ai/ebay-client.js';

vi.mock('../src/services/ai/ebay-client.js', () => ({ searchAuctionListings: vi.fn() }));
vi.mock('../src/services/ai/groq-search.js', () => ({ searchAuctionListingsViaGroq: vi.fn() }));
vi.mock('../src/services/ai/pricing-agent.js', () => ({ runPricingAgent: vi.fn() }));

const { prisma } = await import('../src/db/prisma.js');
const { redisConnection } = await import('../src/infra/redis.js');
const { seedWorld } = await import('./helpers/world.js');
const { searchAuctionListings } = await import('../src/services/ai/ebay-client.js');
const { searchAuctionListingsViaGroq } = await import('../src/services/ai/groq-search.js');
const { runPricingAgent } = await import('../src/services/ai/pricing-agent.js');
const { runAiValuation } = await import('../src/services/ai/run-ai-valuation.js');
const { spendAiRun, resetAiBudget, AI_DAILY_RUNS } = await import('../src/services/ai/ai-budget.js');

type World = Awaited<ReturnType<typeof seedWorld>>;
let w: World;

const listing = (id: number, price: number, bidCount: number | null): MarketListing =>
  ({ id, title: `Item ${id}`, price, currency: 'USD', bidCount });

const rowOf = (auctionId: string) => prisma.aiValuation.findUnique({ where: { auctionId } });

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  w = await seedWorld();
  await resetAiBudget();
  vi.mocked(searchAuctionListings).mockReset();
  vi.mocked(searchAuctionListingsViaGroq).mockReset();
  vi.mocked(runPricingAgent).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetAiBudget();
  await prisma.$disconnect();
  redisConnection.disconnect();
});

describe('runAiValuation', () => {
  it('READY: eBay auctions with bids, the agent choosing three or more, the admin rate used', async () => {
    await prisma.platformSetting.upsert({ where: { id: 'singleton' }, update: { usdToPkrRate: 300 }, create: { id: 'singleton', usdToPkrRate: 300 } });
    const { invalidateSettingsCache } = await import('../src/services/settings.service.js');
    invalidateSettingsCache();
    vi.mocked(searchAuctionListings).mockResolvedValue([listing(1, 40, 2), listing(2, 50, 0), listing(3, 60, 5), listing(4, 70, 1)]);
    vi.mocked(runPricingAgent).mockResolvedValue({ listingsUsed: 3, averagePkr: 17_000, listingIds: [1, 3, 4] });

    await runAiValuation(w.liveAuctionId);

    // The 0-bid auction never reaches the agent.
    const [title, shown, rate] = vi.mocked(runPricingAgent).mock.calls[0];
    expect(title).toBe('Live Test Auction');
    expect(shown.map((l) => l.id)).toEqual([1, 3, 4]);
    expect(rate).toBe(300);
    const row = await rowOf(w.liveAuctionId);
    expect(row).toMatchObject({ status: 'READY', averagePricePkr: 17_000, listingsUsed: 3, listingsConsidered: 3, source: 'EBAY', errorMessage: null });
    expect(row?.computedAt).not.toBeNull();
  });

  it('INSUFFICIENT_DATA without asking the agent when fewer than three auctions have bids', async () => {
    vi.mocked(searchAuctionListings).mockResolvedValue([listing(1, 40, 3), listing(2, 50, 0), listing(3, 60, 1), listing(4, 70, 0)]);

    await runAiValuation(w.liveAuctionId);

    expect(runPricingAgent).not.toHaveBeenCalled();
    expect(await rowOf(w.liveAuctionId)).toMatchObject({ status: 'INSUFFICIENT_DATA', averagePricePkr: null, listingsConsidered: 2, source: 'EBAY' });
  });

  it('INSUFFICIENT_DATA when the agent finds fewer than three comparable, or none', async () => {
    vi.mocked(searchAuctionListings).mockResolvedValue([listing(1, 40, 1), listing(2, 50, 1), listing(3, 60, 1)]);
    vi.mocked(runPricingAgent).mockResolvedValueOnce({ listingsUsed: 2, averagePkr: 12_600, listingIds: [1, 2] });
    await runAiValuation(w.liveAuctionId);
    expect(await rowOf(w.liveAuctionId)).toMatchObject({ status: 'INSUFFICIENT_DATA', averagePricePkr: null, listingsUsed: 2 });

    vi.mocked(runPricingAgent).mockResolvedValueOnce(null);
    await runAiValuation(w.liveAuctionId);
    expect(await rowOf(w.liveAuctionId)).toMatchObject({ status: 'INSUFFICIENT_DATA', listingsUsed: 0 });
  });

  it('falls back to the web search when eBay fails, keeping its unknown bid counts', async () => {
    vi.mocked(searchAuctionListings).mockRejectedValue(new Error('eBay search failed: 503'));
    vi.mocked(searchAuctionListingsViaGroq).mockResolvedValue([listing(1, 40, null), listing(2, 50, null), listing(3, 60, null)]);
    vi.mocked(runPricingAgent).mockResolvedValue({ listingsUsed: 3, averagePkr: 14_000, listingIds: [1, 2, 3] });

    await runAiValuation(w.liveAuctionId);

    expect(await rowOf(w.liveAuctionId)).toMatchObject({ status: 'READY', source: 'WEB', listingsConsidered: 3 });
  });

  it('does not use the web search when eBay answers with too few: eBay is the better source', async () => {
    vi.mocked(searchAuctionListings).mockResolvedValue([]);
    await runAiValuation(w.liveAuctionId);
    expect(searchAuctionListingsViaGroq).not.toHaveBeenCalled();
    expect((await rowOf(w.liveAuctionId))?.status).toBe('INSUFFICIENT_DATA');
  });

  it('FAILED, not INSUFFICIENT_DATA, when both sources fail or the agent breaks', async () => {
    vi.mocked(searchAuctionListings).mockRejectedValue(new Error('eBay OAuth failed: 401'));
    vi.mocked(searchAuctionListingsViaGroq).mockRejectedValue(new Error('Groq browser_search failed: 500'));
    await runAiValuation(w.liveAuctionId);
    const failed = await rowOf(w.liveAuctionId);
    expect(failed).toMatchObject({ status: 'FAILED', averagePricePkr: null });
    expect(failed?.errorMessage).toMatch(/Groq browser_search failed: 500/);

    vi.mocked(searchAuctionListings).mockResolvedValue([listing(1, 40, 1), listing(2, 50, 1), listing(3, 60, 1)]);
    vi.mocked(runPricingAgent).mockRejectedValue(new Error('Invalid API key'));
    await runAiValuation(w.liveAuctionId);
    expect(await rowOf(w.liveAuctionId)).toMatchObject({ status: 'FAILED', errorMessage: 'Invalid API key' });
  });

  it('a refresh keeps the previous estimate on show while it runs, then replaces it', async () => {
    await prisma.aiValuation.create({
      data: { auctionId: w.liveAuctionId, status: 'READY', averagePricePkr: 10_000, listingsUsed: 3, listingsConsidered: 4, source: 'EBAY', computedAt: new Date(Date.now() - 7 * 3_600_000) },
    });
    let statusDuringRun: string | undefined;
    vi.mocked(searchAuctionListings).mockImplementation(async () => {
      statusDuringRun = (await rowOf(w.liveAuctionId))?.status;
      return [listing(1, 40, 1), listing(2, 50, 1), listing(3, 60, 1)];
    });
    vi.mocked(runPricingAgent).mockResolvedValue({ listingsUsed: 3, averagePkr: 14_000, listingIds: [1, 2, 3] });

    await runAiValuation(w.liveAuctionId);

    expect(statusDuringRun).toBe('READY');
    expect(await rowOf(w.liveAuctionId)).toMatchObject({ status: 'READY', averagePricePkr: 14_000 });
  });

  it('a first run shows RUNNING while it works', async () => {
    let statusDuringRun: string | undefined;
    vi.mocked(searchAuctionListings).mockImplementation(async () => {
      statusDuringRun = (await rowOf(w.liveAuctionId))?.status;
      return [];
    });
    await runAiValuation(w.liveAuctionId);
    expect(statusDuringRun).toBe('RUNNING');
  });

  it('when the day\'s budget is spent: a first estimate is PAUSED and nothing is asked of eBay or Groq', async () => {
    for (let i = 0; i < AI_DAILY_RUNS; i++) await spendAiRun();

    await runAiValuation(w.liveAuctionId);

    expect(searchAuctionListings).not.toHaveBeenCalled();
    expect((await rowOf(w.liveAuctionId))?.status).toBe('PAUSED');
  });

  it('when the day\'s budget is spent: an existing estimate is left exactly as it was', async () => {
    const computedAt = new Date(Date.now() - 8 * 3_600_000);
    await prisma.aiValuation.create({ data: { auctionId: w.liveAuctionId, status: 'READY', averagePricePkr: 10_000, listingsUsed: 3, computedAt } });
    for (let i = 0; i < AI_DAILY_RUNS; i++) await spendAiRun();

    await runAiValuation(w.liveAuctionId);

    expect(await rowOf(w.liveAuctionId)).toMatchObject({ status: 'READY', averagePricePkr: 10_000, computedAt });
  });

  it('an auction that no longer exists is skipped quietly', async () => {
    await expect(runAiValuation('no-such-auction')).resolves.toBeUndefined();
    expect(searchAuctionListings).not.toHaveBeenCalled();
  });
});

describe('the daily budget', () => {
  it('allows AI_DAILY_RUNS runs a day and refuses the next', async () => {
    const results: boolean[] = [];
    for (let i = 0; i <= AI_DAILY_RUNS; i++) results.push(await spendAiRun());
    expect(results.filter(Boolean)).toHaveLength(AI_DAILY_RUNS);
    expect(results[AI_DAILY_RUNS]).toBe(false);
  });
});
