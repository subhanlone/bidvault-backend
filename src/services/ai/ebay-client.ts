import { AiNotConfiguredError, aiKeys, type AiKeys } from '../../config/ai.js';

/**
 * A comparable listing from either eBay or the Groq browser_search fallback (groq-search.ts). Both
 * sources normalise into this shape, so the pricing agent never needs to know which one a listing
 * came from. `id` is a local 1-based handle for one run, not eBay's item id: the agent only needs
 * a stable way to point at a listing, and nothing here is kept beyond the run (eBay's licence asks
 * for intermediate copies to be deleted once no longer needed).
 */
export interface MarketListing {
  id: number;
  title: string;
  /** In USD: the only currency the pricing converts. */
  price: number;
  currency: 'USD';
  /**
   * Bids the eBay auction has had, or null when the source cannot say (the web fallback). The
   * valuation counts only auctions with at least one bid (decided 2026-11-09): with none, the price
   * is just the seller's starting price, not what any buyer offered.
   */
  bidCount: number | null;
}

/**
 * How many auctions to ask eBay for. Many have no bid yet (6 of 10 in the first live run), and those
 * are dropped, so this leaves enough with bids for a comparison of at least three.
 */
const SEARCH_LIMIT = 30;

let cachedToken: { value: string; expiresAt: number; appId: string } | null = null;

async function getEbayToken(keys: AiKeys): Promise<string> {
  if (cachedToken && cachedToken.appId === keys.ebayAppId && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const basic = Buffer.from(`${keys.ebayAppId}:${keys.ebayCertId}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !data.access_token) {
    throw new Error(`eBay OAuth failed: ${res.status}`);
  }

  // Refreshed a minute early, so a token never expires in the middle of a run.
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + ((data.expires_in ?? 7200) - 60) * 1000,
    appId: keys.ebayAppId,
  };
  return cachedToken.value;
}

interface EbayAmount {
  value?: string;
  currency?: string;
}

interface EbayItemSummary {
  title?: string;
  /** An auction's current highest bid (eBay's ItemSummary.currentBidPrice). */
  currentBidPrice?: EbayAmount;
  price?: EbayAmount;
  bidCount?: number;
}

/** A positive USD amount, or null: a missing, non-USD or non-numeric price is never read as zero. */
function usd(amount: EbayAmount | undefined): number | null {
  if (!amount || amount.currency !== 'USD') return null;
  const n = Number(amount.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Comparable eBay AUCTION listings for a query. `buyingOptions:{AUCTION}` is not optional: eBay's
 * search returns fixed-price (Buy It Now) listings by default, which would compare BidVault's
 * auctions with shop prices. An auction is priced by its current bid; `price` only when that is
 * absent.
 *
 * Resolves to `[]` when eBay answers but finds nothing: "nothing comparable" is a result. Throws
 * when the request fails (network, non-2xx, credentials refused), which the caller takes as the
 * cue to try the fallback source.
 */
export async function searchAuctionListings(query: string): Promise<MarketListing[]> {
  const keys = aiKeys();
  if (!keys) throw new AiNotConfiguredError();

  const token = await getEbayToken(keys);
  const url =
    'https://api.ebay.com/buy/browse/v1/item_summary/search' +
    `?q=${encodeURIComponent(query)}` +
    `&filter=${encodeURIComponent('buyingOptions:{AUCTION}')}` +
    `&limit=${SEARCH_LIMIT}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  });
  const data = (await res.json()) as { itemSummaries?: EbayItemSummary[] };
  if (!res.ok) {
    throw new Error(`eBay search failed: ${res.status}`);
  }

  const listings: MarketListing[] = [];
  for (const item of data.itemSummaries ?? []) {
    const price = usd(item.currentBidPrice) ?? usd(item.price);
    if (price === null || !item.title) continue;
    listings.push({ id: listings.length + 1, title: item.title, price, currency: 'USD', bidCount: item.bidCount ?? 0 });
  }
  return listings;
}
