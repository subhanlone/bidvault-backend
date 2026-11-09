import { AiNotConfiguredError, aiKeys } from '../../config/ai.js';
import type { MarketListing } from './ebay-client.js';

/** gpt-oss models are the only ones on Groq with the built-in browser_search tool (checked 2026-11-09). */
const MODEL = 'openai/gpt-oss-120b';
/**
 * A hard ceiling: browser_search latency is genuinely unpredictable (8 s to several minutes was
 * observed), and a hung request would hold its BullMQ job forever.
 */
const TIMEOUT_MS = 150_000;

interface RawItem {
  title?: unknown;
  price?: unknown;
}

/** The model's array, without the prose or code fences it may wrap it in; null when unreadable. */
function readArray(text: string): RawItem[] | null {
  const match = /\[[\s\S]*\]/.exec(text);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    return Array.isArray(parsed) ? (parsed as RawItem[]) : null;
  } catch {
    // e.g. an unevaluated expression such as "price": (20+30)/2 -- not data.
    return null;
  }
}

/**
 * The fallback source for comparable auctions when eBay's API is unavailable: Groq's built-in
 * `browser_search` on a gpt-oss model, which reads the web like a person would.
 *
 * `reasoning_effort: "low"` is Groq's own advice for this tool: higher efforts run long browser
 * sessions and spend many times the tokens (one query went from 45 s to 8 s with it). The answer is
 * prose the model writes, so everything in it is checked: only entries with a title and a positive
 * numeric USD price are kept, and these have no bid count.
 */
export async function searchAuctionListingsViaGroq(query: string): Promise<MarketListing[]> {
  const keys = aiKeys();
  if (!keys) throw new AiNotConfiguredError();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: 'low',
        tools: [{ type: 'browser_search' }],
        messages: [
          {
            role: 'user',
            content:
              `Search the web for current eBay AUCTION prices in US dollars (the current bid of auction ` +
              `listings, not fixed-price "Buy It Now" listings) for: ${query}. ` +
              'Reply with ONLY a JSON array, no prose and no markdown, of this shape: ' +
              '[{"title": string, "price": number}], with 2 to 5 items.',
          },
        ],
      }),
      signal: controller.signal,
    });
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    // Groq can answer 200 with an error body (a rate limit, for one), as well as a non-2xx.
    if (data.error) throw new Error(`Groq browser_search failed: ${data.error.message ?? 'unknown error'}`);
    if (!res.ok) throw new Error(`Groq browser_search failed: ${res.status}`);

    const items = readArray(data.choices?.[0]?.message?.content ?? '') ?? [];
    const listings: MarketListing[] = [];
    for (const item of items) {
      const price = Number(item.price);
      if (typeof item.title !== 'string' || !item.title.trim() || !Number.isFinite(price) || price <= 0) continue;
      listings.push({ id: listings.length + 1, title: item.title.trim(), price, currency: 'USD', bidCount: 0 });
    }
    return listings;
  } finally {
    clearTimeout(timeout);
  }
}
