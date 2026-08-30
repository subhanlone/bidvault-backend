import type { Socket } from 'socket.io';
import { prisma } from '../db/prisma.js';

const BUCKET_CAPACITY = 50;
const REFILL_WINDOW_MS = 60_000;
const MAX_AUCTION_ROOMS = 25;
const CACHE_TTL_MS = 30_000;
const CACHE_CAPACITY = 1_000;

export interface SubscriptionBucket {
  tokens?: number;
  refilledAt?: number;
}

/** Lazy token bucket: no interval/listener survives a disconnected socket. */
export function consumeSubscriptionToken(bucket: SubscriptionBucket, now = Date.now()): boolean {
  const refilledAt = bucket.refilledAt ?? now;
  const elapsed = Math.max(0, now - refilledAt);
  const refill = (elapsed / REFILL_WINDOW_MS) * BUCKET_CAPACITY;
  const available = Math.min(BUCKET_CAPACITY, (bucket.tokens ?? BUCKET_CAPACITY) + refill);

  bucket.refilledAt = now;
  if (available < 1) {
    bucket.tokens = available;
    return false;
  }
  bucket.tokens = available - 1;
  return true;
}

class AuctionExistenceCache {
  private readonly entries = new Map<string, { exists: boolean; expiresAt: number }>();

  async has(auctionId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.entries.get(auctionId);
    if (cached && cached.expiresAt > now) {
      this.entries.delete(auctionId);
      this.entries.set(auctionId, cached);
      return cached.exists;
    }
    if (cached) this.entries.delete(auctionId);

    const exists = Boolean(
      await prisma.auction.findUnique({ where: { id: auctionId }, select: { id: true } }),
    );
    if (this.entries.size >= CACHE_CAPACITY) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(auctionId, { exists, expiresAt: now + CACHE_TTL_MS });
    return exists;
  }
}

const auctionCache = new AuctionExistenceCache();

export function registerAuctionSubscriptions(socket: Socket): void {
  const bucket: SubscriptionBucket = {};
  const pending = new Set<string>();

  socket.on('auction:subscribe', (auctionId: unknown) => {
    if (typeof auctionId !== 'string' || !auctionId.trim() || auctionId.length > 128) return;
    if (!consumeSubscriptionToken(bucket)) {
      socket.disconnect(true);
      return;
    }

    const room = `auction:${auctionId}`;
    if (socket.rooms.has(room) || pending.has(room)) return;
    const joinedAuctionRooms = [...socket.rooms].filter((name) => name.startsWith('auction:')).length;
    if (joinedAuctionRooms + pending.size >= MAX_AUCTION_ROOMS) return;

    pending.add(room);
    void auctionCache
      .has(auctionId)
      .then((exists) => {
        if (exists && socket.connected) void socket.join(room);
      })
      .catch((err: unknown) => {
        console.error('[socket] auction:subscribe lookup failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => pending.delete(room));
  });

  socket.on('auction:unsubscribe', (auctionId: unknown) => {
    if (typeof auctionId === 'string' && auctionId.length <= 128) {
      void socket.leave(`auction:${auctionId}`);
    }
  });
}
