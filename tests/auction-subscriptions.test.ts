import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuctionSocket } from '../src/socket/auction-subscriptions.js';

const { prisma } = await import('../src/db/prisma.js');
const { registerAuctionSubscriptions } = await import('../src/socket/auction-subscriptions.js');

/**
 * `auction:subscribe` validates the auction against the database before joining the room, and
 * that lookup is asynchronous. An `auction:unsubscribe` that arrives while the lookup is in
 * flight finds no room to leave, so without remembering the latest command the join would still
 * happen afterwards and the socket would keep receiving a room it asked to leave.
 *
 * The contract these tests pin, borrowed from how Pusher and Phoenix treat the same problem:
 * whatever the interleaving, the LAST command for a room wins ("subscribe, unsubscribe,
 * subscribe, subscribe, unsubscribe, subscribe" ends up subscribed).
 *
 * Socket.IO runs the handlers of packets that arrive together in `process.nextTick` callbacks,
 * and Node drains that queue before any promise reaction, so two packets from one flush always
 * run both handlers before the lookup's `.then`. Calling the handlers back to back, without
 * awaiting in between, is therefore the faithful way to reproduce "arrived together".
 */

type Handler = (...args: unknown[]) => void;

interface Gate {
  id: string;
  resolve: (exists: boolean) => void;
  reject: (err: Error) => void;
}

function makeSocket() {
  const handlers = new Map<string, Handler>();
  const rooms = new Set<string>(['socket-id']);
  const fake = {
    connected: true,
    rooms,
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return fake;
    }),
    join: vi.fn((room: string) => { rooms.add(room); return Promise.resolve(); }),
    leave: vi.fn((room: string) => { rooms.delete(room); return Promise.resolve(); }),
    disconnect: vi.fn(() => { fake.connected = false; }),
  };
  registerAuctionSubscriptions(fake as unknown as AuctionSocket);
  return {
    fake,
    joinedRooms: () => [...rooms].filter((room) => room.startsWith('auction:')),
    subscribe: (id: string) => handlers.get('auction:subscribe')!(id),
    unsubscribe: (id: string) => handlers.get('auction:unsubscribe')!(id),
  };
}

let gates: Gate[];
let lookups: ReturnType<typeof vi.spyOn>;

/** Settle the oldest lookup that has not been answered yet, then let the handler's promise chain run. */
async function settle(exists: boolean) {
  const gate = gates.shift();
  if (!gate) throw new Error('no lookup in flight');
  gate.resolve(exists);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Existence results are cached per auction id for 30 s inside the module, so each test uses ids
// of its own.
let seq = 0;
const freshId = () => `sub-test-${++seq}`;

beforeEach(() => {
  gates = [];
  lookups = vi.spyOn(prisma.auction, 'findUnique').mockImplementation(((args: { where: { id: string } }) =>
    new Promise((resolve, reject) => {
      gates.push({
        id: args.where.id,
        resolve: (exists) => resolve(exists ? { id: args.where.id } : null),
        reject,
      });
    })) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auction:unsubscribe while an auction:subscribe lookup is in flight', () => {
  it('does not join when unsubscribe arrives together with subscribe', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    s.unsubscribe(id);
    await settle(true);

    expect(s.fake.join).not.toHaveBeenCalled();
    expect(s.joinedRooms()).toEqual([]);
  });

  it('does not join when unsubscribe arrives after a pause but before the lookup answers', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    s.unsubscribe(id);
    await settle(true);

    expect(s.joinedRooms()).toEqual([]);
  });

  it('ends up subscribed for subscribe, unsubscribe, subscribe, using a single lookup', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    s.unsubscribe(id);
    s.subscribe(id);
    await settle(true);

    expect(lookups).toHaveBeenCalledTimes(1);
    expect(s.joinedRooms()).toEqual([`auction:${id}`]);
    expect(s.fake.join).toHaveBeenCalledTimes(1);
  });

  it('ends up unsubscribed for subscribe, unsubscribe, subscribe, unsubscribe', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    s.unsubscribe(id);
    s.subscribe(id);
    s.unsubscribe(id);
    await settle(true);

    expect(s.joinedRooms()).toEqual([]);
  });

  it('respects the final command of a long chain (Pusher: sub, unsub, sub, sub, unsub, sub = sub)', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    s.unsubscribe(id);
    s.subscribe(id);
    s.subscribe(id);
    s.unsubscribe(id);
    s.subscribe(id);
    await settle(true);

    expect(lookups).toHaveBeenCalledTimes(1);
    expect(s.joinedRooms()).toEqual([`auction:${id}`]);
  });

  it('leaves normally when unsubscribe arrives after the join has settled (control)', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    await settle(true);
    expect(s.joinedRooms()).toEqual([`auction:${id}`]);

    s.unsubscribe(id);
    expect(s.joinedRooms()).toEqual([]);
  });

  it('can subscribe again after a cancelled subscribe has settled', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    s.unsubscribe(id);
    await settle(true);
    expect(s.joinedRooms()).toEqual([]);

    s.subscribe(id);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the existence result is cached now
    expect(s.joinedRooms()).toEqual([`auction:${id}`]);
  });

  it('does not join a warm-cache auction when unsubscribe arrives in the same tick', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    await settle(true); // primes the cache for this id
    s.unsubscribe(id);
    expect(s.joinedRooms()).toEqual([]);

    // The lookup now resolves from the cache within a microtask, which used to be too late.
    s.subscribe(id);
    s.unsubscribe(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.joinedRooms()).toEqual([]);
  });

  it('treats unsubscribe of a room that was never subscribed as a no-op', () => {
    const s = makeSocket();
    expect(() => s.unsubscribe(freshId())).not.toThrow();
    expect(s.fake.join).not.toHaveBeenCalled();
    expect(s.joinedRooms()).toEqual([]);
  });

  it('keeps unrelated rooms independent', async () => {
    const s = makeSocket();
    const a = freshId();
    const b = freshId();
    s.subscribe(a);
    s.subscribe(b);
    s.unsubscribe(a);
    await settle(true);
    await settle(true);

    expect(s.joinedRooms()).toEqual([`auction:${b}`]);
  });
});

