/**
 * Agentic AI PR 1: the eBay Browse API client (docs/superpowers/plans/2026-09-28-agentic-ai-valuation.md,
 * Task 2, as re-audited 2026-11-09). It searches eBay AUCTIONS only, prices an auction by its current
 * bid (an auction listing's `price` is not its bid), keeps only USD prices (the pricing converts USD),
 * and never invents a price for a listing that has none. No network: `fetch` is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalFetch = global.fetch;
const KEYS = { GROQ_API_KEY: 'groq-test', EBAY_APP_ID: 'app-test', EBAY_CERT_ID: 'cert-test' };

beforeEach(() => {
  vi.resetModules();
  Object.assign(process.env, KEYS);
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const k of Object.keys(KEYS)) delete process.env[k];
  vi.restoreAllMocks();
});

type Reply = { ok: boolean; status?: number; json: unknown };

/** Answers the token call and each search call in turn; records every URL asked for. */
function mockFetch(search: Reply[], token: Reply = { ok: true, json: { access_token: 'tok', expires_in: 7200 } }) {
  const urls: string[] = [];
  let searches = 0;
  global.fetch = vi.fn((url: string | URL) => {
    const u = url.toString();
    urls.push(u);
    const r = u.includes('/oauth2/token') ? token : search[Math.min(searches++, search.length - 1)];
    return Promise.resolve({ ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: () => Promise.resolve(r.json) } as Response);
  }) as unknown as typeof fetch;
  return urls;
}

const load = () => import('../src/services/ai/ebay-client.js');

describe('searchAuctionListings', () => {
  it('prices an auction by its current bid, falling back to price, and keeps the bid count', async () => {
    mockFetch([{
      ok: true,
      json: {
        itemSummaries: [
          { title: 'Sony WH-1000XM4', currentBidPrice: { value: '139.99', currency: 'USD' }, price: { value: '99.00', currency: 'USD' }, bidCount: 7 },
          { title: 'Sony WH-1000XM4 Sealed', price: { value: '178.00', currency: 'USD' } },
        ],
      },
    }]);
    const { searchAuctionListings } = await load();

    expect(await searchAuctionListings('Sony WH-1000XM4')).toEqual([
      { id: 1, title: 'Sony WH-1000XM4', price: 139.99, currency: 'USD', bidCount: 7 },
      { id: 2, title: 'Sony WH-1000XM4 Sealed', price: 178, currency: 'USD', bidCount: 0 },
    ]);
  });

  it('drops a listing with no usable price or a price not in USD, instead of counting it as zero', async () => {
    mockFetch([{
      ok: true,
      json: {
        itemSummaries: [
          { title: 'No price at all' },
          { title: 'In pounds', currentBidPrice: { value: '50.00', currency: 'GBP' } },
          { title: 'Not a number', price: { value: 'n/a', currency: 'USD' } },
          { title: 'Zero', price: { value: '0', currency: 'USD' } },
          { title: 'Good', price: { value: '25.50', currency: 'USD' } },
        ],
      },
    }]);
    const { searchAuctionListings } = await load();

    expect(await searchAuctionListings('mixed')).toEqual([{ id: 1, title: 'Good', price: 25.5, currency: 'USD', bidCount: 0 }]);
  });

  it('asks eBay for auctions only, and encodes a query that would otherwise break the request', async () => {
    const urls = mockFetch([{ ok: true, json: { itemSummaries: [] } }]);
    const { searchAuctionListings } = await load();

    await searchAuctionListings('Seller\'s "rare" item & more');

    const search = urls.find((u) => u.includes('/item_summary/search'))!;
    expect(search).toContain(`q=${encodeURIComponent('Seller\'s "rare" item & more')}`);
    expect(search).toContain(`filter=${encodeURIComponent('buyingOptions:{AUCTION}')}`);
    expect(search).not.toContain('&more');
    // Enough candidates that, after keeping only auctions with bids, a comparison is still possible.
    expect(search).toContain('limit=30');
  });

  it('answers an empty list, not an error, when eBay finds nothing', async () => {
    mockFetch([{ ok: true, json: {} }]);
    const { searchAuctionListings } = await load();
    await expect(searchAuctionListings('an obscure item')).resolves.toEqual([]);
  });

  it('throws when the search itself fails, so the caller can fall back', async () => {
    mockFetch([{ ok: false, status: 503, json: { errors: [{ message: 'Service unavailable' }] } }]);
    const { searchAuctionListings } = await load();
    await expect(searchAuctionListings('anything')).rejects.toThrow(/eBay search failed: 503/);
  });

  it('throws when eBay refuses the credentials', async () => {
    mockFetch([], { ok: false, status: 401, json: { error: 'invalid_client' } });
    const { searchAuctionListings } = await load();
    await expect(searchAuctionListings('anything')).rejects.toThrow(/eBay OAuth failed: 401/);
  });

  it('reuses one OAuth token for two searches', async () => {
    const urls = mockFetch([{ ok: true, json: {} }, { ok: true, json: {} }]);
    const { searchAuctionListings } = await load();
    await searchAuctionListings('first');
    await searchAuctionListings('second');
    expect(urls.filter((u) => u.includes('/oauth2/token'))).toHaveLength(1);
  });

  it('refuses to run when the AI keys are not configured, without calling eBay', async () => {
    delete process.env.EBAY_CERT_ID;
    const urls = mockFetch([{ ok: true, json: {} }]);
    const { searchAuctionListings } = await load();
    await expect(searchAuctionListings('anything')).rejects.toThrow(/not configured/);
    expect(urls).toHaveLength(0);
  });
});
