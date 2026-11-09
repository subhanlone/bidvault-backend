/**
 * Agentic AI PR 1: the fallback source when eBay's API is unavailable, Groq's built-in
 * `browser_search` on a gpt-oss model (plan Task 3, re-audited 2026-11-09). It asks for AUCTION
 * prices, uses Groq's documented `reasoning_effort: "low"`, and keeps only well-formed USD prices
 * from what the model writes. No network: `fetch` is mocked.
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

function mockGroq(reply: { ok?: boolean; status?: number; json: unknown }) {
  const sent: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  global.fetch = vi.fn((url: string | URL, init?: RequestInit) => {
    sent.push({
      url: url.toString(),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
      auth: String((init?.headers as Record<string, string>).Authorization),
    });
    return Promise.resolve({ ok: reply.ok ?? true, status: reply.status ?? 200, json: () => Promise.resolve(reply.json) } as Response);
  }) as unknown as typeof fetch;
  return sent;
}

const content = (text: string) => ({ choices: [{ message: { content: text } }] });
const load = () => import('../src/services/ai/groq-search.js');

describe('searchAuctionListingsViaGroq', () => {
  it('asks a gpt-oss model with browser_search and low reasoning effort for auction prices', async () => {
    const sent = mockGroq({ json: content('[{"title":"Sony WH-1000XM4","price":153.26}]') });
    const { searchAuctionListingsViaGroq } = await load();

    const result = await searchAuctionListingsViaGroq('Sony WH-1000XM4');

    expect(result).toEqual([{ id: 1, title: 'Sony WH-1000XM4', price: 153.26, currency: 'USD', bidCount: null }]);
    expect(sent[0].body).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', tools: [{ type: 'browser_search' }] });
    expect(JSON.stringify(sent[0].body.messages)).toMatch(/auction/i);
    expect(sent[0].auth).toBe('Bearer groq-test');
  });

  it('reads the JSON array even with prose or code fences around it, and drops malformed entries', async () => {
    mockGroq({
      json: content('Here you go:\n```json\n[{"title":"A","price":20},{"title":"No price"},{"title":"Neg","price":-5},{"price":9},{"title":"B","price":"31.5"}]\n```'),
    });
    const { searchAuctionListingsViaGroq } = await load();

    expect(await searchAuctionListingsViaGroq('x')).toEqual([
      { id: 1, title: 'A', price: 20, currency: 'USD', bidCount: null },
      { id: 2, title: 'B', price: 31.5, currency: 'USD', bidCount: null },
    ]);
  });

  it('answers an empty list when the model gives no parseable array', async () => {
    mockGroq({ json: content('I could not find anything.') });
    const { searchAuctionListingsViaGroq } = await load();
    await expect(searchAuctionListingsViaGroq('nothing')).resolves.toEqual([]);
  });

  it('answers an empty list when the array is not valid JSON', async () => {
    mockGroq({ json: content('[{"title": "A", "price": (20+30)/2}]') });
    const { searchAuctionListingsViaGroq } = await load();
    await expect(searchAuctionListingsViaGroq('x')).resolves.toEqual([]);
  });

  it('throws on a Groq error body, and on a non-2xx answer', async () => {
    mockGroq({ json: { error: { message: 'Rate limit reached for model openai/gpt-oss-120b' } } });
    let mod = await load();
    await expect(mod.searchAuctionListingsViaGroq('x')).rejects.toThrow(/Rate limit reached/);

    vi.resetModules();
    mockGroq({ ok: false, status: 500, json: {} });
    mod = await load();
    await expect(mod.searchAuctionListingsViaGroq('x')).rejects.toThrow(/Groq browser_search failed: 500/);
  });

  it('refuses to run when the AI keys are not configured', async () => {
    delete process.env.GROQ_API_KEY;
    const sent = mockGroq({ json: content('[]') });
    const { searchAuctionListingsViaGroq } = await load();
    await expect(searchAuctionListingsViaGroq('x')).rejects.toThrow(/not configured/);
    expect(sent).toHaveLength(0);
  });
});
