import type { DefaultEventsMap, Socket } from 'socket.io';
import { prisma } from '../db/prisma.js';

/** Set once at handshake (see server.ts's `io.use`); not read anywhere yet, but typed rather
 * than left as Socket.IO's default `any` `socket.data` so a future reader doesn't get it back. */
export interface AuctionSocketData {
  userId?: string;
  role?: string;
}

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

export type AuctionSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, AuctionSocketData>;

export function registerAuctionSubscriptions(socket: AuctionSocket): void {
  const bucket: SubscriptionBucket = {};
  // Rooms whose existence lookup is in flight, and the LAST command received for each of them.
  //
  // The lookup is asynchronous, and socket.leave() on a room the socket has not joined yet does
  // nothing. Packets that arrive together run their handlers before any promise reaction (Socket.IO
  // dispatches each one in process.nextTick, and Node drains that queue before the microtasks), so
  // an unsubscribe that follows a subscribe in the same flush used to run first and the join then
  // went through anyway: the socket kept receiving a room it had asked to leave. The join therefore
  // re-checks the latest command when the lookup answers, and whatever the interleaving the last
  // command wins (subscribe, unsubscribe, subscribe, subscribe, unsubscribe, subscribe = subscribed).
  const pending = new Map<string, 'join' | 'leave'>();

  socket.on('auction:subscribe', (auctionId: unknown) => {
    if (typeof auctionId !== 'string' || !auctionId.trim() || auctionId.length > 128) return;
    if (!consumeSubscriptionToken(bucket)) {
      socket.disconnect(true);
      return;
    }

    const room = `auction:${auctionId}`;
    if (pending.has(room)) {
      // A lookup is already running for this room: only the wish changes (this also reinstates a
      // subscribe that an unsubscribe had cancelled), no second lookup is started.
      pending.set(room, 'join');
      return;
    }
    if (socket.rooms.has(room)) return;
    const joinedAuctionRooms = [...socket.rooms].filter((name) => name.startsWith('auction:')).length;
    if (joinedAuctionRooms + pending.size >= MAX_AUCTION_ROOMS) return;

    pending.set(room, 'join');
    void auctionCache
      .has(auctionId)
      .then((exists) => {
        if (exists && socket.connected && pending.get(room) === 'join') void socket.join(room);
      })
      .catch((err: unknown) => {
        console.error('[socket] auction:subscribe lookup failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => pending.delete(room));
  });

  socket.on('auction:unsubscribe', (auctionId: unknown) => {
    if (typeof auctionId !== 'string' || auctionId.length > 128) return;
    const room = `auction:${auctionId}`;
    // Only a room with a lookup in flight is recorded, so unsubscribing arbitrary names cannot grow
    // the map. A cancelled lookup keeps counting towards the room cap until it answers.
    if (pending.has(room)) pending.set(room, 'leave');
    void socket.leave(room);
  });
}
