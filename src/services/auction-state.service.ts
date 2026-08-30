import { getAuctionStateRedis } from '../infra/redis.js';

function keyFor(auctionId: string): string {
  return `auction:state:${auctionId}`;
}

/**
 * Best-effort cache of the current bid/count a live auction's GET reads use to avoid hitting
 * Postgres for every poll — never the source of truth, which is the DB row the placing
 * transaction already committed.
 *
 * hset and expire go in one pipeline (BV-010): issued separately, a process crash or a
 * rejected second command between them could leave the key with no TTL, holding it in Redis
 * forever for an auction that closed years ago. One round trip removes the gap entirely
 * rather than narrowing it.
 */
export async function setAuctionRuntimeState(params: {
  auctionId: string;
  currentBid: number;
  bidCount: number;
}): Promise<void> {
  const key = keyFor(params.auctionId);
  await getAuctionStateRedis()
    .pipeline()
    .hset(key, {
      currentBid: String(params.currentBid),
      bidCount: String(params.bidCount),
      updatedAt: String(Date.now()),
    })
    .expire(key, 7 * 24 * 60 * 60)
    .exec();
}

export async function getAuctionRuntimeState(auctionId: string): Promise<{
  currentBid?: number;
  bidCount?: number;
}> {
  const data = await getAuctionStateRedis().hgetall(keyFor(auctionId));
  if (!data || Object.keys(data).length === 0) {
    return {};
  }

  const parseRedisNum = (val: string | undefined): number | undefined => {
    if (val == null) return undefined;
    const n = Number(val);
    return Number.isNaN(n) ? undefined : n;
  };
  const currentBid = parseRedisNum(data.currentBid);
  const bidCount = parseRedisNum(data.bidCount);
  return { currentBid, bidCount };
}

/** Called once an auction closes — nothing can bid on it again, so the overlay is dead weight. */
export async function deleteAuctionRuntimeState(auctionId: string): Promise<void> {
  await getAuctionStateRedis().del(keyFor(auctionId));
}
