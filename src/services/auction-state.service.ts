import { redisConnection } from '../infra/redis.js';

function keyFor(auctionId: string): string {
  return `auction:state:${auctionId}`;
}

export async function setAuctionRuntimeState(params: {
  auctionId: string;
  currentBid: number;
  bidCount: number;
}): Promise<void> {
  const key = keyFor(params.auctionId);
  await redisConnection.hset(key, {
    currentBid: String(params.currentBid),
    bidCount: String(params.bidCount),
    updatedAt: String(Date.now()),
  });
  await redisConnection.expire(key, 7 * 24 * 60 * 60);
}

export async function getAuctionRuntimeState(auctionId: string): Promise<{
  currentBid?: number;
  bidCount?: number;
}> {
  const data = await redisConnection.hgetall(keyFor(auctionId));
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
