import { prisma } from '../../db/prisma.js';
import { getPlatformSettings } from '../settings.service.js';
import { spendAiRun } from './ai-budget.js';
import { searchAuctionListings, type MarketListing } from './ebay-client.js';
import { searchAuctionListingsViaGroq } from './groq-search.js';
import { runPricingAgent } from './pricing-agent.js';

/** Fewer comparable auctions than this is not an estimate (decided 2026-11-09). */
export const MIN_COMPARABLES = 3;
/** eBay's query is the item's title, kept to a sensible length. */
const QUERY_MAX = 100;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * One valuation run for one auction, as a background job (never inside a page request).
 *
 * 1. The day's AI budget: when it is spent, a first estimate waits (PAUSED) and an existing one is
 *    left untouched, still on show with its date.
 * 2. Comparable eBay auctions; if eBay fails, the web fallback (Groq browser_search). If eBay answers
 *    with too few, that is the answer: the fallback is a weaker source, not a second opinion.
 * 3. Only auctions with at least one bid (or an unknown count, from the web): with none, the price is
 *    only the seller's ask. Fewer than MIN_COMPARABLES of them is INSUFFICIENT_DATA.
 * 4. The agent chooses the comparable ones; plain code averages them. Fewer than MIN_COMPARABLES
 *    chosen is INSUFFICIENT_DATA too.
 *
 * INSUFFICIENT_DATA is an honest result (unique items, thin categories); FAILED is a source or the
 * model breaking. A refresh keeps the previous estimate on show until it finishes. Never throws for
 * those outcomes; only a database failure escapes, for BullMQ to retry.
 */
export async function runAiValuation(auctionId: string): Promise<void> {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId }, select: { title: true } });
  if (!auction) {
    console.warn(`[ai-valuation] Auction ${auctionId} no longer exists; nothing to value.`);
    return;
  }

  const row = await prisma.aiValuation.upsert({ where: { auctionId }, update: {}, create: { auctionId } });
  const firstRun = row.computedAt === null;

  if (!(await spendAiRun())) {
    if (firstRun) await prisma.aiValuation.update({ where: { auctionId }, data: { status: 'PAUSED' } });
    return;
  }
  if (firstRun) await prisma.aiValuation.update({ where: { auctionId }, data: { status: 'RUNNING' } });

  const finish = (data: {
    status: 'READY' | 'INSUFFICIENT_DATA' | 'FAILED';
    averagePricePkr?: number | null;
    listingsUsed?: number | null;
    listingsConsidered?: number | null;
    source?: string | null;
    errorMessage?: string | null;
  }) =>
    prisma.aiValuation.update({
      where: { auctionId },
      data: {
        averagePricePkr: null,
        listingsUsed: null,
        listingsConsidered: null,
        source: null,
        errorMessage: null,
        ...data,
        computedAt: new Date(),
      },
    });

  try {
    const query = auction.title.slice(0, QUERY_MAX);
    let listings: MarketListing[];
    let source: 'EBAY' | 'WEB';
    try {
      listings = await searchAuctionListings(query);
      source = 'EBAY';
    } catch (ebayErr) {
      console.warn(`[ai-valuation] eBay failed for ${auctionId}, trying the web: ${message(ebayErr)}`);
      listings = await searchAuctionListingsViaGroq(query);
      source = 'WEB';
    }

    const withBids = listings.filter((l) => l.bidCount === null || l.bidCount >= 1);
    if (withBids.length < MIN_COMPARABLES) {
      await finish({ status: 'INSUFFICIENT_DATA', listingsUsed: 0, listingsConsidered: withBids.length, source });
      return;
    }

    const { usdToPkrRate } = await getPlatformSettings();
    const result = await runPricingAgent(auction.title, withBids, usdToPkrRate);
    if (!result || result.listingsUsed < MIN_COMPARABLES) {
      await finish({ status: 'INSUFFICIENT_DATA', listingsUsed: result?.listingsUsed ?? 0, listingsConsidered: withBids.length, source });
      return;
    }
    await finish({
      status: 'READY',
      averagePricePkr: result.averagePkr,
      listingsUsed: result.listingsUsed,
      listingsConsidered: withBids.length,
      source,
    });
  } catch (err) {
    console.error(`[ai-valuation] Run failed for ${auctionId}:`, err);
    await finish({ status: 'FAILED', errorMessage: message(err) });
  }
}
