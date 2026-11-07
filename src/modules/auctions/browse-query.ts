import type { AuctionStatus, ItemCondition, Prisma } from '@prisma/client';
import type { z } from 'zod';
import { escapeLike } from '../../utils/escape-like.js';
import { BROWSE_SORTS, browseQuerySchema } from '../../openapi/requests.js';

/**
 * How GET /auctions (and GET /auctions/facets) read their query string: which auctions match,
 * in what order, and where a page ends.
 *
 * The three filters the list always had (`status`, `category`, `search`) stay forgiving: an
 * unknown status means ACTIVE, and a damaged cursor means the first page, so a stale link lands
 * on a list. The parameters added with guest browsing (`sort`, `minPrice`, `maxPrice`,
 * `condition`, `withBids`, `sellerId`) are strict, because nothing depends on their being forgiven.
 */

export type BrowseSort = (typeof BROWSE_SORTS)[number];

export const DEFAULT_SORT: BrowseSort = 'ending-soonest';

export interface BrowseParams {
  status: AuctionStatus;
  category: string | undefined;
  search: string | undefined;
  sort: BrowseSort;
  minPrice: number | undefined;
  maxPrice: number | undefined;
  conditions: ItemCondition[];
  withBids: boolean;
  sellerId: string | undefined;
}

export type BrowseParse =
  | { ok: true; params: BrowseParams }
  | { ok: false; details: Record<string, string[]> };

const STATUSES: readonly string[] = ['ACTIVE', 'CLOSED', 'CANCELLED'];

const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value.trim() || undefined : undefined);

/** Reads the query string. Anything not shaped right is reported by field, as a body would be. */
export function parseBrowseQuery(query: Record<string, unknown>): BrowseParse {
  const strict = browseQuerySchema.safeParse(query);
  if (!strict.success) {
    return { ok: false, details: flatten(strict.error) };
  }
  const { sort, minPrice, maxPrice, condition, withBids, sellerId } = strict.data;
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    return { ok: false, details: { minPrice: ['The lowest price cannot be above the highest price.'] } };
  }

  const status = asText(query.status);
  return {
    ok: true,
    params: {
      // BV-029: an unfiltered call used to return every auction ever created, closed ones
      // included, which is the unbounded read that finding is about, so ACTIVE is the default.
      status: (status && STATUSES.includes(status) ? status : 'ACTIVE') as AuctionStatus,
      category: asText(query.category),
      search: asText(query.search),
      sort: sort ?? DEFAULT_SORT,
      minPrice,
      maxPrice,
      conditions: condition === undefined ? [] : Array.isArray(condition) ? condition : [condition],
      withBids: withBids === 'true',
      sellerId,
    },
  };
}

function flatten(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? 'query');
    (details[field] ??= []).push(issue.message);
  }
  return details;
}

/** A listing's item number: BV, the year, ten hexadecimal digits. Generated in upper case. */
const ITEM_NUMBER = /^BV-\d{4}-[0-9A-F]{10}$/i;

/** The groups of filters a facet count leaves out when it counts its own group. */
export type FacetGroup = 'category' | 'condition' | 'price' | 'withBids';

/**
 * The auctions a request selects, without a page. `leaveOut` drops one group of filters, which
 * is how a facet counts: a category's count ignores the category filter and honours the rest.
 */
export function buildFilters(params: BrowseParams, leaveOut?: FacetGroup): Prisma.AuctionWhereInput {
  const all: Prisma.AuctionWhereInput[] = [{ status: params.status }];

  if (params.sellerId) all.push({ sellerId: params.sellerId });

  if (params.category && leaveOut !== 'category') {
    all.push({ category: { contains: escapeLike(params.category), mode: 'insensitive' } });
  }

  if (params.search) {
    if (ITEM_NUMBER.test(params.search)) {
      // An item number names one auction. It is matched exactly and in any case, and not as
      // words: another listing that merely mentions the number in its text is not that item, and
      // the words would force a scan of every auction where the unique index answers this at once.
      // Upper case, because that is how the codes are generated.
      all.push({ listing: { listingCode: params.search.toUpperCase() } });
    } else {
      const term = escapeLike(params.search);
      all.push({
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
        ],
      });
    }
  }

  if (leaveOut !== 'price' && (params.minPrice !== undefined || params.maxPrice !== undefined)) {
    all.push({ currentBid: { gte: params.minPrice, lte: params.maxPrice } });
  }
  if (params.conditions.length > 0 && leaveOut !== 'condition') {
    all.push({ condition: { in: params.conditions } });
  }
  if (leaveOut !== 'withBids' && (params.withBids || params.sort === 'ending-soonest-with-bids')) {
    all.push({ bidCount: { gt: 0 } });
  }

  return { AND: all };
}

