import { Prisma, type AiValuation } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { aiKeys } from '../../config/ai.js';
import { enqueueAiValuation } from '../../queues/ai-valuation.queue.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How old a finished outcome may be before a viewer's request asks for a new run. A price follows
 * eBay's freshness rule (displayed eBay data no more than 6 hours older than eBay's own); "not enough
 * data" rarely changes within a day; a failure or a paused first run is worth another try in an hour.
 */
const STALE_AFTER: Record<'READY' | 'INSUFFICIENT_DATA' | 'FAILED' | 'PAUSED', number> = {
  READY: 6 * HOUR,
  INSUFFICIENT_DATA: 24 * HOUR,
  FAILED: HOUR,
  PAUSED: HOUR,
};
/** A run asked for this long ago and still not finished is taken to be lost, and asked for again. */
const STUCK_AFTER = 15 * MINUTE;

export interface AiValuationView {
  configured: boolean;
  status: AiValuation['status'] | null;
  averagePricePkr: number | null;
  listingsUsed: number | null;
  listingsConsidered: number | null;
  source: string | null;
  computedAt: string | null;
  refreshing: boolean;
}

const EMPTY = { status: null, averagePricePkr: null, listingsUsed: null, listingsConsidered: null, source: null, computedAt: null, refreshing: false };

/** The page's view of a row. The internal error message is never part of it. */
function view(row: AiValuation | null, refreshing = false): AiValuationView {
  if (!row) return { configured: true, ...EMPTY };
  return {
    configured: true,
    status: row.status,
    averagePricePkr: row.averagePricePkr,
    listingsUsed: row.listingsUsed,
    listingsConsidered: row.listingsConsidered,
    source: row.source,
    computedAt: row.computedAt?.toISOString() ?? null,
    refreshing,
  };
}

/** The row, created QUEUED when there is none; two first views at once end up with the same row. */
async function findOrCreate(auctionId: string): Promise<{ row: AiValuation; created: boolean }> {
  const existing = await prisma.aiValuation.findUnique({ where: { auctionId } });
  if (existing) return { row: existing, created: false };
  try {
    return { row: await prisma.aiValuation.create({ data: { auctionId } }), created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { row: await prisma.aiValuation.findUniqueOrThrow({ where: { auctionId } }), created: false };
    }
    throw err;
  }
}

/** Marks a run as asked for now, then asks the queue for it. */
async function requestRun(auctionId: string): Promise<AiValuation> {
  const row = await prisma.aiValuation.update({ where: { auctionId }, data: { requestedAt: new Date() } });
  await enqueueAiValuation(auctionId);
  return row;
}

export type GetValuationResult = { kind: 'ok'; view: AiValuationView } | { kind: 'not-found' };

/**
 * The comparable-price estimate for an auction, as the page shows it. Never runs the AI: it answers
 * from the stored row and, for a live auction only, asks the background job for a run when there is
 * none, it is stale, or one seems lost. An ended or removed auction shows what it has and costs
 * nothing more.
 */
export async function getValuation(auctionId: string): Promise<GetValuationResult> {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId }, select: { status: true } });
  if (!auction) return { kind: 'not-found' };
  if (!aiKeys()) return { kind: 'ok', view: { configured: false, ...EMPTY } };

  if (auction.status !== 'ACTIVE') {
    return { kind: 'ok', view: view(await prisma.aiValuation.findUnique({ where: { auctionId } })) };
  }

  const { row, created } = await findOrCreate(auctionId);
  if (created) {
    await enqueueAiValuation(auctionId);
    return { kind: 'ok', view: view(row) };
  }

  const now = Date.now();
  const askedAgo = now - row.requestedAt.getTime();

  if (row.status === 'QUEUED' || row.status === 'RUNNING') {
    return { kind: 'ok', view: view(askedAgo > STUCK_AFTER ? await requestRun(auctionId) : row) };
  }

  // A finished outcome. A refresh already asked for and not yet finished is "refreshing".
  const pending = row.computedAt === null || row.requestedAt > row.computedAt;
  if (pending && askedAgo <= STUCK_AFTER) return { kind: 'ok', view: view(row, true) };

  const since = row.computedAt ?? row.requestedAt;
  if (now - since.getTime() > STALE_AFTER[row.status]) {
    return { kind: 'ok', view: view(await requestRun(auctionId), true) };
  }
  return { kind: 'ok', view: view(row) };
}