describe('lookups that do not end in a join', () => {
  it('does not join an auction that does not exist, and cleans up its state', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    await settle(false);

    expect(s.joinedRooms()).toEqual([]);
  });

  it('frees the room after a failed lookup so a later subscribe works', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    s.unsubscribe(id);
    gates.shift()!.reject(new Error('database unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleError).toHaveBeenCalled();
    expect(s.joinedRooms()).toEqual([]);

    s.subscribe(id);
    await settle(true);
    expect(s.joinedRooms()).toEqual([`auction:${id}`]);
  });

  it('does not join after the socket disconnected while the lookup was in flight', async () => {
    const s = makeSocket();
    const id = freshId();
    s.subscribe(id);
    s.fake.connected = false;
    await settle(true);

    expect(s.fake.join).not.toHaveBeenCalled();
  });

  it('keeps state per socket: a pending lookup of an old socket does not affect a new one', async () => {
    const oldSocket = makeSocket();
    const id = freshId();
    oldSocket.subscribe(id);
    oldSocket.fake.connected = false; // the old connection dropped...

    const reconnected = makeSocket(); // ...and the client reconnected and subscribed again
    reconnected.subscribe(id);
    await settle(true); // old socket's lookup
    await settle(true); // new socket's lookup

    expect(oldSocket.joinedRooms()).toEqual([]);
    expect(reconnected.joinedRooms()).toEqual([`auction:${id}`]);
  });
});

describe('the 25-room cap with cancelled subscribes', () => {
  it('is not wedged by subscribes that were cancelled and have settled', async () => {
    const s = makeSocket();
    const first = Array.from({ length: 25 }, freshId);
    first.forEach((id) => s.subscribe(id));
    first.forEach((id) => s.unsubscribe(id));
    for (let i = 0; i < 25; i++) await settle(true);
    expect(s.joinedRooms()).toEqual([]);

    const second = Array.from({ length: 25 }, freshId);
    second.forEach((id) => s.subscribe(id));
    for (let i = 0; i < 25; i++) await settle(true);
    expect(s.joinedRooms()).toHaveLength(25);
  });

  it('still counts an in-flight subscribe, cancelled or not, until its lookup settles', async () => {
    const s = makeSocket();
    const ids = Array.from({ length: 25 }, freshId);
    ids.forEach((id) => s.subscribe(id));
    ids.forEach((id) => s.unsubscribe(id));

    const extra = freshId();
    s.subscribe(extra); // 25 lookups still in flight: this one is over the cap and ignored
    expect(lookups).toHaveBeenCalledTimes(25);

    for (let i = 0; i < 25; i++) await settle(true);
    expect(s.joinedRooms()).toEqual([]);
  });
});