type SortField = 'endTime' | 'createdAt' | 'currentBid' | 'bidCount';

interface SortSpec {
  field: SortField;
  dir: 'asc' | 'desc';
  /** `date` fields are carried in a cursor as an ISO instant, `count` fields as a whole number. */
  kind: 'date' | 'count';
}

const SORTS: Record<BrowseSort, SortSpec> = {
  'ending-soonest': { field: 'endTime', dir: 'asc', kind: 'date' },
  'ending-soonest-with-bids': { field: 'endTime', dir: 'asc', kind: 'date' },
  'newly-listed': { field: 'createdAt', dir: 'desc', kind: 'date' },
  'price-asc': { field: 'currentBid', dir: 'asc', kind: 'count' },
  'price-desc': { field: 'currentBid', dir: 'desc', kind: 'count' },
  'bids-asc': { field: 'bidCount', dir: 'asc', kind: 'count' },
  'bids-desc': { field: 'bidCount', dir: 'desc', kind: 'count' },
};

interface Cursor {
  sort: BrowseSort;
  sortValue: string;
  id: string;
}

export type CursorRead =
  | { kind: 'first-page' }
  | { kind: 'wrong-sort' }
  | { kind: 'at'; cursor: Cursor };

const isSort = (value: unknown): value is BrowseSort =>
  typeof value === 'string' && (BROWSE_SORTS as readonly string[]).includes(value);

/**
 * Reads a cursor made for `sort`. A cursor with no `sort` is one the list issued before it could
 * sort: it was made under the default order. A damaged cursor is the first page, as it always
 * was; a sound one made under another sort is reported, because its value means something else
 * here (a bid count read as a date would skip or repeat rows without a sign of it).
 */
export function readCursor(raw: unknown, sort: BrowseSort): CursorRead {
  if (typeof raw !== 'string' || !raw) return { kind: 'first-page' };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { kind: 'first-page' };
  }
  if (!decoded || typeof decoded !== 'object') return { kind: 'first-page' };
  const { sort: madeUnder = DEFAULT_SORT, sortValue, id } = decoded as Record<string, unknown>;
  if (!isSort(madeUnder) || typeof sortValue !== 'string' || typeof id !== 'string') return { kind: 'first-page' };

  const spec = SORTS[madeUnder];
  const sound = spec.kind === 'date' ? Number.isFinite(Date.parse(sortValue)) : /^\d{1,10}$/.test(sortValue);
  if (!sound) return { kind: 'first-page' };
  if (madeUnder !== sort) return { kind: 'wrong-sort' };
  return { kind: 'at', cursor: { sort: madeUnder, sortValue, id } };
}

type Row = { id: string } & Record<SortField, Date | number>;

export interface BrowseQuery {
  where: Prisma.AuctionWhereInput;
  orderBy: Prisma.AuctionOrderByWithRelationInput[];
  /** The cursor that continues after `row`. The default order keeps its original two-field shape. */
  cursorFor(row: Row): string;
}

/** The filters, the page boundary and the order for one request. Every order ends on `id`. */
export function buildBrowseQuery(params: BrowseParams, at?: Cursor): BrowseQuery {
  const spec = SORTS[params.sort];
  const filters = buildFilters(params);

  let where = filters;
  if (at) {
    const beyond = spec.dir === 'asc' ? 'gt' : 'lt';
    const value = spec.kind === 'date' ? new Date(at.sortValue) : Number(at.sortValue);
    where = {
      AND: [
        filters,
        { OR: [{ [spec.field]: { [beyond]: value } }, { [spec.field]: value, id: { [beyond]: at.id } }] },
      ],
    };
  }

  return {
    where,
    orderBy: [{ [spec.field]: spec.dir }, { id: spec.dir }],
    cursorFor(row) {
      const raw = row[spec.field];
      const sortValue = raw instanceof Date ? raw.toISOString() : String(raw);
      const payload = params.sort === DEFAULT_SORT ? { sortValue, id: row.id } : { sort: params.sort, sortValue, id: row.id };
      return Buffer.from(JSON.stringify(payload)).toString('base64url');
    },
  };
}
